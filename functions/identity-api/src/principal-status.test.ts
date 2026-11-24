import { describe, expect, test } from "bun:test";
import {
  bffFenceRecord,
  makeDynamoDatabase,
  makeIdentityRepository,
  makePrincipalStatusCommandHandler,
  makePrincipalStatusRepository,
  makeUniqueClaimRecord,
  oauthClientRecord,
  principalRecord,
  refreshRecords,
  securityStateRecord,
  tableForItemType,
  tableNamesFromEnvironment,
  uniqueClaimRequirements,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { IdentityError, sha256 } from "@deployments-ai/identity";
import { makeOAuthApplication } from "./oauth-application.ts";

const PERSON = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const ADMINISTRATOR = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const createdAt = "2026-07-28T00:00:00.000Z";

function signedInPerson() {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  const { family, token } = refreshRecords({
    audience: "https://api.deployments.ai",
    authenticationTime: createdAt,
    clientId: "deployments-cli",
    createdAt,
    expiresAt: "2026-08-28T00:00:00.000Z",
    familyId: "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid,
    principalId: PERSON,
    scopes: ["offline_access", "openid"],
    sessionEpoch: 0,
    tokenHash: sha256("refresh-secret"),
    tokenId: "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid,
  });
  for (const record of [
    family,
    token,
    principalRecord({ createdAt, id: PERSON, primaryEmail: "person@example.com" }),
    securityStateRecord({
      createdAt,
      credentialVersion: 1,
      emailVerifiedAt: createdAt,
      principalId: PERSON,
      sessionEpoch: 0,
      version: 1,
    }),
    bffFenceRecord({
      createdAt,
      principalId: PERSON,
      principalStatus: "active",
      sessionEpoch: 0,
      version: 1,
    }),
    oauthClientRecord({
      allowedScopes: ["offline_access", "openid"],
      clientId: "deployments-cli",
      createdAt,
      grantTypes: ["authorization_code", "refresh_token"],
      name: "Deployments CLI",
      redirectUris: ["http://127.0.0.1/callback"],
      requiredScopes: [],
      tokenEndpointAuthMethod: "none",
      type: "public",
      version: 1,
    }),
  ] as PlatformRecord[]) {
    fake.put(tableForItemType(record.itemType), record);
    for (const requirement of uniqueClaimRequirements(record)) {
      fake.put(tables.control, makeUniqueClaimRecord(requirement, createdAt));
    }
  }
  const database = makeDynamoDatabase(fake.client, tables);
  let sequence = 0;
  const generateId = () => {
    sequence += 1;
    return `01ARZ3NDEKTSV4RRFFQ69G6${CROCKFORD[Math.floor(sequence / 32) % 32]}${CROCKFORD[sequence % 32]}0` as Ulid;
  };
  const oauth = makeOAuthApplication(
    {
      encryptEmailPayload: async () => {
        throw new Error("Refreshing sends no email.");
      },
      generateId,
      now: () => new Date("2026-07-28T01:00:00.000Z"),
      repository: makeIdentityRepository(database),
      signer: { jwks: async () => ({ keys: [] }), sign: async (claims) => JSON.stringify(claims) },
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
  const principalStatus = makePrincipalStatusCommandHandler(
    makePrincipalStatusRepository({
      database,
      generateId,
      now: () => new Date("2026-07-28T02:00:00.000Z"),
    }),
  );
  const refresh = (refreshToken: string) =>
    oauth.exchangeRefreshToken({ clientId: "deployments-cli", refreshToken }).then(
      (tokens) => ({ claims: JSON.parse(tokens.access_token), refreshToken: tokens.refresh_token }),
      (cause: unknown) => ({
        refused: cause instanceof IdentityError ? cause.message : String(cause),
      }),
    );
  const command = (principalId: Ulid, status: "active" | "disabled", reason: string) =>
    principalStatus(
      JSON.parse(JSON.stringify({ actorPrincipalId: ADMINISTRATOR, principalId, reason, status })),
    );
  return { command, refresh };
}

describe("principal status function", () => {
  test("a refresh token minted before a disable stays dead after the person is re-enabled", async () => {
    const { command, refresh } = signedInPerson();

    const before = await refresh("refresh-secret");
    if (!("refreshToken" in before)) throw new Error(`refresh refused: ${before.refused}`);
    const changes = [
      await command(PERSON, "disabled", "Payment fraud"),
      await command(PERSON, "active", "Appeal upheld"),
    ];

    expect(before.claims.email_verified).toBe(true);
    expect(changes).toEqual([
      {
        kind: "set",
        outcome: {
          changed: true,
          principalId: PERSON,
          status: "disabled",
          updatedAt: "2026-07-28T02:00:00.000Z",
        },
      },
      {
        kind: "set",
        outcome: {
          changed: true,
          principalId: PERSON,
          status: "active",
          updatedAt: "2026-07-28T02:00:00.000Z",
        },
      },
    ]);
    expect(await refresh(before.refreshToken)).toEqual({
      refused: "Refresh token is no longer active.",
    });
  });

  test("answers a refusal as data so the API can return it", async () => {
    const { command } = signedInPerson();

    expect(await command(ADMINISTRATOR, "disabled", "Oops")).toEqual({
      kind: "refused",
      refusal: {
        code: "cannot_disable_self",
        kind: "forbidden",
        message: "A platform administrator cannot disable their own principal.",
      },
    });
  });
});
