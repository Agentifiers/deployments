import { describe, expect, test } from "bun:test";
import {
  oauthClientRecord,
  refreshRecords,
  withCanonicalRecordKeys,
  type IdentityRecord,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { IdentityError, sha256 } from "@deployments-ai/identity";
import { makeOAuthApplication } from "./oauth-application.ts";
import {
  CREATED_AT,
  NOW,
  browserSession,
  identityApplication,
  memoryIdentityStore,
  principalSeed,
  sequentialIds,
} from "./session-management.fixture.ts";

const PRINCIPAL_A = "01ARZ3NDEKTSV4RRFFQ69G5FA0" as Ulid;
const PRINCIPAL_B = "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid;
const CURRENT = "01ARZ3NDEKTSV4RRFFQ69G5FA1" as Ulid;
const OTHER = "01ARZ3NDEKTSV4RRFFQ69G5FA2" as Ulid;
const STALE_EPOCH = "01ARZ3NDEKTSV4RRFFQ69G5FA3" as Ulid;
const IDLED_OUT = "01ARZ3NDEKTSV4RRFFQ69G5FA4" as Ulid;
const REVOKED = "01ARZ3NDEKTSV4RRFFQ69G5FA5" as Ulid;
const FOREIGN = "01ARZ3NDEKTSV4RRFFQ69G5FB1" as Ulid;
const FAMILY_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC0" as Ulid;
const TOKEN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC1" as Ulid;

function revokedSession(record: IdentityRecord<"identity-session">) {
  return withCanonicalRecordKeys({
    ...record,
    data: { ...record.data, revokedAt: CREATED_AT, status: "revoked" as const, version: 2 },
  });
}

function scenario() {
  const current = browserSession({
    createdAt: "2026-07-28T00:10:00.000Z",
    id: CURRENT,
    principalId: PRINCIPAL_A,
    rawToken: "token-current",
    sessionEpoch: 1,
  });
  const other = browserSession({
    createdAt: "2026-07-28T00:20:00.000Z",
    id: OTHER,
    principalId: PRINCIPAL_A,
    rawToken: "token-other",
    sessionEpoch: 1,
  });
  const staleEpoch = browserSession({
    createdAt: "2026-07-28T00:30:00.000Z",
    id: STALE_EPOCH,
    principalId: PRINCIPAL_A,
    rawToken: "token-stale-epoch",
    sessionEpoch: 0,
  });
  const idledOut = browserSession({
    createdAt: "2026-07-28T00:05:00.000Z",
    id: IDLED_OUT,
    idleExpiresAt: "2026-07-28T00:50:00.000Z",
    principalId: PRINCIPAL_A,
    rawToken: "token-idled-out",
    sessionEpoch: 1,
  });
  const revoked = browserSession({
    createdAt: "2026-07-28T00:15:00.000Z",
    id: REVOKED,
    principalId: PRINCIPAL_A,
    rawToken: "token-revoked",
    sessionEpoch: 1,
  });
  const foreign = browserSession({
    createdAt: "2026-07-28T00:40:00.000Z",
    id: FOREIGN,
    principalId: PRINCIPAL_B,
    rawToken: "token-foreign",
  });
  const store = memoryIdentityStore([
    ...principalSeed(PRINCIPAL_A, 1),
    ...principalSeed(PRINCIPAL_B),
    ...[current, other, staleEpoch, idledOut, foreign].flatMap(({ locator, session }) => [
      locator,
      session,
    ]),
    revokedSession(revoked.session) as PlatformRecord,
  ]);
  const generateId = sequentialIds();
  const identity = identityApplication(store.repository, generateId);
  return { generateId, identity, other, store };
}

/** A web BFF refresh family bound to OTHER, and an OAuth application that rotates it. */
async function webRefresh(
  store: ReturnType<typeof scenario>["store"],
  generateId: ReturnType<typeof scenario>["generateId"],
  now = NOW,
) {
  const seeded = refreshRecords({
    audience: "https://api.deployments.ai",
    authenticationTime: CREATED_AT,
    browserSessionId: OTHER,
    clientId: "deployments-web",
    createdAt: CREATED_AT,
    expiresAt: "2026-08-27T00:00:00.000Z",
    familyId: FAMILY_ID,
    principalId: PRINCIPAL_A,
    scopes: ["openid", "offline_access"],
    sessionEpoch: 1,
    tokenHash: sha256("refresh-secret"),
    tokenId: TOKEN_ID,
  });
  const client = oauthClientRecord({
    allowedScopes: ["openid", "offline_access"],
    clientId: "deployments-web",
    clientSecretHash: sha256("client-secret"),
    createdAt: CREATED_AT,
    grantTypes: ["authorization_code", "refresh_token"],
    name: "Deployments Web",
    redirectUris: ["https://app.deployments.ai/callback"],
    requiredScopes: ["openid"],
    tokenEndpointAuthMethod: "client_secret_basic",
    type: "confidential",
    version: 1,
  });
  await store.repository.transact(
    [seeded.family, seeded.token, client].map((record) => ({ kind: "put" as const, record })),
  );
  const oauth = makeOAuthApplication(
    {
      encryptEmailPayload: async () => {
        throw new Error("Unexpected email encryption.");
      },
      generateId,
      now: () => new Date(now),
      repository: store.repository,
      signer: { jwks: async () => ({ keys: [] }), sign: async () => "signed" },
    },
    {
      accessTokenSeconds: 300,
      authorizationCodeSeconds: 60,
      authorizationRequestSeconds: 300,
      idTokenSeconds: 300,
      issuer: "https://auth.deployments.ai",
      refreshTokenSeconds: 2_592_000,
      resourceAudience: "https://api.deployments.ai",
    },
  );
  return () =>
    oauth.exchangeRefreshToken({
      clientId: "deployments-web",
      clientSecret: "client-secret",
      refreshToken: "refresh-secret",
    });
}

describe("browser session listing", () => {
  test("shows only the caller's active, current-epoch, unexpired sessions", async () => {
    const { identity } = scenario();

    const page = await identity.listSessions("token-current");

    expect(page).toEqual({
      items: [
        {
          authenticationTime: "2026-07-28T00:20:00.000Z",
          createdAt: "2026-07-28T00:20:00.000Z",
          current: false,
          expiresAt: "2026-08-27T00:00:00.000Z",
          id: OTHER,
          idleExpiresAt: "2026-07-29T00:00:00.000Z",
          lastRefreshedAt: "2026-07-28T00:20:00.000Z",
        },
        {
          authenticationTime: "2026-07-28T00:10:00.000Z",
          createdAt: "2026-07-28T00:10:00.000Z",
          current: true,
          expiresAt: "2026-08-27T00:00:00.000Z",
          id: CURRENT,
          idleExpiresAt: "2026-07-29T00:00:00.000Z",
          lastRefreshedAt: "2026-07-28T00:10:00.000Z",
        },
      ],
    });
    const foreignView = await identity.listSessions("token-foreign");
    expect(foreignView?.items.map((item) => [item.id, item.current])).toEqual([[FOREIGN, true]]);
  });

  test("pages with an opaque keyset cursor that never carries storage keys", async () => {
    const { identity } = scenario();
    const seen: string[] = [];
    const cursors: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await identity.listSessions("token-current", {
        ...(cursor ? { cursor } : {}),
        limit: 1,
      });
      seen.push(...page!.items.map((item) => item.id));
      cursor = page!.nextCursor;
      if (cursor) cursors.push(cursor);
    } while (cursor);

    expect(seen).toEqual([OTHER, CURRENT]);
    for (const value of cursors) {
      const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
      expect(Object.keys(decoded).sort()).toEqual(["createdAt", "id"]);
      expect(value).not.toContain(sha256("token-current"));
    }
  });

  test("rejects malformed cursors and limits, and unauthenticated callers", async () => {
    const { identity } = scenario();
    const valid = Buffer.from(
      JSON.stringify({ createdAt: "2026-07-28T00:20:00.000Z", id: OTHER }),
    ).toString("base64url");
    const invalid = [
      "not base64!",
      Buffer.from("{}").toString("base64url"),
      Buffer.from(JSON.stringify({ createdAt: "2026-07-28", id: OTHER })).toString("base64url"),
      Buffer.from(
        JSON.stringify({ createdAt: "2026-07-28T00:20:00.000Z", id: OTHER, pk: "x" }),
      ).toString("base64url"),
      `${valid}=`,
    ];
    for (const cursor of invalid) {
      const error = await identity.listSessions("token-current", { cursor }).catch((e) => e);
      expect(error).toBeInstanceOf(IdentityError);
      expect(error).toMatchObject({ code: "invalid_request", status: 400 });
    }
    for (const limit of [0, 101, 1.5]) {
      expect(identity.listSessions("token-current", { limit })).rejects.toMatchObject({
        code: "invalid_request",
        status: 400,
      });
    }
    expect(await identity.listSessions("token-current", { cursor: valid })).toMatchObject({
      items: [{ id: CURRENT }],
    });
    expect(await identity.listSessions("unknown-token")).toBeUndefined();
    expect(await identity.listSessions("token-stale-epoch")).toBeUndefined();
  });
});

