import { describe, expect, test } from "bun:test";
import {
  DatabaseError,
  deviceGrantRecord,
  oauthClientRecord,
  principalRecord,
  securityStateRecord,
  sessionRecords,
  type IdentityRepository,
  type IdentityRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import { makeDeviceApplication } from "./device-application.ts";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never;
const SESSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as never;
const NOW = "2026-07-28T00:00:00.000Z";

function deviceClient() {
  return oauthClientRecord({
    allowedScopes: ["offline_access", "organizations:read"],
    clientId: "deployments-cli",
    createdAt: NOW,
    grantTypes: ["urn:ietf:params:oauth:grant-type:device_code"],
    name: "Deployments CLI",
    redirectUris: ["http://127.0.0.1/callback"],
    requiredScopes: [],
    tokenEndpointAuthMethod: "none",
    type: "public",
    version: 1,
  });
}

function claimedGrant(scopes: readonly string[] = ["offline_access", "organizations:read"]) {
  const pending = deviceGrantRecord({
    clientId: "deployments-cli",
    createdAt: NOW,
    deviceCodeHash: "device-code-hash",
    expiresAt: "2026-07-28T01:00:00.000Z",
    id: ID,
    pollingIntervalSeconds: 5,
    requestedScopes: scopes,
    userCodeHash: "user-code-hash",
  });
  return {
    ...pending,
    data: {
      ...pending.data,
      claimedBySessionId: SESSION_ID,
      principalId: ID,
      status: "claimed" as const,
      version: 2,
    },
  };
}

describe("OAuth device authorization", () => {
  test("creates an expiring user-code claim with the canonical replacement condition", async () => {
    const client = deviceClient();
    const transactions: TransactionOperation[][] = [];
    const application = makeDeviceApplication(
      {
        generateId: () => ID,
        now: () => new Date("2026-07-28T00:00:00.000Z"),
        random: { bytes: (length) => new Uint8Array(length).fill(7) },
        repository: {
          clientForId: () => Promise.resolve(client),
          transact: (operations: readonly TransactionOperation[]) => {
            transactions.push([...operations]);
            return Promise.resolve();
          },
        } as unknown as IdentityRepository,
        signer: { jwks: async () => ({ keys: [] }), sign: async () => "signed" },
      },
      {
        accessTokenSeconds: 600,
        applicationOrigin: "https://app.deployments.ai",
        deviceLifetimeSeconds: 600,
        issuer: "https://auth.deployments.ai",
        pollingIntervalSeconds: 5,
        refreshTokenSeconds: 2_592_000,
        resourceAudience: "https://api.deployments.ai",
      },
    );

    await application.authorize({
      clientId: "deployments-cli",
      scopes: ["offline_access", "organizations:read"],
    });

    const claim = transactions[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "unique-claim",
    );
    expect(claim?.kind === "put" ? claim.conditionExpression : undefined).toBe(
      "(attribute_not_exists(pk) AND attribute_not_exists(sk)) OR (#uniqueClaimItemType = :uniqueClaimItemType AND #uniqueClaimData.#uniqueClaimExpiresAt <= :uniqueClaimNow)",
    );
    expect(claim?.kind === "put" ? claim.replaceExpired : undefined).toBeTrue();
    expect(
      claim?.kind === "put" && claim.record.itemType === "unique-claim"
        ? {
            expiresAt: claim.record.data.expiresAt,
            ownerTable: claim.record.data.ownerTable,
            ttl: claim.record.ttl,
          }
        : undefined,
    ).toEqual({
      expiresAt: "2026-07-28T00:10:00.000Z",
      ownerTable: "identity",
      ttl: 1_785_197_400,
    });
  });

  test("regenerates device and user codes after a uniqueness conflict", async () => {
    const client = deviceClient();
    const transactions: TransactionOperation[][] = [];
    let randomCalls = 0;
    let idCalls = 0;
    const application = makeDeviceApplication(
      {
        generateId: () => [ID, SESSION_ID][idCalls++]!,
        now: () => new Date(NOW),
        random: { bytes: (length) => new Uint8Array(length).fill(++randomCalls) },
        repository: {
          clientForId: () => Promise.resolve(client),
          transact: (operations: readonly TransactionOperation[]) => {
            transactions.push([...operations]);
            return transactions.length === 1
              ? Promise.reject(
                  new DatabaseError({
                    cause: new Error("ConditionalCheckFailedException"),
                    message: "User-code collision.",
                    operation: "transact-write",
                    reason: "conflict",
                    table: "multiple",
                  }),
                )
              : Promise.resolve();
          },
        } as unknown as IdentityRepository,
        signer: { jwks: async () => ({ keys: [] }), sign: async () => "signed" },
      },
      {
        accessTokenSeconds: 600,
        applicationOrigin: "https://app.deployments.ai",
        deviceLifetimeSeconds: 600,
        issuer: "https://auth.deployments.ai",
        pollingIntervalSeconds: 5,
        refreshTokenSeconds: 2_592_000,
        resourceAudience: "https://api.deployments.ai",
      },
    );

    expect(
      application.authorize({
        clientId: "deployments-cli",
        scopes: ["offline_access", "organizations:read"],
      }),
    ).resolves.toMatchObject({ expires_in: 600 });

    expect(transactions).toHaveLength(2);
    const grants = transactions.map((operations) =>
      operations.find(
        (operation) =>
          operation.kind === "put" && operation.record.itemType === "oauth-device-grant",
      ),
    );
    const first = grants[0]?.kind === "put" ? grants[0].record : undefined;
    const second = grants[1]?.kind === "put" ? grants[1].record : undefined;
    expect(first?.itemType).toBe("oauth-device-grant");
    expect(second?.itemType).toBe("oauth-device-grant");
    expect(
      first?.itemType === "oauth-device-grant" ? first.data.deviceCodeHash : undefined,
    ).not.toBe(second?.itemType === "oauth-device-grant" ? second.data.deviceCodeHash : undefined);
    expect(first?.itemType === "oauth-device-grant" ? first.data.userCodeHash : undefined).not.toBe(
      second?.itemType === "oauth-device-grant" ? second.data.userCodeHash : undefined,
    );
  });

  test("recovers a claim committed by the same browser before a conflicted response", async () => {
    const client = deviceClient();
    let grant: IdentityRecord<"oauth-device-grant"> = deviceGrantRecord({
      clientId: "deployments-cli",
      createdAt: NOW,
      deviceCodeHash: "device-code-hash",
      expiresAt: "2026-07-28T01:00:00.000Z",
      id: ID,
      pollingIntervalSeconds: 5,
      requestedScopes: ["offline_access", "organizations:read"],
      userCodeHash: "user-code-hash",
    });
    let transactions = 0;
    const application = makeDeviceApplication(
      {
        generateId: () => ID,
        now: () => new Date(NOW),
        repository: {
          clientForId: () => Promise.resolve(client),
          deviceGrantForKey: () => Promise.resolve(grant),
          principalForId: () => Promise.resolve(undefined),
          transact: (operations: readonly TransactionOperation[]) => {
            transactions += 1;
            const write = operations.find(
              (operation) =>
                operation.kind === "put" && operation.record.itemType === "oauth-device-grant",
            );
            if (write?.kind === "put" && write.record.itemType === "oauth-device-grant") {
              grant = write.record;
            }
            return Promise.reject(
              new DatabaseError({
                cause: new Error("TransactionConflictException"),
                message: "The claim committed before the response was lost.",
                operation: "transact-write",
                reason: "conflict",
                table: "multiple",
              }),
            );
          },
          userCodeClaim: () =>
            Promise.resolve({
              data: {
                expiresAt: grant.data.expiresAt,
                ownerPk: grant.pk,
                ownerSk: grant.sk,
              },
            } as never),
        } as unknown as IdentityRepository,
        signer: { jwks: async () => ({ keys: [] }), sign: async () => "signed" },
      },
      {
        accessTokenSeconds: 600,
        applicationOrigin: "https://app.deployments.ai",
        deviceLifetimeSeconds: 600,
        issuer: "https://auth.deployments.ai",
        pollingIntervalSeconds: 5,
        refreshTokenSeconds: 2_592_000,
        resourceAudience: "https://api.deployments.ai",
      },
    );
    const browser = { principalId: ID, sessionId: SESSION_ID };

    expect(application.claim("ABCD-EFGH", browser)).resolves.toMatchObject({
      clientId: "deployments-cli",
      requestedScopes: ["offline_access", "organizations:read"],
    });
    expect(application.claim("ABCD-EFGH", browser)).resolves.toMatchObject({
      clientId: "deployments-cli",
    });
    expect(transactions).toBe(1);
  });

  test("reloads an approval that wins a pending-poll write race", async () => {
    const client = deviceClient();
    const principal = principalRecord({ createdAt: NOW, id: ID, primaryEmail: "user@example.com" });
    let securityState = securityStateRecord({
      createdAt: NOW,
      credentialVersion: 1,
      emailVerifiedAt: NOW,
      principalId: ID,
      sessionEpoch: 0,
      version: 1,
    });
    let grant: IdentityRecord<"oauth-device-grant"> = claimedGrant();
    let conflicted = false;
    let consumeConflicted = false;
    const application = makeDeviceApplication(
      {
        generateId: () => ID,
        now: () => new Date(NOW),
        random: { bytes: (length) => new Uint8Array(length).fill(8) },
        repository: {
          clientForId: () => Promise.resolve(client),
          deviceGrantForHash: () => Promise.resolve(grant),
          loadLoginMaterial: () =>
            Promise.resolve({ credential: undefined, principal, securityState }),
          loginMaterialVersionChecks: () => [],
          transact: (operations: readonly TransactionOperation[]) => {
            const write = operations.find(
              (operation) =>
                operation.kind === "put" && operation.record.itemType === "oauth-device-grant",
            );
            if (
              !conflicted &&
              write?.kind === "put" &&
              write.record.itemType === "oauth-device-grant" &&
              write.record.data.status === "claimed"
            ) {
              conflicted = true;
              grant = {
                ...grant,
                data: {
                  ...grant.data,
                  approvedAt: NOW,
                  approvedSessionEpoch: 0,
                  authenticationTime: NOW,
                  status: "approved",
                  version: grant.data.version + 1,
                },
              };
              return Promise.reject(
                new DatabaseError({
                  cause: new Error("ConditionalCheckFailedException"),
                  message: "Approval won the race.",
                  operation: "transact-write",
                  reason: "conflict",
                  table: "multiple",
                }),
              );
            }
            if (
              !consumeConflicted &&
              write?.kind === "put" &&
              write.record.itemType === "oauth-device-grant" &&
              write.record.data.status === "consumed"
            ) {
              consumeConflicted = true;
              securityState = {
                ...securityState,
                data: { ...securityState.data, version: securityState.data.version + 1 },
              };
              return Promise.reject(
                new DatabaseError({
                  cause: new Error("ConditionalCheckFailedException"),
                  message: "Security telemetry changed concurrently.",
                  operation: "transact-write",
                  reason: "conflict",
                  table: "multiple",
                }),
              );
            }
            if (write?.kind === "put" && write.record.itemType === "oauth-device-grant") {
              grant = write.record;
            }
            return Promise.resolve();
          },
        } as unknown as IdentityRepository,
        signer: { jwks: async () => ({ keys: [] }), sign: async () => "signed" },
      },
      {
        accessTokenSeconds: 600,
        applicationOrigin: "https://app.deployments.ai",
        deviceLifetimeSeconds: 600,
        issuer: "https://auth.deployments.ai",
        pollingIntervalSeconds: 5,
        refreshTokenSeconds: 2_592_000,
        resourceAudience: "https://api.deployments.ai",
      },
    );

    const tokens = await application.poll({
      clientId: "deployments-cli",
      deviceCode: "raw-device-code",
    });

    expect(conflicted).toBeTrue();
    expect(consumeConflicted).toBeTrue();
    expect(tokens.access_token).toBe("signed");
    expect(grant.data.status).toBe("consumed");
  });

  test("persists increased backoff after a concurrent pending poll", async () => {
    const client = deviceClient();
    let grant: IdentityRecord<"oauth-device-grant"> = claimedGrant();
    let attempts = 0;
    const application = makeDeviceApplication(
      {
        generateId: () => ID,
        now: () => new Date(NOW),
        repository: {
          clientForId: () => Promise.resolve(client),
          deviceGrantForHash: () => Promise.resolve(grant),
          transact: (operations: readonly TransactionOperation[]) => {
            const write = operations.find(
              (operation) =>
                operation.kind === "put" && operation.record.itemType === "oauth-device-grant",
            );
            attempts += 1;
            if (attempts === 1) {
              grant = {
                ...grant,
                data: {
                  ...grant.data,
                  lastPolledAt: NOW,
                  nextPollAt: "2026-07-28T00:00:05.000Z",
                  version: grant.data.version + 1,
                },
              };
              return Promise.reject(
                new DatabaseError({
                  cause: new Error("ConditionalCheckFailedException"),
                  message: "Another poll won the race.",
                  operation: "transact-write",
                  reason: "conflict",
                  table: "multiple",
                }),
              );
            }
            if (write?.kind === "put" && write.record.itemType === "oauth-device-grant") {
              grant = write.record;
            }
            return Promise.resolve();
          },
        } as unknown as IdentityRepository,
        signer: { jwks: async () => ({ keys: [] }), sign: async () => "signed" },
      },
      {
        accessTokenSeconds: 600,
        applicationOrigin: "https://app.deployments.ai",
        deviceLifetimeSeconds: 600,
        issuer: "https://auth.deployments.ai",
        pollingIntervalSeconds: 5,
        refreshTokenSeconds: 2_592_000,
        resourceAudience: "https://api.deployments.ai",
      },
    );

    expect(
      application.poll({ clientId: "deployments-cli", deviceCode: "raw-device-code" }),
    ).rejects.toMatchObject({ code: "slow_down" });
    expect(attempts).toBe(2);
    expect(grant.data.pollingIntervalSeconds).toBe(10);
    expect(grant.data.nextPollAt).toBe("2026-07-28T00:00:10.000Z");
  });

  test("does not create a refresh credential without offline_access", async () => {
    const client = deviceClient();
    const principal = principalRecord({
      createdAt: NOW,
      id: ID,
      primaryEmail: "user@example.com",
    });
    const securityState = securityStateRecord({
      createdAt: NOW,
      credentialVersion: 1,
      emailVerifiedAt: NOW,
      principalId: ID,
      sessionEpoch: 0,
      version: 1,
    });
    const claimed = claimedGrant(["organizations:read"]);
    let grant: IdentityRecord<"oauth-device-grant"> = {
      ...claimed,
      data: {
        ...claimed.data,
        approvedAt: NOW,
        approvedSessionEpoch: 0,
        authenticationTime: NOW,
        status: "approved",
        version: claimed.data.version + 1,
      },
    };
    const transactions: TransactionOperation[][] = [];
    const application = makeDeviceApplication(
      {
        generateId: () => ID,
        now: () => new Date(NOW),
        repository: {
          clientForId: () => Promise.resolve(client),
          deviceGrantForHash: () => Promise.resolve(grant),
          loadLoginMaterial: () =>
            Promise.resolve({ credential: undefined, principal, securityState }),
          loginMaterialVersionChecks: () => [],
          transact: (operations: readonly TransactionOperation[]) => {
            transactions.push([...operations]);
            const write = operations.find(
              (operation) =>
                operation.kind === "put" && operation.record.itemType === "oauth-device-grant",
            );
            if (write?.kind === "put" && write.record.itemType === "oauth-device-grant") {
              grant = write.record;
            }
            return Promise.resolve();
          },
        } as unknown as IdentityRepository,
        signer: { jwks: async () => ({ keys: [] }), sign: async () => "signed" },
      },
      {
        accessTokenSeconds: 600,
        applicationOrigin: "https://app.deployments.ai",
        deviceLifetimeSeconds: 600,
        issuer: "https://auth.deployments.ai",
        pollingIntervalSeconds: 5,
        refreshTokenSeconds: 2_592_000,
        resourceAudience: "https://api.deployments.ai",
      },
    );

    const tokens = await application.poll({
      clientId: "deployments-cli",
      deviceCode: "raw-device-code",
    });

    expect(tokens).not.toHaveProperty("refresh_token");
    expect(
      transactions[0]?.some(
        (operation) =>
          operation.kind === "put" &&
          (operation.record.itemType === "oauth-refresh-family" ||
            operation.record.itemType === "oauth-refresh-token"),
      ),
    ).toBeFalse();
  });

  test("rejects an approved grant whose scope is no longer registered", async () => {
    const client = oauthClientRecord({
      allowedScopes: ["organizations:read"],
      clientId: "deployments-cli",
      createdAt: NOW,
      grantTypes: ["urn:ietf:params:oauth:grant-type:device_code"],
      name: "Deployments CLI",
      redirectUris: ["http://127.0.0.1/callback"],
      requiredScopes: [],
      tokenEndpointAuthMethod: "none",
      type: "public",
      version: 2,
    });
    const principal = principalRecord({
      createdAt: NOW,
      id: ID,
      primaryEmail: "user@example.com",
    });
    const securityState = securityStateRecord({
      createdAt: NOW,
      credentialVersion: 1,
      emailVerifiedAt: NOW,
      principalId: ID,
      sessionEpoch: 0,
      version: 1,
    });
    const claimed = claimedGrant();
    const grant: IdentityRecord<"oauth-device-grant"> = {
      ...claimed,
      data: {
        ...claimed.data,
        approvedAt: NOW,
        approvedSessionEpoch: 0,
        authenticationTime: NOW,
        status: "approved",
        version: claimed.data.version + 1,
      },
    };
    const application = makeDeviceApplication(
      {
        generateId: () => ID,
        now: () => new Date(NOW),
        repository: {
          clientForId: () => Promise.resolve(client),
          deviceGrantForHash: () => Promise.resolve(grant),
          loadLoginMaterial: () =>
            Promise.resolve({ credential: undefined, principal, securityState }),
          loginMaterialVersionChecks: () => [],
          transact: () => Promise.reject("A rejected grant must not be consumed."),
        } as unknown as IdentityRepository,
        signer: {
          jwks: async () => ({ keys: [] }),
          sign: async () => {
            throw new Error("A rejected grant must not be signed.");
          },
        },
      },
      {
        accessTokenSeconds: 600,
        applicationOrigin: "https://app.deployments.ai",
        deviceLifetimeSeconds: 600,
        issuer: "https://auth.deployments.ai",
        pollingIntervalSeconds: 5,
        refreshTokenSeconds: 2_592_000,
        resourceAudience: "https://api.deployments.ai",
      },
    );

    expect(
      application.poll({ clientId: "deployments-cli", deviceCode: "raw-device-code" }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
  });

  test("retries approval after a concurrent poll advances the grant version", async () => {
    const client = deviceClient();
    const principal = principalRecord({ createdAt: NOW, id: ID, primaryEmail: "user@example.com" });
    const security = securityStateRecord({
      createdAt: NOW,
      credentialVersion: 1,
      emailVerifiedAt: NOW,
      principalId: ID,
      sessionEpoch: 0,
      version: 1,
    });
    const { locator, session } = sessionRecords({
      authentication: { method: "password" },
      authenticationTime: NOW,
      createdAt: NOW,
      expiresAt: "2026-07-28T01:00:00.000Z",
      id: SESSION_ID,
      idleExpiresAt: "2026-07-28T00:30:00.000Z",
      principalId: ID,
      sessionEpoch: 0,
      tokenHash: "session-token-hash",
    });
    let grant: IdentityRecord<"oauth-device-grant"> = claimedGrant();
    let attempts = 0;
    const application = makeDeviceApplication(
      {
        generateId: () => ID,
        now: () => new Date(NOW),
        repository: {
          browserSessionVersionChecks: () => [],
          clientForId: () => Promise.resolve(client),
          deviceGrantForKey: () => Promise.resolve(grant),
          loginMaterialVersionChecks: () => [],
          principalForId: () => Promise.resolve(principal),
          securityStateForPrincipal: () => Promise.resolve(security),
          sessionForHash: () => Promise.resolve(session),
          sessionLocator: () => Promise.resolve(locator),
          transact: (operations: readonly TransactionOperation[]) => {
            const write = operations.find(
              (operation) =>
                operation.kind === "put" && operation.record.itemType === "oauth-device-grant",
            );
            attempts += 1;
            if (attempts === 1) {
              grant = {
                ...grant,
                data: {
                  ...grant.data,
                  lastPolledAt: NOW,
                  nextPollAt: "2026-07-28T00:00:05.000Z",
                  version: grant.data.version + 1,
                },
              };
              return Promise.reject(
                new DatabaseError({
                  cause: new Error("ConditionalCheckFailedException"),
                  message: "Poll won the race.",
                  operation: "transact-write",
                  reason: "conflict",
                  table: "multiple",
                }),
              );
            }
            if (write?.kind === "put" && write.record.itemType === "oauth-device-grant") {
              grant = write.record;
            }
            return Promise.resolve();
          },
          userCodeClaim: () =>
            Promise.resolve({ data: { ownerPk: grant.pk, ownerSk: grant.sk } } as never),
        } as unknown as IdentityRepository,
        signer: { jwks: async () => ({ keys: [] }), sign: async () => "signed" },
      },
      {
        accessTokenSeconds: 600,
        applicationOrigin: "https://app.deployments.ai",
        deviceLifetimeSeconds: 600,
        issuer: "https://auth.deployments.ai",
        pollingIntervalSeconds: 5,
        refreshTokenSeconds: 2_592_000,
        resourceAudience: "https://api.deployments.ai",
      },
    );

    await application.decide("ABCD-EFGH", { principalId: ID, sessionId: SESSION_ID }, "approved");

    expect(attempts).toBe(2);
    expect(grant.data.status).toBe("approved");
  });
});
