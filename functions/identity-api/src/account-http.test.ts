import { describe, expect, test } from "bun:test";
import { bffFenceRecord, refreshRecords, type Ulid } from "@deployments-ai/db";
import { createLocalPlatformJwtVerifier } from "@deployments-ai/identity/platform-jwt";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { makeAccountAuthenticator } from "./account-authentication.ts";
import { makeIdentityHttpHandler } from "./http.ts";
import {
  CREATED_AT,
  NOW,
  browserSession,
  identityApplication,
  memoryIdentityStore,
  principalSeed,
} from "./session-management.fixture.ts";

const PRINCIPAL = "01ARZ3NDEKTSV4RRFFQ69G5FA0" as Ulid;
const CURRENT = "01ARZ3NDEKTSV4RRFFQ69G5FA1" as Ulid;
const OTHER = "01ARZ3NDEKTSV4RRFFQ69G5FA2" as Ulid;
const FAMILY = "01ARZ3NDEKTSV4RRFFQ69G5FC0" as Ulid;
const ISSUER = "https://auth.deployments.ai";
const AUDIENCE = "https://api.deployments.ai";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: "jwk" }), alg: "RS256", kid: "test" };

function signed(claims: Record<string, unknown>, key: KeyObject = privateKey) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const issuedAt = Math.floor(Date.now() / 1_000);
  const input = `${part({ alg: "RS256", kid: "test", typ: "JWT" })}.${part({
    aud: AUDIENCE,
    client_id: "deployments-web",
    exp: issuedAt + 600,
    iat: issuedAt,
    iss: ISSUER,
    scope: "openid",
    sid: FAMILY,
    sub: PRINCIPAL,
    ...claims,
  })}`;
  return `${input}.${createSign("RSA-SHA256").update(input).sign(key, "base64url")}`;
}

function scenario() {
  const current = browserSession({
    createdAt: "2026-07-28T00:10:00.000Z",
    id: CURRENT,
    principalId: PRINCIPAL,
    rawToken: "token-current",
  });
  const other = browserSession({
    createdAt: "2026-07-28T00:20:00.000Z",
    id: OTHER,
    principalId: PRINCIPAL,
    rawToken: "token-other",
  });
  const { family } = refreshRecords({
    audience: AUDIENCE,
    authenticationTime: CREATED_AT,
    browserSessionId: CURRENT,
    clientId: "deployments-web",
    createdAt: CREATED_AT,
    expiresAt: "2026-08-27T00:00:00.000Z",
    familyId: FAMILY,
    principalId: PRINCIPAL,
    scopes: ["openid"],
    sessionEpoch: 0,
    tokenHash: "f".repeat(64),
    tokenId: "01ARZ3NDEKTSV4RRFFQ69G5FC1" as Ulid,
  });
  const store = memoryIdentityStore([
    ...principalSeed(PRINCIPAL),
    bffFenceRecord({
      createdAt: CREATED_AT,
      principalId: PRINCIPAL,
      principalStatus: "active",
      sessionEpoch: 0,
      version: 1,
    }),
    current.locator,
    current.session,
    other.locator,
    other.session,
    family,
  ]);
  const application = identityApplication(store.repository);
  const accountAuthenticator = makeAccountAuthenticator({
    now: () => new Date(NOW),
    repository: store.repository,
    verify: createLocalPlatformJwtVerifier({
      audience: AUDIENCE,
      issuer: ISSUER,
      keys: async () => ({ keys: [publicJwk] }),
    }),
  });
  const handler = makeIdentityHttpHandler(application, {
    accountAuthenticator,
    applicationOrigin: "https://app.deployments.ai",
    issuer: ISSUER,
    publicResponseMinimumMs: 0,
    queuePublicEmailRequest: async () => undefined,
    registrationEnabled: false,
    secureCookies: true,
    uiOrigin: ISSUER,
  });
  const call = async (method: string, path: string, authorization?: string) =>
    handler({
      headers: authorization ? { authorization } : {},
      httpMethod: method,
      path,
    });
  return { call, store };
}

describe("account self-service over the console's access token", () => {
  test("lists the caller's sessions and marks the one behind the token current", async () => {
    const { call } = scenario();
    const response = await call("GET", "/v1/account/sessions", `Bearer ${signed({})}`);

    expect(response.statusCode).toBe(200);
    const page = JSON.parse(response.body) as { items: { current: boolean; id: string }[] };
    expect(page.items.map(({ current, id }) => ({ current, id }))).toEqual([
      { current: false, id: OTHER },
      { current: true, id: CURRENT },
    ]);
  });

  test("refuses missing, foreign-client, and forged tokens", async () => {
    const { call } = scenario();
    const forged = signed({}, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey);

    for (const authorization of [
      undefined,
      `Bearer ${signed({ client_id: "deployments-cli" })}`,
      `Bearer ${forged}`,
    ]) {
      expect((await call("GET", "/v1/account/sessions", authorization)).statusCode).toBe(401);
    }
  });

  test("revokes another session without a CSRF cookie and stops the token after sign-out everywhere", async () => {
    const { call } = scenario();
    const bearer = `Bearer ${signed({})}`;

    const revoked = await call("DELETE", `/v1/account/sessions/${OTHER}`, bearer);
    expect(revoked.statusCode).toBe(200);
    expect(JSON.parse(revoked.body)).toEqual({ current: false });
    expect((await call("DELETE", `/v1/account/sessions/${OTHER}`, bearer)).statusCode).toBe(200);

    expect((await call("POST", "/v1/account/sign-out-all", bearer)).statusCode).toBe(204);
    expect((await call("GET", "/v1/account/security", bearer)).statusCode).toBe(401);
  });

  test("sign-out ends only the browser session behind the token", async () => {
    const { call, store } = scenario();
    const bearer = `Bearer ${signed({})}`;

    expect((await call("POST", "/v1/account/sign-out", bearer)).statusCode).toBe(204);
    // The token's browser session is gone, so it can no longer manage the account.
    expect((await call("GET", "/v1/account/security", bearer)).statusCode).toBe(401);
    const status = async (id: Ulid) =>
      (await store.repository.sessionLocator(PRINCIPAL, id))?.data.status;
    expect(await status(CURRENT)).toBe("revoked");
    expect(await status(OTHER)).toBe("active");
  });

  test("keeps cookie-authenticated identity routes behind the Origin and CSRF guard", async () => {
    const { call } = scenario();
    const response = await call("POST", "/v1/auth/sign-out-all", `Bearer ${signed({})}`);
    expect(response.statusCode).toBe(403);
  });
});