describe("browser session revocation by id", () => {
  test("ends the selected session and its locator so later use fails", async () => {
    const { identity, other, store } = scenario();
    expect(await identity.session("token-other")).toBeDefined();

    expect(await identity.revokeSession("token-current", OTHER)).toEqual({
      current: false,
      outcome: "revoked",
    });

    expect(await identity.session("token-other")).toBeUndefined();
    const storedSession = store.get("identity", other.session.pk, other.session.sk);
    expect(storedSession).toMatchObject({
      data: { revokedAt: NOW, status: "revoked", version: 2 },
    });
    expect(storedSession?.gsi1sk).toStartWith("IDENTITY-SESSION#revoked#");
    expect(store.get("identity", other.locator.pk, other.locator.sk)).toMatchObject({
      data: { status: "revoked", version: 2 },
    });
    expect((await identity.listSessions("token-current"))?.items.map((item) => item.id)).toEqual([
      CURRENT,
    ]);
    // Repeating the revoke is an idempotent success.
    expect(await identity.revokeSession("token-current", OTHER)).toEqual({
      current: false,
      outcome: "revoked",
    });
  });

  test("cannot reach another principal's session", async () => {
    const { identity } = scenario();

    expect(await identity.revokeSession("token-current", FOREIGN)).toEqual({
      outcome: "not_found",
    });
    expect(await identity.revokeSession("token-current", "01ARZ3NDEKTSV4RRFFQ69G5FZZ")).toEqual({
      outcome: "not_found",
    });
    expect(await identity.session("token-foreign")).toMatchObject({ sessionId: FOREIGN });
    expect(identity.revokeSession("token-current", "not-a-ulid")).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
    });
    expect(await identity.revokeSession("unknown-token", OTHER)).toBeUndefined();
  });

  test("allows revoking the caller's own current session", async () => {
    const { identity } = scenario();

    expect(await identity.revokeSession("token-current", CURRENT)).toEqual({
      current: true,
      outcome: "revoked",
    });
    expect(await identity.session("token-current")).toBeUndefined();
  });

  test("fences refresh for a web BFF family bound to the revoked browser session", async () => {
    const { generateId, identity, store } = scenario();
    const refresh = await webRefresh(store, generateId);
    await identity.revokeSession("token-current", OTHER);

    const refused = await refresh().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(IdentityError);
    expect(refused).toMatchObject({
      code: "invalid_grant",
      message: "Refresh token is no longer active.",
    });
  });

  test("a refresh bound to a browser session marks that session last active", async () => {
    const { generateId, identity, store } = scenario();
    const refreshedAt = "2026-07-28T00:50:00.000Z";
    const refresh = await webRefresh(store, generateId, refreshedAt);

    await refresh();

    const page = await identity.listSessions("token-current");
    expect(page?.items.map((item) => [item.id, item.lastRefreshedAt])).toEqual([
      [OTHER, refreshedAt],
      [CURRENT, "2026-07-28T00:10:00.000Z"],
    ]);
  });
});
