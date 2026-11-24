import { describe, expect, test } from "bun:test";
import {
  DatabaseError,
  oauthClientRecord,
  refreshRecords,
  type IdentityRepository,
  type TransactionOperation,
} from "@deployments-ai/db";
import { sha256 } from "@deployments-ai/identity";
import { makeOAuthApplication } from "./oauth-application.ts";

const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never;
const FAMILY_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as never;
const TOKEN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as never;
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as never;
const CREATED_AT = "2026-07-28T00:00:00.000Z";
const REVOKED_AT = "2026-07-28T01:00:00.000Z";
const emailEnvelope = {
  algorithm: "AES-256-GCM" as const,
  authenticationTag: "tag",
  ciphertext: "ciphertext",
  encryptedDataKey: "encrypted-key",
  encryptionContextHash: "context-hash",
  iv: "iv",
  schemaVersion: 1 as const,
};

function oauth(repository: IdentityRepository) {
  return makeOAuthApplication(
    {
      encryptEmailPayload: async () => emailEnvelope,
      generateId: () => EVENT_ID,
      now: () => new Date(REVOKED_AT),
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
}

describe("OAuth token revocation", () => {
  test("revokes an active refresh family and presented token atomically", async () => {
    const rawToken = "refresh-token";
    const client = oauthClientRecord({
      allowedScopes: ["offline_access"],
      clientId: "deployments-cli",
      createdAt: CREATED_AT,
      grantTypes: ["refresh_token"],
      name: "Deployments CLI",
      redirectUris: ["http://127.0.0.1/callback"],
      requiredScopes: [],
      tokenEndpointAuthMethod: "none",
      type: "public",
      version: 1,
    });
    const records = refreshRecords({
      audience: "https://api.deployments.ai",
      authenticationTime: CREATED_AT,
      clientId: "deployments-cli",
      createdAt: CREATED_AT,
      expiresAt: "2026-08-28T00:00:00.000Z",
      familyId: FAMILY_ID,
      principalId: PRINCIPAL_ID,
      scopes: ["offline_access"],
      sessionEpoch: 0,
      tokenHash: sha256(rawToken),
      tokenId: TOKEN_ID,
    });
    const transactions: TransactionOperation[][] = [];
    const repository = {
      clientForId: () => Promise.resolve(client),
      refreshFamilyForId: () => Promise.resolve(records.family),
      refreshTokenForHash: () => Promise.resolve(records.token),
      transact: (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
        return Promise.resolve();
      },
    } as unknown as IdentityRepository;

    await oauth(repository).revokeRefreshToken({
      clientId: "deployments-cli",
      refreshToken: rawToken,
    });

    expect(transactions).toHaveLength(1);
    const writes = transactions[0]!.filter((operation) => operation.kind === "put");
    expect(writes.map((operation) => operation.record.itemType)).toEqual([
      "oauth-refresh-family",
      "oauth-refresh-token",
      "identity-security-event",
    ]);
    expect(writes[0]).toMatchObject({
      previousRecord: records.family,
      record: {
        data: {
          revocationReason: "client-request",
          revokedAt: REVOKED_AT,
          status: "revoked",
          version: 2,
        },
      },
    });
    expect(writes[1]).toMatchObject({
      previousRecord: records.token,
      record: { data: { status: "revoked", version: 2 } },
    });
    expect(writes[2]).toMatchObject({
      record: {
        data: {
          aggregateId: FAMILY_ID,
          aggregateVersion: 2,
          eventType: "identity.refresh-revoked",
          principalId: PRINCIPAL_ID,
        },
      },
    });
  });

  test("does not disclose unknown refresh tokens", async () => {
    const client = oauthClientRecord({
      allowedScopes: ["offline_access"],
      clientId: "deployments-cli",
      createdAt: CREATED_AT,
      grantTypes: ["refresh_token"],
      name: "Deployments CLI",
      redirectUris: ["http://127.0.0.1/callback"],
      requiredScopes: [],
      tokenEndpointAuthMethod: "none",
      type: "public",
      version: 1,
    });
    let writes = 0;
    const repository = {
      clientForId: () => Promise.resolve(client),
      refreshTokenForHash: () => Promise.resolve(undefined),
      transact: () => {
        writes += 1;
        return Promise.resolve();
      },
    } as unknown as IdentityRepository;

    expect(
      oauth(repository).revokeRefreshToken({
        clientId: "deployments-cli",
        refreshToken: "unknown-token",
      }),
    ).resolves.toBeUndefined();
    expect(writes).toBe(0);
  });

  test("does not disclose refresh tokens issued to another client", async () => {
    const client = oauthClientRecord({
      allowedScopes: ["offline_access"],
      clientId: "other-client",
      createdAt: CREATED_AT,
      grantTypes: ["refresh_token"],
      name: "Other Client",
      redirectUris: ["http://127.0.0.1/callback"],
      requiredScopes: [],
      tokenEndpointAuthMethod: "none",
      type: "public",
      version: 1,
    });
    const records = refreshRecords({
      audience: "https://api.deployments.ai",
      authenticationTime: CREATED_AT,
      clientId: "deployments-cli",
      createdAt: CREATED_AT,
      expiresAt: "2026-08-28T00:00:00.000Z",
      familyId: FAMILY_ID,
      principalId: PRINCIPAL_ID,
      scopes: ["offline_access"],
      sessionEpoch: 0,
      tokenHash: sha256("refresh-token"),
      tokenId: TOKEN_ID,
    });
    let writes = 0;
    const repository = {
      clientForId: () => Promise.resolve(client),
      refreshFamilyForId: () => Promise.resolve(records.family),
      refreshTokenForHash: () => Promise.resolve(records.token),
      transact: () => {
        writes += 1;
        return Promise.resolve();
      },
    } as unknown as IdentityRepository;

    expect(
      oauth(repository).revokeRefreshToken({
        clientId: "other-client",
        refreshToken: "refresh-token",
      }),
    ).resolves.toBeUndefined();
    expect(writes).toBe(0);
  });

  test("retries unrelated write conflicts while the refresh family remains active", async () => {
    const rawToken = "refresh-token";
    const client = oauthClientRecord({
      allowedScopes: ["offline_access"],
      clientId: "deployments-cli",
      createdAt: CREATED_AT,
      grantTypes: ["refresh_token"],
      name: "Deployments CLI",
      redirectUris: ["http://127.0.0.1/callback"],
      requiredScopes: [],
      tokenEndpointAuthMethod: "none",
      type: "public",
      version: 1,
    });
    const records = refreshRecords({
      audience: "https://api.deployments.ai",
      authenticationTime: CREATED_AT,
      clientId: "deployments-cli",
      createdAt: CREATED_AT,
      expiresAt: "2026-08-28T00:00:00.000Z",
      familyId: FAMILY_ID,
      principalId: PRINCIPAL_ID,
      scopes: ["offline_access"],
      sessionEpoch: 0,
      tokenHash: sha256(rawToken),
      tokenId: TOKEN_ID,
    });
    let transactions = 0;
    const repository = {
      clientForId: () => Promise.resolve(client),
      refreshFamilyForId: () => Promise.resolve(records.family),
      refreshTokenForHash: () => Promise.resolve(records.token),
      transact: () => {
        transactions += 1;
        return transactions === 1
          ? Promise.reject(
              new DatabaseError({
                cause: new Error("ConditionalCheckFailedException"),
                message: "Concurrent refresh-family update.",
                operation: "transact-write",
                reason: "conflict",
                table: "multiple",
              }),
            )
          : Promise.resolve();
      },
    } as unknown as IdentityRepository;

    await oauth(repository).revokeRefreshToken({
      clientId: "deployments-cli",
      refreshToken: rawToken,
    });

    expect(transactions).toBe(2);
  });
});
