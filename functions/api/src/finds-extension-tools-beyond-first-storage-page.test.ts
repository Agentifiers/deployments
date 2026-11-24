import {
  PersistenceError,
  ToolAdapterRecord,
  ToolPolicyRecord,
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
import {
  makeAdministrationPersistence,
  type AdministrationCredentialPort,
  type AdministrationEnvironment,
  type AdministrationInvocation,
} from "./administration-persistence.ts";

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
  test("finds extension tools beyond the first storage page", async () => {
    const fixtureValue = fixture();
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const generatedId = (value: number) => {
      let suffix = "";
      let remaining = value;
      for (let index = 0; index < 3; index += 1) {
        suffix = alphabet[remaining % alphabet.length]! + suffix;
        remaining = Math.floor(remaining / alphabet.length);
      }
      return `01ARZ3NDEKTSV4RRFFQ69G5${suffix}` as Ulid;
    };
    for (let index = 0; index < 101; index += 1) {
      fixtureValue.put(
        Schema.decodeUnknownSync(ToolAdapterRecord)(
          withCanonicalRecordKeys({
            itemType: "tool-adapter",
            data: {
              createdAt: "2026-07-26T12:00:00.000Z",
              defaultPolicyAction: "deny",
              description: `Paged extension ${index}`,
              effect: "read",
              environmentId: ENVIRONMENT_ID,
              execution: {
                completionMode: "sync",
                endpointOrigin: "https://callbacks.example.com",
                endpointPath: "/read",
                type: "http_callback",
              },
              id: generatedId(index),
              inputSchema: { type: "object" },
              name: `custom.paged_${String(index).padStart(3, "0")}`,
              organizationId: ORGANIZATION_ID,
              projectId: PROJECT_ID,
              requiredScopes: [],
              status: "active",
              updatedAt: "2026-07-26T12:00:00.000Z",
              version: 0,
            },
          }),
        ),
      );
    }
    const result = await fixtureValue.service.invoke("getExtensionTool", {
      ...invocation(undefined),
      id: "custom.paged_100",
      params: { toolName: "custom.paged_100" },
    });
    expect(result).toMatchObject({ name: "custom.paged_100" });
  });

  test("resolves the active extension after an archived name is reused", async () => {
    const fixtureValue = fixture();
    const body = {
      callbackSecret: "callback-secret",
      defaultPolicyAction: "deny",
      description: "Original extension",
      effect: "read",
      execution: {
        completionMode: "sync",
        endpointOrigin: "https://callbacks.example.com",
        endpointPath: "/read",
        type: "http_callback",
      },
      inputSchema: { type: "object" },
      name: "custom.reused",
      providerKey: "github",
      requiredScopes: [],
    };
    const original = (await fixtureValue.service.invoke(
      "createExtensionTool",
      invocation(body),
    )) as { readonly id: string };
    await fixtureValue.service.invoke("archiveExtensionTool", {
      ...invocation({ expectedVersion: 0 }),
      id: body.name,
      params: { toolName: body.name },
    });
    const replacement = (await fixtureValue.service.invoke(
      "createExtensionTool",
      invocation({ ...body, description: "Replacement extension" }),
    )) as { readonly id: string };

    expect(
      fixtureValue.service.invoke("getExtensionTool", {
        ...invocation(undefined),
        id: body.name,
        params: { toolName: body.name },
      }),
    ).resolves.toMatchObject({
      description: "Replacement extension",
      id: replacement.id,
      status: "active",
    });
    expect(replacement.id).not.toBe(original.id);
  });

  test("excludes legacy built-in adapters from extension endpoints", async () => {
    const fixtureValue = fixture();
    fixtureValue.put(
      Schema.decodeUnknownSync(ToolAdapterRecord)(
        withCanonicalRecordKeys({
          itemType: "tool-adapter",
          data: {
            createdAt: "2026-07-26T12:00:00.000Z",
            effect: "read",
            environmentId: ENVIRONMENT_ID,
            execution: {
              adapterKey: "shopify.products.search",
              defaultPolicyAction: "deny",
              description: "Legacy built-in adapter",
              inputSchema: { type: "object" },
              type: "builtin",
            },
            id: IDS[0],
            name: "shopify.products.search",
            organizationId: ORGANIZATION_ID,
            projectId: PROJECT_ID,
            requiredScopes: ["read_products"],
            status: "active",
            updatedAt: "2026-07-26T12:00:00.000Z",
            version: 1,
          },
        }),
      ),
    );
    expect(
      fixtureValue.service.invoke("listExtensionTools", invocation(undefined)),
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(
      fixtureValue.service.invoke("getExtensionTool", {
        ...invocation(undefined),
        id: "shopify.products.search",
        params: { toolName: "shopify.products.search" },
      }),
    ).rejects.toMatchObject({ code: "resource_not_found" });
  });

  test("rejects stale policy updates", async () => {
    const { service } = fixture();
    const policy = (await service.invoke(
      "createToolPolicy",
      invocation({
        name: "Default runtime",
        policy: { defaultAction: "deny", rules: [] },
      }),
    )) as { readonly id: string };
    expect(
      service.invoke(
        "updateToolPolicy",
        invocation(
          {
            expectedVersion: 7,
            name: "Stale update",
          },
          policy.id,
        ),
      ),
    ).rejects.toBeInstanceOf(PersistenceError);
  });

  test("updates legacy array-based tool policies without dropping their rules", async () => {
    const fixtureValue = fixture();
    const policy = Schema.decodeUnknownSync(ToolPolicyRecord)(
      withCanonicalRecordKeys({
        itemType: "tool-policy",
        data: {
          createdAt: "2026-07-26T12:00:00.000Z",
          environmentId: ENVIRONMENT_ID,
          id: IDS[0],
          name: "Legacy runtime",
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          rules: [{ action: "allow", toolName: "shopify.products.search" }],
          status: "active",
          updatedAt: "2026-07-26T12:00:00.000Z",
          version: 0,
        },
      }),
    );
    fixtureValue.put(policy);

    expect(
      fixtureValue.service.invoke(
        "updateToolPolicy",
        invocation(
          {
            description: "Migrated policy",
            expectedVersion: 0,
          },
          policy.data.id,
        ),
      ),
    ).resolves.toMatchObject({
      description: "Migrated policy",
      policy: {
        rules: [{ action: "allow", toolName: "shopify.products.search" }],
      },
      version: 1,
    });
  });
});
