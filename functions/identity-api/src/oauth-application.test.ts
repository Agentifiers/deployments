import { describe, expect, test } from "bun:test";
import {
  authorizationCodeRecord,
  DatabaseError,
  oauthClientRecord,
  principalRecord,
  refreshRecords,
  securityStateRecord,
  sessionRecords,
  type IdentityRepository,
  type TransactionOperation,
} from "@deployments-ai/db";
import { sha256, sha256Base64Url } from "@deployments-ai/identity";
import { makeOAuthApplication } from "./oauth-application.ts";

const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never;
const SESSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as never;
const FAMILY_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as never;
const TOKEN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as never;
const emailEnvelope = {
  algorithm: "AES-256-GCM" as const,
  authenticationTag: "tag",
  ciphertext: "ciphertext",
  encryptedDataKey: "encrypted-key",
  encryptionContextHash: "context-hash",
  iv: "iv",
  schemaVersion: 1 as const,
};

describe("OAuth refresh session binding", () => {
  test("rejects OAuth flows disabled by the client grant-type registration", async () => {
    const createdAt = "2026-07-28T00:00:00.000Z";
    const client = oauthClientRecord({
      allowedScopes: ["offline_access", "openid"],
      clientId: "deployments-cli",
      createdAt,
      grantTypes: [],
      name: "Deployments CLI",
      redirectUris: ["http://127.0.0.1/callback"],
      requiredScopes: [],
      tokenEndpointAuthMethod: "none",
      type: "public",
      version: 1,
    });
    const application = makeOAuthApplication(
      {
        encryptEmailPayload: async () => emailEnvelope,
        generateId: () => TOKEN_ID,
        repository: {
          clientForId: () => Promise.resolve(client),
        } as unknown as IdentityRepository,
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

    expect(
      application.authorize({
        browserSession: {
          authenticationTime: createdAt,
          principalId: PRINCIPAL_ID,
          sessionId: SESSION_ID,
        },
        clientId: "deployments-cli",
        codeChallenge: "a".repeat(43),
        codeChallengeMethod: "S256",
        confirmed: true,
        redirectUri: "http://127.0.0.1:49152/callback",
        responseType: "code",
        scopes: ["openid"],
      }),
    ).rejects.toThrow("Client is not authorized for the authorization_code grant.");
    expect(
      application.exchangeAuthorizationCode({
        clientId: "deployments-cli",
        code: "authorization-code",
        codeVerifier: "a".repeat(43),
        redirectUri: "http://127.0.0.1:49152/callback",
      }),
    ).rejects.toThrow("Client is not authorized for the authorization_code grant.");
    expect(
      application.exchangeRefreshToken({
        clientId: "deployments-cli",
        refreshToken: "refresh-token",
      }),
    ).rejects.toThrow("Client is not authorized for the refresh_token grant.");
  });

  test("rejects a web refresh after its linked browser session idles out", async () => {
    const createdAt = "2026-07-28T00:00:00.000Z";
    const expiresAt = "2026-07-28T02:00:00.000Z";
    const rawRefreshToken = "refresh-secret";
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
      expiresAt,
      id: SESSION_ID,
      idleExpiresAt: "2026-07-28T00:30:00.000Z",
      principalId: PRINCIPAL_ID,
      sessionEpoch: 0,
      tokenHash: "session-token-hash",
    });
    const { family, token } = refreshRecords({
      audience: "https://api.deployments.ai",
      authenticationTime: createdAt,
      browserSessionId: SESSION_ID,
      clientId: "deployments-web",
      createdAt,
      expiresAt,
      familyId: FAMILY_ID,
      principalId: PRINCIPAL_ID,
      scopes: ["openid", "offline_access"],
      sessionEpoch: 0,
      tokenHash: sha256(rawRefreshToken),
      tokenId: TOKEN_ID,
    });
    const client = oauthClientRecord({
      allowedScopes: ["openid", "offline_access"],
      clientId: "deployments-web",
      clientSecretHash: sha256("client-secret"),
      createdAt,
      grantTypes: ["authorization_code", "refresh_token"],
      name: "Deployments Web",
      redirectUris: ["https://app.deployments.ai/callback"],
      requiredScopes: ["openid"],
      tokenEndpointAuthMethod: "client_secret_basic",
      type: "confidential",
      version: 1,
    });
    const repository = {
      clientForId: () => Promise.resolve(client),
      loadLoginMaterial: () => Promise.resolve({ credential: undefined, principal, securityState }),
      refreshFamilyForId: () => Promise.resolve(family),
      refreshTokenForHash: () => Promise.resolve(token),
      sessionForHash: () => Promise.resolve(session),
      sessionLocator: () => Promise.resolve(locator),
    } as unknown as IdentityRepository;
    const application = makeOAuthApplication(
      {
        encryptEmailPayload: async () => emailEnvelope,
        generateId: () => TOKEN_ID,
        now: () => new Date("2026-07-28T01:00:00.000Z"),
        repository,
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

    expect(
      application.exchangeRefreshToken({
        clientId: "deployments-web",
        clientSecret: "client-secret",
        refreshToken: rawRefreshToken,
      }),
    ).rejects.toThrow("Refresh token is no longer active.");
  });

  test("rejects authorization-code exchange after the browser session idles out", async () => {
    const createdAt = "2026-07-28T00:00:00.000Z";
    const expiresAt = "2026-07-28T02:00:00.000Z";
    const verifier = "a".repeat(43);
    const rawCode = "authorization-code";
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
      expiresAt,
      id: SESSION_ID,
      idleExpiresAt: "2026-07-28T00:30:00.000Z",
      principalId: PRINCIPAL_ID,
      sessionEpoch: 0,
      tokenHash: "session-token-hash",
    });
    const code = authorizationCodeRecord({
      authenticationTime: createdAt,
      authorizationRequestId: FAMILY_ID,
      browserSessionId: SESSION_ID,
      clientId: "deployments-web",
      codeChallenge: sha256Base64Url(verifier),
      codeHash: sha256(rawCode),
      createdAt,
      expiresAt,
      id: TOKEN_ID,
      principalId: PRINCIPAL_ID,
      redirectUri: "https://app.deployments.ai/callback",
      scopes: ["openid", "offline_access"],
      sessionEpoch: 0,
    });
    const client = oauthClientRecord({
      allowedScopes: ["openid", "offline_access"],
      clientId: "deployments-web",
      clientSecretHash: sha256("client-secret"),
      createdAt,
      grantTypes: ["authorization_code", "refresh_token"],
      name: "Deployments Web",
      redirectUris: ["https://app.deployments.ai/callback"],
      requiredScopes: ["openid"],
      tokenEndpointAuthMethod: "client_secret_basic",
      type: "confidential",
      version: 1,
    });
    const repository = {
      authorizationCodeForHash: () => Promise.resolve(code),
      clientForId: () => Promise.resolve(client),
      loadLoginMaterial: () => Promise.resolve({ credential: undefined, principal, securityState }),
      sessionForHash: () => Promise.resolve(session),
      sessionLocator: () => Promise.resolve(locator),
    } as unknown as IdentityRepository;
    const application = makeOAuthApplication(
      {
        encryptEmailPayload: async () => emailEnvelope,
        generateId: () => TOKEN_ID,
        now: () => new Date("2026-07-28T01:00:00.000Z"),
        repository,
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

    expect(
      application.exchangeAuthorizationCode({
        clientId: "deployments-web",
        clientSecret: "client-secret",
        code: rawCode,
        codeVerifier: verifier,
        redirectUri: "https://app.deployments.ai/callback",
      }),
    ).rejects.toThrow("Authorization session is no longer active.");
  });

  test("retries unrelated refresh conflicts and yields to a concurrent rotation winner", async () => {
    const createdAt = "2026-07-28T00:00:00.000Z";
    const expiresAt = "2026-08-28T00:00:00.000Z";
    const rawRefreshToken = "refresh-secret";
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
    const { family, token } = refreshRecords({
      audience: "https://api.deployments.ai",
      authenticationTime: createdAt,
      clientId: "deployments-cli",
      createdAt,
      expiresAt,
      familyId: FAMILY_ID,
      principalId: PRINCIPAL_ID,
      scopes: ["offline_access"],
      sessionEpoch: 0,
      tokenHash: sha256(rawRefreshToken),
      tokenId: TOKEN_ID,
    });
    const winningFamily = {
      ...family,
      data: { ...family.data, latestGeneration: 2, version: 2 },
    };
    const winningToken = {
      ...token,
      data: {
        ...token.data,
        replacementTokenHash: sha256("winner-replacement"),
        rotatedAt: "2026-07-28T01:00:00.000Z",
        status: "rotated" as const,
        version: 2,
      },
    };
    const client = oauthClientRecord({
      allowedScopes: ["offline_access"],
      clientId: "deployments-cli",
      createdAt,
      grantTypes: ["refresh_token"],
      name: "Deployments CLI",
      redirectUris: ["http://127.0.0.1/callback"],
      requiredScopes: [],
      tokenEndpointAuthMethod: "none",
      type: "public",
      version: 1,
    });
    let tokenReads = 0;
    let familyReads = 0;
    let concurrentReplay = false;
    const transactions: TransactionOperation[][] = [];
    const repository = {
      clientForId: () => Promise.resolve(client),
      loadLoginMaterial: () => Promise.resolve({ credential: undefined, principal, securityState }),
      loginMaterialVersionChecks: () => [],
      principalForId: () => Promise.resolve(principal),
      refreshFamilyForId: () =>
        Promise.resolve(!concurrentReplay || familyReads++ === 0 ? family : winningFamily),
      refreshTokenForHash: () =>
        Promise.resolve(!concurrentReplay || tokenReads++ === 0 ? token : winningToken),
      transact: (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
        return transactions.length === 1
          ? Promise.reject(
              new DatabaseError({
                cause: new Error("ConditionalCheckFailedException"),
                message: "Concurrent rotation won.",
                operation: "transact-write",
                reason: "conflict",
                table: "multiple",
              }),
            )
          : Promise.resolve();
      },
    } as unknown as IdentityRepository;
    const application = makeOAuthApplication(
      {
        encryptEmailPayload: async () => emailEnvelope,
        generateId: () => TOKEN_ID,
        now: () => new Date("2026-07-28T01:00:00.000Z"),
        random: { bytes: (length) => new Uint8Array(length).fill(9) },
        repository,
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

    expect(
      application.exchangeRefreshToken({
        clientId: "deployments-cli",
        refreshToken: rawRefreshToken,
      }),
    ).resolves.toMatchObject({ token_type: "Bearer" });
    expect(transactions).toHaveLength(2);

    transactions.length = 0;
    concurrentReplay = true;
    tokenReads = 0;
    familyReads = 0;

    expect(
      application.exchangeRefreshToken({
        clientId: "deployments-cli",
        refreshToken: rawRefreshToken,
      }),
    ).rejects.toThrow("Refresh could not be completed because identity state kept changing.");
    expect(
      transactions.map((operations) =>
        operations.map((operation) => operation.kind === "put" && operation.record.itemType),
      ),
    ).toEqual([
      [
        "oauth-refresh-token",
        "oauth-refresh-token",
        "oauth-refresh-family",
        "identity-security-event",
      ],
    ]);
  });

  test("persists refresh scope narrowing without dropping required client scopes", async () => {
    const createdAt = "2026-07-28T00:00:00.000Z";
    const rawRefreshToken = "refresh-secret";
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
    const { family, token } = refreshRecords({
      audience: "https://api.deployments.ai",
      authenticationTime: createdAt,
      clientId: "deployments-cli",
      createdAt,
      expiresAt: "2026-08-28T00:00:00.000Z",
      familyId: FAMILY_ID,
      principalId: PRINCIPAL_ID,
      scopes: ["offline_access", "organizations:read", "organizations:write"],
      sessionEpoch: 0,
      tokenHash: sha256(rawRefreshToken),
      tokenId: TOKEN_ID,
    });
    let activeClient = oauthClientRecord({
      allowedScopes: ["offline_access", "organizations:read", "organizations:write"],
      clientId: "deployments-cli",
      createdAt,
      grantTypes: ["refresh_token"],
      name: "Deployments CLI",
      redirectUris: ["http://127.0.0.1/callback"],
      requiredScopes: [],
      tokenEndpointAuthMethod: "none",
      type: "public",
      version: 1,
    });
    const transactions: TransactionOperation[][] = [];
    const repository = {
      clientForId: () => Promise.resolve(activeClient),
      loadLoginMaterial: () => Promise.resolve({ credential: undefined, principal, securityState }),
      loginMaterialVersionChecks: () => [],
      principalForId: () => Promise.resolve(principal),
      refreshFamilyForId: () => Promise.resolve(family),
      refreshTokenForHash: () => Promise.resolve(token),
      transact: (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
        return Promise.resolve();
      },
    } as unknown as IdentityRepository;
    const application = makeOAuthApplication(
      {
        encryptEmailPayload: async () => emailEnvelope,
        generateId: () => TOKEN_ID,
        now: () => new Date("2026-07-28T01:00:00.000Z"),
        random: { bytes: (length) => new Uint8Array(length).fill(6) },
        repository,
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

    await application.exchangeRefreshToken({
      clientId: "deployments-cli",
      refreshToken: rawRefreshToken,
      scopes: ["offline_access", "organizations:read"],
    });

    const nextFamily = transactions[0]?.find(
      (operation) =>
        operation.kind === "put" && operation.record.itemType === "oauth-refresh-family",
    );
    expect(
      nextFamily?.kind === "put" && nextFamily.record.itemType === "oauth-refresh-family"
        ? nextFamily.record.data.scopes
        : undefined,
    ).toEqual(["offline_access", "organizations:read"]);

    activeClient = {
      ...activeClient,
      data: { ...activeClient.data, requiredScopes: ["organizations:write"] },
    };
    expect(
      application.exchangeRefreshToken({
        clientId: "deployments-cli",
        refreshToken: rawRefreshToken,
        scopes: ["offline_access", "organizations:read"],
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    expect(transactions).toHaveLength(1);
  });

  test("binds prompt=login continuations to a newly authenticated session and consumes them once", async () => {
    const issuedAt = "2026-07-28T01:00:00.000Z";
    const freshAuthenticationTime = "2026-07-28T01:00:01.000Z";
    const freshSessionId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as never;
    const requestFingerprint = sha256("authorization-request");
    const principal = principalRecord({
      createdAt: issuedAt,
      id: PRINCIPAL_ID,
      primaryEmail: "user@example.com",
    });
    const securityState = securityStateRecord({
      createdAt: issuedAt,
      credentialVersion: 1,
      emailVerifiedAt: issuedAt,
      principalId: PRINCIPAL_ID,
      sessionEpoch: 0,
      version: 1,
    });
    const { locator, session } = sessionRecords({
      authentication: { method: "password" },
      authenticationTime: freshAuthenticationTime,
      createdAt: freshAuthenticationTime,
      expiresAt: "2026-07-28T03:00:00.000Z",
      id: freshSessionId,
      idleExpiresAt: "2026-07-28T02:00:00.000Z",
      principalId: PRINCIPAL_ID,
      sessionEpoch: 0,
      tokenHash: "fresh-session-token-hash",
    });
    const client = oauthClientRecord({
      allowedScopes: ["openid"],
      clientId: "deployments-web",
      createdAt: issuedAt,
      grantTypes: ["authorization_code"],
      name: "Deployments Web",
      redirectUris: ["https://app.deployments.ai/callback"],
      requiredScopes: ["openid"],
      tokenEndpointAuthMethod: "client_secret_basic",
      type: "confidential",
      version: 1,
    });
    let reauthentication:
      | Extract<TransactionOperation, { readonly kind: "put" }>["record"]
      | undefined;
    let authorizationRequest:
      | Extract<TransactionOperation, { readonly kind: "put" }>["record"]
      | undefined;
    const repository = {
      authorizationRequestForHash: () =>
        Promise.resolve(
          authorizationRequest?.itemType === "oauth-authorization-request"
            ? authorizationRequest
            : undefined,
        ),
      browserSessionVersionChecks: () => [],
      clientForId: () => Promise.resolve(client),
      loginMaterialVersionChecks: () => [],
      principalForId: () => Promise.resolve(principal),
      reauthenticationRequestForHash: () =>
        Promise.resolve(
          reauthentication?.itemType === "oauth-reauthentication-request"
            ? reauthentication
            : undefined,
        ),
      securityStateForPrincipal: () => Promise.resolve(securityState),
      sessionForHash: () => Promise.resolve(session),
      sessionLocator: () => Promise.resolve(locator),
      transact: async (operations: readonly TransactionOperation[]) => {
        const write = operations.find(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "oauth-reauthentication-request",
        );
        if (write?.kind === "put") reauthentication = write.record;
        const authorizationWrite = operations.find(
          (operation) =>
            operation.kind === "put" && operation.record.itemType === "oauth-authorization-request",
        );
        if (authorizationWrite?.kind === "put") {
          authorizationRequest = authorizationWrite.record;
        }
      },
    } as unknown as IdentityRepository;
    const application = makeOAuthApplication(
      {
        encryptEmailPayload: async () => emailEnvelope,
        generateId: () => TOKEN_ID,
        now: () => new Date(issuedAt),
        random: { bytes: (length) => new Uint8Array(length).fill(7) },
        repository,
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
    const token = await application.beginReauthentication({
      previousSessionId: SESSION_ID,
      requestFingerprint,
    });

    expect(
      application.validateReauthentication({
        browserSession: {
          authenticationTime: "2026-07-28T00:59:59.000Z",
          principalId: PRINCIPAL_ID,
          sessionId: SESSION_ID,
        },
        requestFingerprint,
        token,
      }),
    ).rejects.toThrow("Fresh authentication is required.");
    await application.validateReauthentication({
      browserSession: {
        authenticationTime: freshAuthenticationTime,
        principalId: PRINCIPAL_ID,
        sessionId: freshSessionId,
      },
      requestFingerprint,
      token,
    });
    await application.authorize({
      browserSession: {
        authenticationTime: freshAuthenticationTime,
        principalId: PRINCIPAL_ID,
        sessionId: freshSessionId,
      },
      clientId: "deployments-web",
      codeChallenge: "a".repeat(43),
      codeChallengeMethod: "S256",
      confirmed: true,
      nonce: "browser-nonce",
      reauthenticationToken: token,
      redirectUri: "https://app.deployments.ai/callback",
      requestFingerprint,
      responseType: "code",
      scopes: ["openid"],
    });

    expect(reauthentication?.itemType).toBe("oauth-reauthentication-request");
    expect(
      reauthentication?.itemType === "oauth-reauthentication-request"
        ? reauthentication.data.status
        : undefined,
    ).toBe("consumed");
    expect(
      application.validateReauthentication({
        browserSession: {
          authenticationTime: freshAuthenticationTime,
          principalId: PRINCIPAL_ID,
          sessionId: freshSessionId,
        },
        requestFingerprint,
        token,
      }),
    ).rejects.toThrow("Fresh authentication is required.");
  });
});
