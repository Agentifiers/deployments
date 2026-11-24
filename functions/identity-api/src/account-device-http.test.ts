import { describe, expect, test } from "bun:test";
import { oauthClientRecord, principalRecord, refreshRecords, type Ulid } from "@deployments-ai/db";
import { createLocalPlatformJwtVerifier } from "@deployments-ai/identity/platform-jwt";
import { createSign, generateKeyPairSync } from "node:crypto";
import { makeAccountAuthenticator } from "./account-authentication.ts";
import { makeDeviceApplication } from "./device-application.ts";
import { makeIdentityHttpHandler } from "./http.ts";
import type { OAuthApplication } from "./oauth-application.ts";
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
const OTHER_FAMILY = "01ARZ3NDEKTSV4RRFFQ69G5FC2" as Ulid;
const ISSUER = "https://auth.deployments.ai";
const AUDIENCE = "https://api.deployments.ai";
const APPLICATION = "https://app.deployments.ai";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: "jwk" }), alg: "RS256", kid: "test" };

function bearer(familyId: Ulid = FAMILY) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const issuedAt = Math.floor(Date.now() / 1_000);
  const input = `${part({ alg: "RS256", kid: "test", typ: "JWT" })}.${part({
    aud: AUDIENCE,
    client_id: "deployments-web",
    exp: issuedAt + 600,
    iat: issuedAt,
    iss: ISSUER,
    scope: "openid",
    sid: familyId,
    sub: PRINCIPAL,
  })}`;
  return `Bearer ${input}.${createSign("RSA-SHA256").update(input).sign(privateKey, "base64url")}`;
}

function family(id: Ulid, browserSessionId: Ulid, tokenId: Ulid) {
  return refreshRecords({
    audience: AUDIENCE,
    authenticationTime: CREATED_AT,
    browserSessionId,
    clientId: "deployments-web",
    createdAt: CREATED_AT,
    expiresAt: "2026-08-27T00:00:00.000Z",
    familyId: id,
    principalId: PRINCIPAL,
    scopes: ["openid"],
    sessionEpoch: 0,
    tokenHash: "f".repeat(64),
    tokenId,
  }).family;
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
  const [, security] = principalSeed(PRINCIPAL);
  const store = memoryIdentityStore([
    principalRecord({
      createdAt: CREATED_AT,
      displayName: "Ada Lovelace",
      id: PRINCIPAL,
      primaryEmail: "ada@example.com",
    }),
    security!,
    current.locator,
    current.session,
    other.locator,
    other.session,
    family(FAMILY, CURRENT, "01ARZ3NDEKTSV4RRFFQ69G5FC1" as Ulid),
    family(OTHER_FAMILY, OTHER, "01ARZ3NDEKTSV4RRFFQ69G5FC3" as Ulid),
    oauthClientRecord({
      allowedScopes: ["offline_access", "agents:read", "runs:write"],
      clientId: "deployments-cli",
      createdAt: CREATED_AT,
      grantTypes: ["urn:ietf:params:oauth:grant-type:device_code"],
      name: "Deployments CLI",
      redirectUris: ["http://127.0.0.1/callback"],
      requiredScopes: [],
      tokenEndpointAuthMethod: "none",
      type: "public",
      version: 1,
    }),
  ]);
  let clock = NOW;
  let nextId = 0;
  const device = makeDeviceApplication(
    {
      generateId: () => `01ARZ3NDEKTSV4RRFFQ69G5H${String(nextId++).padStart(2, "0")}` as Ulid,
      now: () => new Date(clock),
      repository: store.repository,
      signer: { jwks: async () => ({ keys: [] }), sign: async () => "platform.access.token" },
    },
    {
      accessTokenSeconds: 600,
      applicationOrigin: APPLICATION,
      deviceLifetimeSeconds: 600,
      issuer: ISSUER,
      pollingIntervalSeconds: 5,
      refreshTokenSeconds: 2_592_000,
      resourceAudience: AUDIENCE,
    },
  );
  const handler = makeIdentityHttpHandler(
    identityApplication(store.repository),
    {
      accountAuthenticator: makeAccountAuthenticator({
        now: () => new Date(NOW),
        repository: store.repository,
        verify: createLocalPlatformJwtVerifier({
          audience: AUDIENCE,
          issuer: ISSUER,
          keys: async () => ({ keys: [publicJwk] }),
        }),
      }),
      applicationOrigin: APPLICATION,
      issuer: ISSUER,
      publicResponseMinimumMs: 0,
      queuePublicEmailRequest: async () => undefined,
      registrationEnabled: false,
      secureCookies: true,
      uiOrigin: ISSUER,
    },
    { device, oauth: {} as OAuthApplication, signer: device as never },
  );
  const call = async (action: string, userCode: unknown, authorization?: string) => {
    const response = await handler({
      body: JSON.stringify({ userCode }),
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      httpMethod: "POST",
      path: `/v1/account/device/${action}`,
    });
    return {
      body: response.body ? JSON.parse(response.body) : undefined,
      status: response.statusCode,
    };
  };
  const start = () => device.authorize({ clientId: "deployments-cli", scopes: ["agents:read"] });
  return {
    advance: (iso: string) => (clock = iso),
    call,
    poll: (deviceCode: string) => device.poll({ clientId: "deployments-cli", deviceCode }),
    start,
  };
}

