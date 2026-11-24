import { describe, expect, test } from "bun:test";
import {
  DatabaseError,
  oauthClientRecord,
  principalRecord,
  securityStateRecord,
  sessionRecords,
  type IdentityRecord,
  type IdentityRepository,
  type TransactionOperation,
} from "@deployments-ai/db";
import { makeOAuthApplication } from "./oauth-application.ts";

const NOW = "2026-07-28T00:00:00.000Z";
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never;
const SESSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as never;
const GENERATED_IDS = [
  "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  "01ARZ3NDEKTSV4RRFFQ69G5FB0",
  "01ARZ3NDEKTSV4RRFFQ69G5FB1",
] as const;

describe("OAuth authorization interactions", () => {
  test("concurrent confirmations of one interaction issue at most one code", async () => {
    const principal = principalRecord({
      createdAt: NOW,
      id: PRINCIPAL_ID,
      primaryEmail: "user@example.com",
    });
    const security = securityStateRecord({
      createdAt: NOW,
      credentialVersion: 1,
      emailVerifiedAt: NOW,
      principalId: PRINCIPAL_ID,
      sessionEpoch: 0,
      version: 1,
    });
    const records = sessionRecords({
      authentication: { method: "password" },
      authenticationTime: NOW,
      createdAt: NOW,
      expiresAt: "2026-07-28T02:00:00.000Z",
      id: SESSION_ID,
      idleExpiresAt: "2026-07-28T01:00:00.000Z",
      principalId: PRINCIPAL_ID,
      sessionEpoch: 0,
      tokenHash: "session-token-hash",
    });
    const client = oauthClientRecord({
      allowedScopes: ["offline_access", "openid"],
      clientId: "deployments-cli",
      createdAt: NOW,
      grantTypes: ["authorization_code", "refresh_token"],
      name: "Deployments CLI",
      redirectUris: ["http://127.0.0.1/callback"],
      requiredScopes: [],
      tokenEndpointAuthMethod: "none",
      type: "public",
      version: 1,
    });
    let authorizationRequest: IdentityRecord<"oauth-authorization-request"> | undefined;
    const authorizationCodes: IdentityRecord<"oauth-authorization-code">[] = [];
    const conflict = () =>
      new DatabaseError({
        cause: new Error("ConditionalCheckFailedException"),
        message: "Authorization interaction changed.",
        operation: "transact-write",
        reason: "conflict",
        table: "multiple",
      });
    const transact = async (operations: readonly TransactionOperation[]) => {
      const requestWrite = operations.find(
        (operation) =>
          operation.kind === "put" && operation.record.itemType === "oauth-authorization-request",
      );
      if (requestWrite?.kind === "put") {
        const previousRequest =
          requestWrite.previousRecord?.itemType === "oauth-authorization-request"
            ? requestWrite.previousRecord
            : undefined;
        if (
          previousRequest &&
          authorizationRequest?.data.version !== previousRequest.data.version
        ) {
          return Promise.reject(conflict());
        }
        authorizationRequest = requestWrite.record as IdentityRecord<"oauth-authorization-request">;
      }
      for (const operation of operations) {
        if (operation.kind === "put" && operation.record.itemType === "oauth-authorization-code") {
          authorizationCodes.push(operation.record);
        }
      }
      return Promise.resolve();
    };
    const repository = {
      authorizationRequestForHash: () => Promise.resolve(authorizationRequest),
      browserSessionVersionChecks: () => [],
      clientForId: () => Promise.resolve(client),
      loginMaterialVersionChecks: () => [],
      principalForId: () => Promise.resolve(principal),
      securityStateForPrincipal: () => Promise.resolve(security),
      sessionForHash: () => Promise.resolve(records.session),
      sessionLocator: () => Promise.resolve(records.locator),
      transact,
    } as unknown as IdentityRepository;
    let generatedId = 0;
    let randomByte = 0;
    const application = makeOAuthApplication(
      {
        encryptEmailPayload: async () => ({}) as never,
        generateId: () => GENERATED_IDS[generatedId++]! as never,
        now: () => new Date(NOW),
        random: { bytes: (length) => new Uint8Array(length).fill(++randomByte) },
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
    const browserSession = {
      authenticationTime: NOW,
      principalId: PRINCIPAL_ID,
      sessionId: SESSION_ID,
    };
    const requestHandle = await application.beginAuthorizationInteraction({
      browserSession,
      clientId: "deployments-cli",
      codeChallenge: "a".repeat(43),
      codeChallengeMethod: "S256",
      nonce: "browser-nonce",
      redirectUri: "http://127.0.0.1:48123/callback",
      responseType: "code",
      scopes: ["openid", "offline_access"],
      state: "state-value",
    });

    const results = await Promise.allSettled([
      application.confirmAuthorizationInteraction({
        browserSession,
        clientId: "deployments-cli",
        requestHandle,
      }),
      application.confirmAuthorizationInteraction({
        browserSession,
        clientId: "deployments-cli",
        requestHandle,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(authorizationCodes).toHaveLength(1);
    expect(authorizationRequest?.data.status).toBe("completed");
  });
});
