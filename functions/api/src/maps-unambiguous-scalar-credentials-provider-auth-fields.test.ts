import {
  ProviderConnectionRecord,
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
      if (input.KeyConditionExpression === "pk = :pk") {
        const matching = [...records.values()]
          .filter((record) => tableForItemType(record.itemType) === table)
          .filter((record) => record.pk === values[":pk"])
          .sort((left, right) => left.sk.localeCompare(right.sk));
        if (input.ScanIndexForward === false) matching.reverse();
        return {
          items: matching.slice(0, input.Limit ?? 50).map((record) => structuredClone(record)),
        } satisfies QueryRecordsResult;
      }
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
  test("creates verified credentialless callback connections for workspace grants", async () => {
    const fixtureValue = fixture();
    const connection = (await fixtureValue.service.invoke(
      "createProviderCredential",
      invocation({
        displayName: "Extension callbacks",
        providerKey: "extension_callback",
      }),
    )) as {
      readonly hasCredential: boolean;
      readonly id: Ulid;
      readonly scopes: readonly string[];
    };

    expect(connection).toMatchObject({
      hasCredential: false,
      scopes: expect.arrayContaining(["callback:action:execute", "callback:action:privileged"]),
    });
    expect(
      fixtureValue.service.invoke(
        "createProviderCredential",
        invocation({
          credential: "not-allowed",
          displayName: "Extension callbacks",
          providerKey: "extension_callback",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_secret" });
    for (const providerKey of ["rb2b", "shopify"]) {
      expect(
        fixtureValue.service.invoke(
          "createProviderCredential",
          invocation({ displayName: providerKey, providerKey }),
        ),
      ).rejects.toMatchObject({ code: "invalid_auth_method" });
    }
    expect(
      fixtureValue.service.invoke(
        "listConnectionCapabilities",
        invocation(undefined, connection.id),
      ),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          connectionId: connection.id,
          status: "active",
        }),
      ],
    });
    expect(
      fixtureValue.service.invoke("revokeProviderCredential", invocation({}, connection.id)),
    ).resolves.toMatchObject({ status: "disconnected" });
    expect(
      fixtureValue.transactionInputs.some((operations) =>
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "semantic-event" &&
            operation.record.data.eventType === "provider.connection.disconnected" &&
            operation.record.data.aggregateVersion === 2,
        ),
      ),
    ).toBeTrue();
  });

  test("maps unambiguous scalar credentials to provider auth fields", async () => {
    const fixtureValue = fixture();
    await fixtureValue.service.invoke(
      "createProviderCredential",
      invocation({
        credential: "rewardful-secret",
        displayName: "Rewardful",
        providerKey: "rewardful",
      }),
    );
    expect(fixtureValue.credentialWrites.at(-1)?.secret.values).toEqual({
      apiKey: "rewardful-secret",
    });
    expect(
      fixtureValue.service.invoke(
        "createProviderCredential",
        invocation({
          credential: "ambiguous-secret",
          displayName: "Demio",
          providerKey: "demio",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_secret" });
  });

  test("reads OAuth tokens with their vault purpose and maps provider scopes to capabilities", async () => {
    const fixtureValue = fixture();
    const credentialId = IDS[0]!;
    const connectionId = IDS[1]!;
    fixtureValue.setSecret(credentialId, { accessToken: "oauth-token" });
    fixtureValue.put(
      Schema.decodeUnknownSync(ProviderConnectionRecord)(
        withCanonicalRecordKeys({
          itemType: "provider-connection",
          data: {
            authMethod: "oauth",
            createdAt: "2026-07-26T12:00:00.000Z",
            credentialRef: {
              credentialId,
              generation: 0,
              store: "dynamodb-kms",
            },
            environmentId: ENVIRONMENT_ID,
            externalAccountId: "search-console-account",
            id: connectionId,
            organizationId: ORGANIZATION_ID,
            projectId: PROJECT_ID,
            providerKey: "google_search_console",
            scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
            status: "active",
            updatedAt: "2026-07-26T12:00:00.000Z",
            version: 0,
          },
        }),
      ),
    );
    const verification = await fixtureValue.service.invoke(
      "requestConnectionVerification",
      invocation({}, connectionId),
    );
    expect(verification).toMatchObject({ status: "verified" });
    expect(fixtureValue.credentialReads.at(-1)?.expectedIdentity.purpose).toBe(
      "provider-oauth-token",
    );
    expect(
      fixtureValue.service.invoke("listProviderCredentials", invocation(undefined)),
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(
      fixtureValue.service.invoke("revokeProviderCredential", invocation({}, connectionId)),
    ).rejects.toMatchObject({ code: "invalid_auth_method" });
    const currentConnection = [...fixtureValue.records.values()].find(
      (record) => record.itemType === "provider-connection" && record.data.id === connectionId,
    ) as Extract<PlatformRecord, { readonly itemType: "provider-connection" }>;
    fixtureValue.put(
      Schema.decodeUnknownSync(ProviderConnectionRecord)(
        withCanonicalRecordKeys({
          itemType: "provider-connection",
          data: {
            ...currentConnection.data,
            status: "reauthorization-required",
            version: currentConnection.data.version + 1,
          },
        }),
      ),
    );
    expect(
      fixtureValue.service.invoke("requestConnectionVerification", invocation({}, connectionId)),
    ).rejects.toMatchObject({ code: "connection_not_verifiable" });
  });

  test("grants scopes used by active MCP extensions and rejects unsupported scopes", async () => {
    const { service, put } = fixture();
    const server = (await service.invoke(
      "createMcpServer",
      invocation({
        endpointOrigin: "https://mcp.example",
        endpointPath: "/rpc",
        name: "Scoped MCP",
        toolAllowlist: ["remote.read"],
      }),
    )) as { readonly id: Ulid };
    await service.invoke(
      "createExtensionTool",
      invocation({
        defaultPolicyAction: "allow",
        description: "Read a scoped MCP resource",
        effect: "read",
        execution: {
          mcpServerId: server.id,
          remoteToolName: "remote.read",
          type: "mcp",
        },
        inputSchema: { type: "object" },
        name: "custom.scoped_read",
        requiredScopes: ["documents:read"],
      }),
    );
    const connection = (await service.invoke(
      "createMcpConnection",
      invocation({ mcpServerId: server.id }),
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
    expect(
      service.invoke(
        "createConnectionGrant",
        invocation({
          connectionId: connection.id,
          purpose: "agent-runtime",
          scopes: ["documents:read"],
          workspaceId: WORKSPACE_ID,
        }),
      ),
    ).resolves.toMatchObject({ providerKey: "mcp", scopes: ["documents:read"] });
    expect(
      service.invoke(
        "createConnectionGrant",
        invocation({
          connectionId: connection.id,
          purpose: "agent-runtime",
          scopes: ["documents:write"],
          workspaceId: WORKSPACE_ID,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_scope", kind: "unprocessable" });
    await service.invoke("archiveMcpServer", invocation({ expectedVersion: 0 }, server.id));
    expect(
      service.invoke(
        "createConnectionGrant",
        invocation({
          connectionId: connection.id,
          purpose: "agent-runtime",
          scopes: ["documents:read"],
          workspaceId: WORKSPACE_ID,
        }),
      ),
    ).rejects.toMatchObject({ code: "connection_inactive" });
  });

  test("conditions MCP connections and extensions on the validated server version", async () => {
    const fixtureValue = fixture();
    const server = (await fixtureValue.service.invoke(
      "createMcpServer",
      invocation({
        endpointOrigin: "https://mcp.example",
        endpointPath: "/rpc",
        name: "Conditional MCP",
        toolAllowlist: ["remote.read"],
      }),
    )) as { readonly id: Ulid };
    await fixtureValue.service.invoke(
      "createMcpConnection",
      invocation({ mcpServerId: server.id }),
    );
    await fixtureValue.service.invoke(
      "createExtensionTool",
      invocation({
        defaultPolicyAction: "deny",
        description: "Conditioned extension",
        effect: "read",
        execution: {
          mcpServerId: server.id,
          remoteToolName: "remote.read",
          type: "mcp",
        },
        inputSchema: { type: "object" },
        name: "custom.conditioned",
        requiredScopes: [],
      }),
    );
    await fixtureValue.service.invoke("updateExtensionTool", {
      ...invocation({
        description: "Updated conditioned extension",
        expectedVersion: 0,
      }),
      id: "custom.conditioned",
      params: { toolName: "custom.conditioned" },
    });

    for (const operations of fixtureValue.transactionInputs.slice(-3)) {
      expect(operations).toContainEqual(
        expect.objectContaining({
          expressionAttributeValues: expect.objectContaining({
            ":itemType": "mcp-server",
            ":status": "active",
            ":version": 0,
          }),
          kind: "condition-check",
          table: "control",
        }),
      );
    }
  });

  test("rejects regex keywords in extension input schemas on create and update", async () => {
    const fixtureValue = fixture();
    const extensionBody = {
      defaultPolicyAction: "deny",
      description: "Schema validation extension",
      effect: "read",
      execution: {
        completionMode: "sync",
        endpointOrigin: "https://callbacks.example.com",
        endpointPath: "/read",
        type: "http_callback",
      },
      name: "custom.schema_validation",
      providerKey: "github",
      requiredScopes: [],
    };

    expect(
      fixtureValue.service.invoke(
        "createExtensionTool",
        invocation({
          ...extensionBody,
          callbackSecret: "callback-secret",
          inputSchema: {
            properties: {
              query: { pattern: "^(a+)+$", type: "string" },
            },
            type: "object",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "unsafe_input_schema" });

    await fixtureValue.service.invoke(
      "createExtensionTool",
      invocation({
        ...extensionBody,
        callbackSecret: "callback-secret",
        inputSchema: { type: "object" },
      }),
    );
    expect(
      fixtureValue.service.invoke(
        "createExtensionTool",
        invocation({
          ...extensionBody,
          callbackSecret: "callback-secret",
          inputSchema: {
            properties: {
              payload: {
                enum: [{ pattern: "literal instance data" }],
                type: "object",
              },
              pattern: { type: "string" },
            },
            type: "object",
          },
          name: "custom.schema_literal",
        }),
      ),
    ).resolves.toMatchObject({ name: "custom.schema_literal" });
    expect(
      fixtureValue.service.invoke("updateExtensionTool", {
        ...invocation({
          expectedVersion: 0,
          inputSchema: {
            allOf: [
              {
                patternProperties: {
                  "^(a+)+$": { type: "string" },
                },
              },
            ],
            type: "object",
          },
        }),
        params: { toolName: extensionBody.name },
      }),
    ).rejects.toMatchObject({ code: "unsafe_input_schema" });
  });
});
