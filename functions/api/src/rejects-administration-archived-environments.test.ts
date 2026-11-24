import { CredentialVaultError } from "@deployments-ai/credential-vault";
import {
  WorkspaceRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type QueryRecordsResult,
  type TableName,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { createAdministrationApi } from "./administration-api.ts";
import {
  makeAdministrationPersistence,
  type AdministrationCredentialPort,
  type AdministrationEnvironment,
  type AdministrationInvocation,
} from "./administration-persistence.ts";
import { AdministrationProviderVerificationError } from "./provider-verification.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const WORKSPACE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as Ulid;
const IDS = [
  "01ARZ3NDEKTSV4RRFFQ69G5FB0",
  "01ARZ3NDEKTSV4RRFFQ69G5FB1",
  "01ARZ3NDEKTSV4RRFFQ69G5FB2",
  "01ARZ3NDEKTSV4RRFFQ69G5FB3",
  "01ARZ3NDEKTSV4RRFFQ69G5FB4",
  "01ARZ3NDEKTSV4RRFFQ69G5FB5",
  "01ARZ3NDEKTSV4RRFFQ69G5FB6",
  "01ARZ3NDEKTSV4RRFFQ69G5FB7",
] as unknown as readonly Ulid[];

const scope: AdministrationEnvironment = {
  id: ENVIRONMENT_ID,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  status: "active",
};

function storageKey(table: TableName, key: { readonly pk: string; readonly sk: string }) {
  return `${table}\u0000${key.pk}\u0000${key.sk}`;
}

function memoryDatabase() {
  const records = new Map<string, PlatformRecord>();
  const queryInputs: unknown[] = [];
  const transactionInputs: (readonly TransactionOperation[])[] = [];
  let transactionFailure: ((operations: readonly TransactionOperation[]) => boolean) | undefined;
  const put = (record: PlatformRecord) =>
    records.set(storageKey(tableForItemType(record.itemType), record), structuredClone(record));
  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => {
      records.delete(storageKey(tableForItemType(record.itemType), record));
    },
    getRecord: async (table, key) => {
      const record = records.get(storageKey(table, key));
      return record ? structuredClone(record) : undefined;
    },
    putRecord: async (record) => {
      put(record);
    },
    queryRecords: async (table, input) => {
      queryInputs.push(structuredClone(input));
      const values = input.ExpressionAttributeValues as Record<string, unknown>;
      const names = input.ExpressionAttributeNames as Record<string, string> | undefined;
      const partitionName =
        names?.["#partition"] ?? (input.IndexName ? `${input.IndexName}pk` : "pk");
      const sortName = names?.["#sort"] ?? (input.IndexName ? `${input.IndexName}sk` : "sk");
      const partition = values[":partition"];
      const prefix = String(values[":prefix"]);
      const matching = [...records.values()]
        .filter((record) => tableForItemType(record.itemType) === table)
        .filter(
          (record) =>
            (record as unknown as Record<string, unknown>)[partitionName] === partition &&
            String((record as unknown as Record<string, unknown>)[sortName]).startsWith(prefix),
        );
      const startIndex = input.ExclusiveStartKey
        ? matching.findIndex(
            (record) =>
              record.pk === input.ExclusiveStartKey?.pk &&
              record.sk === input.ExclusiveStartKey?.sk,
          ) + 1
        : 0;
      const page = matching.slice(startIndex, startIndex + (input.Limit ?? 50));
      const items = page.map((record) => structuredClone(record));
      const hasMore = startIndex + page.length < matching.length;
      return {
        items,
        ...(hasMore && page.at(-1)
          ? {
              lastEvaluatedKey: structuredClone(page.at(-1) as unknown as Record<string, unknown>),
            }
          : {}),
      } satisfies QueryRecordsResult;
    },
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      transactionInputs.push(structuredClone(operations));
      if (transactionFailure?.(operations)) {
        transactionFailure = undefined;
        throw new Error("injected transaction failure");
      }
      for (const operation of operations) {
        if (operation.kind !== "put") continue;
        const existing = records.get(
          storageKey(tableForItemType(operation.record.itemType), operation.record),
        );
        if (!operation.previousRecord && !operation.allowExisting && existing) {
          throw new Error("conditional conflict");
        }
      }
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        if (operation.kind === "delete") {
          records.delete(storageKey(tableForItemType(operation.record.itemType), operation.record));
        } else {
          put(operation.record);
        }
      }
    },
  };
  return {
    database,
    failNextTransactionMatching: (
      predicate: (operations: readonly TransactionOperation[]) => boolean,
    ) => {
      transactionFailure = predicate;
    },
    put,
    queryInputs,
    records,
    transactionInputs,
  };
}