describe("device approval over the console's access token", () => {
  test("points the CLI at the console's device page", async () => {
    const started = await scenario().start();

    expect(started.verification_uri).toBe(`${APPLICATION}/device`);
    expect(started.verification_uri_complete).toBe(
      `${APPLICATION}/device?code=${started.user_code}`,
    );
  });

  test("claims with no cookie or CSRF token and names the client and account", async () => {
    const { call, start } = scenario();
    const { user_code } = await start();

    expect(await call("claim", user_code, bearer())).toEqual({
      body: {
        account: { displayName: "Ada Lovelace", email: "ada@example.com" },
        approved: false,
        clientId: "deployments-cli",
        clientName: "Deployments CLI",
        requestedScopes: ["agents:read"],
      },
      status: 200,
    });
  });

  test("an approval lets the CLI exchange its device code for a token", async () => {
    const { call, poll, start } = scenario();
    const started = await start();

    await call("claim", started.user_code, bearer());
    expect((await call("approve", started.user_code, bearer())).status).toBe(204);
    expect((await call("claim", started.user_code, bearer())).body).toMatchObject({
      approved: true,
    });
    expect(await poll(started.device_code)).toMatchObject({
      access_token: "platform.access.token",
      token_type: "Bearer",
    });
  });

  test("a denial stops the CLI and leaves the code used", async () => {
    const { call, poll, start } = scenario();
    const started = await start();

    await call("claim", started.user_code, bearer());
    expect((await call("deny", started.user_code, bearer())).status).toBe(204);
    expect(poll(started.device_code)).rejects.toMatchObject({ code: "access_denied" });
    expect(await call("claim", started.user_code, bearer())).toEqual({
      body: { error: "device_code_used" },
      status: 400,
    });
  });

  test("names unknown, expired, and already used codes apart", async () => {
    const { advance, call, start } = scenario();
    const used = await start();
    await call("claim", used.user_code, bearer());
    const expiring = await start();

    expect(await call("claim", used.user_code, bearer(OTHER_FAMILY))).toEqual({
      body: { error: "device_code_used" },
      status: 400,
    });
    expect(await call("approve", used.user_code, bearer(OTHER_FAMILY))).toEqual({
      body: { error: "device_code_used" },
      status: 400,
    });
    expect(await call("claim", "ZZZZ-ZZZZ", bearer())).toEqual({
      body: { error: "device_code_unknown" },
      status: 400,
    });
    advance("2026-07-28T01:11:00.000Z");
    expect(await call("claim", expiring.user_code, bearer())).toEqual({
      body: { error: "device_code_expired" },
      status: 400,
    });
  });

  test("refuses a missing token and a missing code", async () => {
    const { call, start } = scenario();
    const { user_code } = await start();

    expect((await call("claim", user_code)).status).toBe(401);
    expect(await call("claim", "", bearer())).toMatchObject({
      body: { error: "invalid_request" },
      status: 400,
    });
  });
});
