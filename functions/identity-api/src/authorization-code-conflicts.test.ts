import { describe, expect, test } from "bun:test";
import {
  authorizationCodeRecord,
  DatabaseError,
  oauthClientRecord,
  principalRecord,
  securityStateRecord,
  sessionRecords,
  type IdentityRepository,
} from "@deployments-ai/db";
import { sha256, sha256Base64Url } from "@deployments-ai/identity";
import { makeOAuthApplication } from "./oauth-application.ts";

const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never;
const SESSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as never;
const REQUEST_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as never;
const CODE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as never;

describe("authorization-code exchange conflicts", () => {
  test("returns invalid_grant when another request consumes the code", async () => {
    const createdAt = "2026-07-28T00:00:00.000Z";
    const exchangedAt = "2026-07-28T00:01:00.000Z";
    const rawCode = "authorization-code";
    const verifier = "a".repeat(43);
    const principal = principalRecord({
      createdAt,
      id: PRINCIPAL_ID,
      primaryEmail: "user@example.com",
    });
    const securityState = securityStateRecord({
      createdAt,
      credentialVersion: 1,
      emailVerifiedAt: createdAt,
      principalId: PRINCIPAL_ID,
      sessionEpoch: 0,
      version: 1,
    });
    const { locator, session } = sessionRecords({
      authentication: { method: "password" },
      authenticationTime: createdAt,
      createdAt,
      expiresAt: "2026-07-28T02:00:00.000Z",
      id: SESSION_ID,
      idleExpiresAt: "2026-07-28T01:00:00.000Z",
      principalId: PRINCIPAL_ID,
      sessionEpoch: 0,
      tokenHash: "session-token-hash",
    });
    const code = authorizationCodeRecord({
      authenticationTime: createdAt,
      authorizationRequestId: REQUEST_ID,
      browserSessionId: SESSION_ID,
      clientId: "deployments-web",
      codeChallenge: sha256Base64Url(verifier),
      codeHash: sha256(rawCode),
      createdAt,
      expiresAt: "2026-07-28T00:02:00.000Z",
      id: CODE_ID,
      principalId: PRINCIPAL_ID,
      redirectUri: "https://app.deployments.ai/callback",
      scopes: ["openid"],
      sessionEpoch: 0,
    });
    const consumed = {
      ...code,
      data: {
        ...code.data,
        consumedAt: exchangedAt,
        status: "consumed" as const,
        updatedAt: exchangedAt,
        version: code.data.version + 1,
      },
    };
    const client = oauthClientRecord({
      allowedScopes: ["openid"],
      clientId: "deployments-web",
      clientSecretHash: sha256("client-secret"),
      createdAt,
      grantTypes: ["authorization_code"],
      name: "Deployments Web",
      redirectUris: ["https://app.deployments.ai/callback"],
      requiredScopes: ["openid"],
      tokenEndpointAuthMethod: "client_secret_basic",
      type: "confidential",
      version: 1,
    });
    let codeReads = 0;
    const repository = {
      authorizationCodeForHash: () => Promise.resolve(codeReads++ === 0 ? code : consumed),
      browserSessionVersionChecks: () => [],
      clientForId: () => Promise.resolve(client),
      loadLoginMaterial: () => Promise.resolve({ credential: undefined, principal, securityState }),
      loginMaterialVersionChecks: () => [],
      principalForId: () => Promise.resolve(principal),
      sessionForHash: () => Promise.resolve(session),
      sessionLocator: () => Promise.resolve(locator),
      transact: () =>
        Promise.reject(
          new DatabaseError({
            cause: new Error("ConditionalCheckFailedException"),
            message: "Concurrent exchange won.",
            operation: "transact-write",
            reason: "conflict",
            table: "multiple",
          }),
        ),
    } as unknown as IdentityRepository;
    const application = makeOAuthApplication(
      {
        encryptEmailPayload: async () => {
          throw new Error("not used");
        },
        generateId: () => CODE_ID,
        now: () => new Date(exchangedAt),
        repository,
        signer: { jwks: async () => ({ keys: [] }), sign: async () => "signed" },
      },
      {
        accessTokenSeconds: 300,
        authorizationCodeSeconds: 120,
        authorizationRequestSeconds: 600,
        idTokenSeconds: 300,
        issuer: "https://auth.deployments.ai",
        refreshTokenSeconds: 2_592_000,
        resourceAudience: "https://api.deployments.ai",
      },
    );

    expect(
      application.exchangeAuthorizationCode({
        clientId: "deployments-web",
        clientSecret: "client-secret",
        code: rawCode,
        codeVerifier: verifier,
        redirectUri: "https://app.deployments.ai/callback",
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    expect(codeReads).toBe(2);
  });
});