function invocation(body: unknown, id?: string): AdministrationInvocation {
  return {
    body,
    ...(id ? { id, params: { id } } : { params: {} }),
    identity: {
      environmentIds: [ENVIRONMENT_ID],
      organizationIds: [ORGANIZATION_ID],
      principalId: PRINCIPAL_ID,
      projectIds: [PROJECT_ID],
      scopes: ["administration:write"],
    },
    idempotencyKey: "request-key",
    query: {},
    scope: { environmentId: ENVIRONMENT_ID },
  };
}

function fixture(environmentStatus = "active") {
  const store = memoryDatabase();
  let nextId = 0;
  const secrets = new Map<string, Readonly<Record<string, string>>>();
  const credentialReads: Parameters<AdministrationCredentialPort["read"]>[0][] = [];
  const credentialWrites: Parameters<AdministrationCredentialPort["prepareWrite"]>[0][] = [];
  let credentialReadFailure: unknown;
  const credentials: AdministrationCredentialPort = {
    prepareRevoke: async (input) => ({
      operation: {
        allowExisting: true,
        kind: "put",
        record: {
          data: { id: input.reference.credentialId },
          itemType: "credential-vault-entry",
          pk: `vault#${input.reference.credentialId}`,
          sk: `vault#${input.reference.credentialId}`,
        } as unknown as PlatformRecord,
      },
      reference: input.reference,
    }),
    prepareWrite: async (input) => {
      credentialWrites.push(input);
      const generation = (input.expectedGeneration ?? -1) + 1;
      const reference = {
        credentialId: input.identity.credentialId,
        generation,
        store: "dynamodb-kms" as const,
      };
      secrets.set(input.identity.credentialId, input.secret.values);
      return {
        operation: {
          allowExisting: true,
          kind: "put",
          record: {
            data: { id: input.identity.credentialId },
            itemType: "credential-vault-entry",
            pk: `vault#${input.identity.credentialId}`,
            sk: `vault#${input.identity.credentialId}`,
          } as unknown as PlatformRecord,
        },
        reference,
      };
    },
    read: async (input) => {
      credentialReads.push(input);
      if (credentialReadFailure) throw credentialReadFailure;
      return { values: secrets.get(input.reference.credentialId) ?? {} };
    },
  };
  let discoveryInput: unknown;
  let providerVerificationFailure: unknown;
  let discoveryTools = [
    {
      description: "Allowed remote tool",
      inputSchema: { type: "object" },
      remoteName: "remote.allowed",
    },
  ];
  const service = makeAdministrationPersistence({
    credentials,
    database: store.database,
    generateId: async () => IDS[nextId++]!,
    mcpDiscovery: {
      discover: async (input) => {
        discoveryInput = input;
        return discoveryTools;
      },
    },
    now: () => new Date("2026-07-26T12:00:00.000Z"),
    providerVerification: {
      verify: async (input) => {
        if (providerVerificationFailure) throw providerVerificationFailure;
        return {
          externalAccountId: "verified-account",
          metadata: { method: input.definition.verification.method },
          scopes:
            input.definition.verification.method === "oauth_scopes"
              ? input.definition.defaultScopes
              : input.connection.scopes,
        };
      },
    },
    resolveEnvironment: async () => ({ ...scope, status: environmentStatus }),
    resolveWorkspace: async (_environment, workspaceId) => workspaceId === WORKSPACE_ID,
  });
  return {
    ...store,
    credentialReads,
    credentialWrites,
    getDiscoveryInput: () => discoveryInput,
    service,
    setProviderVerificationFailure: (cause: unknown) => {
      providerVerificationFailure = cause;
    },
    setCredentialReadFailure: (cause: unknown) => {
      credentialReadFailure = cause;
    },
    setDiscoveryTools: (tools: typeof discoveryTools) => {
      discoveryTools = tools;
    },
    setSecret: (credentialId: Ulid, values: Readonly<Record<string, string>>) =>
      secrets.set(credentialId, values),
  };
}

describe("administration persistence", () => {
  test("rejects administration in archived environments", async () => {
    const { service } = fixture("archived");
    expect(
      service.invoke(
        "createProviderCredential",
        invocation({
          credential: { apiKey: "secret" },
          displayName: "Rewardful",
          providerKey: "rewardful",
        }),
      ),
    ).rejects.toMatchObject({ code: "environment_inactive" });
  });

  test("preserves the validated provider credential display name over metadata", async () => {
    const { records, service } = fixture();
    const connection = (await service.invoke(
      "createProviderCredential",
      invocation({
        credential: { apiKey: "secret" },
        displayName: "Rewardful production",
        metadata: { displayName: "", region: "us" },
        providerKey: "rewardful",
      }),
    )) as Record<string, unknown> & { readonly id: Ulid };

    expect(connection).toMatchObject({ displayName: "Rewardful production" });
    const stored = [...records.values()].find(
      (record) => record.itemType === "provider-connection" && record.data.id === connection.id,
    ) as Extract<PlatformRecord, { readonly itemType: "provider-connection" }>;
    expect(stored.data.displayMetadata).toEqual({
      displayName: "Rewardful production",
      region: "us",
    });
  });

  test("stores OAuth application secrets through the vault and returns a secret-safe projection", async () => {
    const { credentialWrites, service, records } = fixture();
    const result = (await service.invoke(
      "createProviderApplication",
      invocation({
        clientId: "client-id",
        clientSecret: "never-return-this",
        credential: { googleAdsDeveloperToken: "developer-secret" },
        displayName: "GitHub production",
        providerKey: "github",
        redirectUris: ["https://app.example/oauth/callback"],
        requestedScopes: ["repo"],
      }),
    )) as Record<string, unknown> & { readonly id: Ulid; readonly version: number };

    expect(result).toMatchObject({ hasClientSecret: true, providerKey: "github", version: 0 });
    expect(JSON.stringify(result)).not.toContain("never-return-this");
    expect(JSON.stringify(result)).not.toContain("clientSecretRef");
    expect(
      [...records.values()].some((record) => record.itemType === "credential-vault-entry"),
    ).toBe(true);
    await service.invoke(
      "rotateProviderApplicationSecret",
      invocation(
        {
          clientSecret: "replacement-secret",
          expectedVersion: result.version,
        },
        result.id,
      ),
    );
    expect(credentialWrites.at(-1)?.secret.values).toEqual({
      clientSecret: "replacement-secret",
      googleAdsDeveloperToken: "developer-secret",
    });
  });

  test("uses a consistent read when auto-selecting an OAuth application", async () => {
    const { queryInputs, service } = fixture();
    await service.invoke(
      "createProviderApplication",
      invocation({
        clientId: "client-id",
        clientSecret: "client-secret",
        displayName: "Search Console production",
        providerKey: "google_search_console",
        redirectUris: ["https://app.example/oauth/callback"],
        requestedScopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
      }),
    );

    expect(
      service.invoke(
        "beginProviderAuthorization",
        invocation({
          providerKey: "google_search_console",
          requestedScopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
        }),
      ),
    ).rejects.toMatchObject({ code: "oauth_provider_unconfigured" });
    expect(queryInputs.at(-1)).toMatchObject({
      ConsistentRead: true,
      ExpressionAttributeValues: {
        ":partition": `ORG#${ORGANIZATION_ID}#ENV#${ENVIRONMENT_ID}`,
        ":prefix": "PROVIDER-APPLICATION#",
      },
    });
    expect(queryInputs.at(-1)).not.toHaveProperty("IndexName");
  });

  test("decodes mutation responses at the HTTP boundary without leaking tenant fields", async () => {
    const { service } = fixture();
    const fetch = createAdministrationApi({
      authenticate: async () => ({
        environmentIds: [ENVIRONMENT_ID],
        organizationIds: [ORGANIZATION_ID],
        principalId: PRINCIPAL_ID,
        projectIds: [PROJECT_ID],
        scopes: ["platform:admin"],
      }),
      authorize: async () => undefined,
      idempotency: { execute: async (input) => input.operation() },
      requestId: () => "projection_test",
      service,
    });
    const response = await fetch(
      new Request("https://api.example/v1/oauth-apps", {
        body: JSON.stringify({
          clientId: "client-id",
          clientSecret: "never-return-this",
          displayName: "GitHub production",
          providerKey: "github",
          redirectUris: ["https://app.example/oauth/callback"],
          requestedScopes: ["repo"],
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "projection-key",
          "x-deployments-environment": ENVIRONMENT_ID,
        },
        method: "POST",
      }),
    );
    expect(response?.status).toBe(201);
    const result = (await response!.json()) as Record<string, unknown>;
    expect(result).toMatchObject({ hasClientSecret: true, providerKey: "github" });
    for (const field of ["clientSecretRef", "environmentId", "organizationId", "projectId"]) {
      expect(result).not.toHaveProperty(field);
    }
  });

  test("verifies a provider credential, persists capabilities, and grants only reduced scopes", async () => {
    const { failNextTransactionMatching, queryInputs, service, put } = fixture();
    const connection = (await service.invoke(
      "createProviderCredential",
      invocation({
        credential: { apiKey: "secret" },
        displayName: "Rewardful",
        providerKey: "rewardful",
      }),
    )) as { readonly id: Ulid };
    put(
      Schema.decodeUnknownSync(WorkspaceRecord)(
        withCanonicalRecordKeys({
          itemType: "workspace",
          data: {
            createdAt: "2026-07-26T12:00:00.000Z",
            environmentId: ENVIRONMENT_ID,
            id: WORKSPACE_ID,
            name: "Production",
            organizationId: ORGANIZATION_ID,
            projectId: PROJECT_ID,
            slug: "production",
            status: "active",
            updatedAt: "2026-07-26T12:00:00.000Z",
            version: 0,
          },
        }),
      ),
    );

    const verification = await service.invoke(
      "requestConnectionVerification",
      invocation({}, connection.id),
    );
    expect(verification).toMatchObject({
      connectionId: connection.id,
      status: "verified",
      version: 1,
    });
    const capabilities = (await service.invoke(
      "listConnectionCapabilities",
      invocation(undefined, connection.id),
    )) as { readonly items: readonly Record<string, unknown>[] };
    expect(capabilities.items).toEqual([
      expect.objectContaining({
        connectionId: connection.id,
        scopes: ["affiliates:read", "referrals:read"],
        status: "active",
        verificationVersion: 1,
      }),
    ]);

    const grant = await service.invoke(
      "createConnectionGrant",
      invocation({
        connectionId: connection.id,
        externalResourceConstraints: { repositoryIds: ["repo-1"] },
        purpose: "agent-runtime",
        scopes: ["referrals:read"],
        workspaceId: WORKSPACE_ID,
      }),
    );
    expect(grant).toMatchObject({
      connectionId: connection.id,
      scopes: ["referrals:read"],
      workspaceId: WORKSPACE_ID,
    });

    expect(
      service.invoke(
        "createConnectionGrant",
        invocation({
          connectionId: connection.id,
          purpose: "agent-runtime",
          scopes: ["referrals:write"],
          workspaceId: WORKSPACE_ID,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_scope", kind: "unprocessable" });

    const rotationInvocation = invocation(
      {
        credential: { apiKey: "replacement-secret" },
        expectedVersion: 1,
      },
      connection.id,
    );
    failNextTransactionMatching((operations) =>
      operations.some(
        (operation) =>
          operation.kind === "put" &&
          operation.record.itemType === "workspace-connection-authorization",
      ),
    );
    expect(service.invoke("rotateProviderCredential", rotationInvocation)).rejects.toMatchObject({
      code: "persistence_error",
    });
    expect(
      service.invoke("getProviderConnection", invocation(undefined, connection.id)),
    ).resolves.toMatchObject({ status: "reauthorization-required", version: 2 });
    expect(
      service.invoke("requestConnectionVerification", invocation(undefined, connection.id)),
    ).rejects.toMatchObject({ code: "connection_not_verifiable" });
    expect(
      service.invoke("rotateProviderCredential", {
        ...invocation(
          {
            credential: { apiKey: "different-replacement-secret" },
            expectedVersion: 2,
          },
          connection.id,
        ),
        idempotencyKey: "different-rotation-key",
      }),
    ).rejects.toMatchObject({ code: "rotation_cleanup_pending" });
    expect(
      service.invoke(
        "rotateProviderCredential",
        invocation(
          {
            credential: { apiKey: "different-replacement-secret" },
            expectedVersion: 1,
          },
          connection.id,
        ),
      ),
    ).rejects.toMatchObject({ code: "rotation_cleanup_pending" });

    const rotated = await service.invoke("rotateProviderCredential", rotationInvocation);
    expect(rotated).toMatchObject({
      hasCredential: true,
      status: "reauthorization-required",
      version: 3,
    });
    expect(rotated).not.toHaveProperty("externalAccountId");
    expect(rotated).not.toHaveProperty("lastVerifiedAt");
    expect(queryInputs).toContainEqual(
      expect.objectContaining({
        ConsistentRead: true,
        KeyConditionExpression: "pk = :partition AND begins_with(sk, :prefix)",
      }),
    );
    const staleCapabilities = (await service.invoke(
      "listConnectionCapabilities",
      invocation(undefined, connection.id),
    )) as { readonly items: readonly Record<string, unknown>[] };
    expect(staleCapabilities.items).toEqual([expect.objectContaining({ status: "stale" })]);
    expect(
      service.invoke(
        "createConnectionGrant",
        invocation({
          connectionId: connection.id,
          purpose: "agent-runtime",
          scopes: ["referrals:read"],
          workspaceId: WORKSPACE_ID,
        }),
      ),
    ).rejects.toMatchObject({ code: "connection_inactive" });
  });

  test("invalidates capabilities after a definitive provider verification rejection", async () => {
    const fixtureValue = fixture();
    const connection = (await fixtureValue.service.invoke(
      "createProviderCredential",
      invocation({
        credential: { apiKey: "secret" },
        displayName: "Rewardful",
        providerKey: "rewardful",
      }),
    )) as { readonly id: string };
    await fixtureValue.service.invoke(
      "requestConnectionVerification",
      invocation(undefined, connection.id),
    );
    fixtureValue.setProviderVerificationFailure(
      new AdministrationProviderVerificationError("Provider returned HTTP 401.", 401),
    );
    await fixtureValue.service.invoke(
      "requestConnectionVerification",
      invocation(undefined, connection.id),
    );

    expect(
      fixtureValue.service.invoke("getProviderConnection", invocation(undefined, connection.id)),
    ).resolves.toMatchObject({ status: "reauthorization-required" });
    expect(
      fixtureValue.service.invoke(
        "listConnectionCapabilities",
        invocation(undefined, connection.id),
      ),
    ).resolves.toMatchObject({ items: [expect.objectContaining({ status: "stale" })] });
  });

  test("does not create a pending verification when credential loading fails", async () => {
    const fixtureValue = fixture();
    const connection = (await fixtureValue.service.invoke(
      "createProviderCredential",
      invocation({
        credential: { apiKey: "secret" },
        displayName: "Rewardful",
        providerKey: "rewardful",
      }),
    )) as { readonly id: string };
    fixtureValue.setCredentialReadFailure(
      new CredentialVaultError("revoked", "Credential was revoked."),
    );

    expect(
      fixtureValue.service.invoke(
        "requestConnectionVerification",
        invocation(undefined, connection.id),
      ),
    ).rejects.toMatchObject({ code: "credential_conflict" });
    expect(
      [...fixtureValue.records.values()].filter(
        (record) => record.itemType === "connection-verification",
      ),
    ).toEqual([]);
  });
});
