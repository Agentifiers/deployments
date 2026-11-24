import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import {
  DatabaseError,
  HostedCodeArtifactRecord,
  loadReleaseHostedCodeTool,
  makeAgentLifecyclePersistence,
  makeUniqueClaimRecord,
  PersistenceError,
  tableForItemType,
  ToolAdapterRecord,
  uniqueClaimRequirements,
  UniqueClaimRecord,
  withCanonicalRecordKeys,
  type AgentEnvironmentScope,
  type DynamoDatabaseService,
  type PersistenceInvocation,
  type PlatformRecord,
  type QueryRecordsResult,
  type TableName,
  type Ulid,
} from "../index.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as Ulid;
const ADAPTER_ID = "01ARZ3NDEKTSV4RRFFQ69G5FD0" as Ulid;
const CALLBACK_ADAPTER_ID = "01ARZ3NDEKTSV4RRFFQ69G5FD1";
const TARGET_ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FD2" as Ulid;
const TARGET_ADAPTER_ID = "01ARZ3NDEKTSV4RRFFQ69G5FD3" as Ulid;
const HOSTED_TOOL = "orders.lookup";
const CALLBACK_TOOL = "records.read";
const CREATED_AT = "2026-07-26T12:00:00.000Z";

type SandboxPolicy = {
  readonly mode: "none" | "run-ephemeral" | "thread-persistent";
  readonly provider?: "aws_lambda_microvm";
};

function contentHash(source: string) {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

const V1_HASH = contentHash("export function handler() { return { v: 1 }; }");
const V2_HASH = contentHash("export function handler() { return { v: 2 }; }");

function artifactRecord(
  hash: string,
  versionId: string,
  byteSize: number,
  environmentId: Ulid = ENVIRONMENT_ID,
) {
  return Schema.decodeUnknownSync(HostedCodeArtifactRecord)(
    withCanonicalRecordKeys({
      data: {
        byteSize,
        contentHash: hash,
        createdAt: CREATED_AT,
        createdByPrincipalId: PRINCIPAL_ID,
        environmentId,
        language: "javascript",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        sourceByteSize: byteSize + 12,
        sourceContentHash: contentHash(`typescript ${versionId}`),
        sourceLanguage: "typescript",
        storage: {
          bucket: "platform-artifacts",
          byteSize,
          key: `organizations/${ORGANIZATION_ID}/hosted-code-artifacts/${hash.slice(7)}.mjs`,
          versionId,
        },
        version: 0,
      },
      itemType: "hosted-code-artifact",
    }),
  );
}

function hostedAdapter(
  version: number,
  execution: Readonly<Record<string, unknown>>,
  outputSchema: Readonly<Record<string, unknown>>,
  placement: { readonly environmentId: Ulid; readonly id: Ulid } = {
    environmentId: ENVIRONMENT_ID,
    id: ADAPTER_ID,
  },
) {
  return Schema.decodeUnknownSync(ToolAdapterRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: CREATED_AT,
        defaultPolicyAction: "allow",
        description: "Look up an order.",
        effect: "execute",
        environmentId: placement.environmentId,
        execution: { type: "hosted_code", ...execution },
        id: placement.id,
        inputSchema: {
          properties: { orderId: { type: "string" } },
          required: ["orderId"],
          type: "object",
        },
        name: HOSTED_TOOL,
        organizationId: ORGANIZATION_ID,
        outputSchema,
        projectId: PROJECT_ID,
        requiredScopes: [],
        status: "active",
        updatedAt: CREATED_AT,
        version,
      },
      itemType: "tool-adapter",
    }),
  );
}

function callbackAdapter() {
  return Schema.decodeUnknownSync(ToolAdapterRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: CREATED_AT,
        defaultPolicyAction: "allow",
        description: "Read records.",
        effect: "read",
        environmentId: ENVIRONMENT_ID,
        execution: {
          completionMode: "sync",
          endpointOrigin: "https://callbacks.example.com",
          endpointPath: "/records",
          type: "http_callback",
        },
        id: CALLBACK_ADAPTER_ID,
        inputSchema: { type: "object" },
        name: CALLBACK_TOOL,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        requiredScopes: [],
        status: "active",
        updatedAt: CREATED_AT,
        version: 0,
      },
      itemType: "tool-adapter",
    }),
  );
}

const V1_EXECUTION = {
  contentHash: V1_HASH,
  entrypoint: "handler",
  language: "javascript",
  memoryMiB: 256,
  network: "none",
  secretNames: ["ORDERS_TOKEN"],
  sourceLanguage: "typescript",
  timeoutMs: 5_000,
};
const V1_OUTPUT_SCHEMA = { properties: { v: { type: "number" } }, type: "object" };

function manifest(
  sandbox: SandboxPolicy,
  hostedAuthorization?: "none" | "workspace",
  toolNames: readonly string[] = [HOSTED_TOOL, CALLBACK_TOOL],
) {
  return {
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key: "orders.assistant", name: "Orders Assistant", version: "1.0.0" },
    spec: {
      capabilities: {
        tools: toolNames.map((name) => ({
          ...(name === HOSTED_TOOL && hostedAuthorization
            ? { authorization: hostedAuthorization }
            : {}),
          name,
          required: true,
          requiredScopes: [],
        })),
      },
      instructions: "Answer order questions.",
      model: { id: "openrouter/default" },
      sandbox,
    },
  } as const;
}

function invocation<Body>(body: Body, id?: string): PersistenceInvocation<Body> {
  return {
    body,
    identity: { principalId: PRINCIPAL_ID },
    idempotencyKey: "hosted-code-release-pins",
    ...(id ? { id } : {}),
    query: {},
    scope: { environmentId: ENVIRONMENT_ID },
  };
}

function storageKey(table: TableName, record: { readonly pk: string; readonly sk: string }) {
  return `${table}\u0000${record.pk}\u0000${record.sk}`;
}

function conflict(operation: string) {
  return new DatabaseError({
    cause: new Error("simulated conflict"),
    message: "Conditional write failed.",
    operation,
    reason: "conflict",
    table: "control",
  });
}

function memoryDatabase() {
  const records = new Map<string, PlatformRecord>();
  const put = (record: PlatformRecord) =>
    records.set(storageKey(tableForItemType(record.itemType), record), structuredClone(record));
  const lookup = (table: TableName, record: { readonly pk: string; readonly sk: string }) =>
    records.get(storageKey(table, record));
  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => {
      records.delete(storageKey(tableForItemType(record.itemType), record));
    },
    getRecord: async (table, key) => {
      const record = lookup(table, key);
      return record ? structuredClone(record) : undefined;
    },
    putRecord: async (record) => {
      put(record);
    },
    queryRecords: async (table, input) => {
      {
        const values = input.ExpressionAttributeValues as Readonly<Record<string, unknown>>;
        const index =
          input.IndexName === "gsi1" || input.IndexName === "gsi2" ? input.IndexName : "";
        const prefixValue = values[":prefix"];
        const prefix = typeof prefixValue === "string" ? prefixValue : "";
        const sortKey = (record: PlatformRecord) =>
          String((record as unknown as Readonly<Record<string, unknown>>)[`${index}sk`]);
        const matching = [...records.values()]
          .filter((record) => tableForItemType(record.itemType) === table)
          .filter(
            (record) =>
              (record as unknown as Readonly<Record<string, unknown>>)[`${index}pk`] ===
                values[":pk"] && sortKey(record).startsWith(prefix),
          )
          .toSorted((left, right) => sortKey(left).localeCompare(sortKey(right)));
        const ordered = input.ScanIndexForward === false ? matching.toReversed() : matching;
        const items = ordered
          .slice(0, input.Limit ?? ordered.length)
          .map((record) => structuredClone(record));
        return { items } satisfies QueryRecordsResult;
      }
    },
    transactWrite: async (operations) => {
      {
        for (const operation of operations) {
          if (operation.kind !== "put") continue;
          const existing = lookup(tableForItemType(operation.record.itemType), operation.record);
          if (operation.previousRecord) {
            const existingVersion =
              existing && "version" in existing.data ? existing.data.version : undefined;
            const previousVersion =
              "version" in operation.previousRecord.data
                ? operation.previousRecord.data.version
                : undefined;
            if (existingVersion !== previousVersion) {
              throw conflict("replace");
            }
          } else if (!operation.allowExisting && existing) {
            throw conflict("create");
          }
        }
        for (const operation of operations) {
          if (operation.kind === "put") put(operation.record);
          else if (operation.kind === "delete") {
            records.delete(
              storageKey(tableForItemType(operation.record.itemType), operation.record),
            );
          }
        }
      }
    },
  };
  return { database, put, records };
}

function fixture() {
  const store = memoryDatabase();
  const ids = Array.from(
    { length: 40 },
    (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5F${index.toString(32).toUpperCase().padStart(2, "0")}`,
  );
  let nextId = 0;
  let tick = 0;
  const service = makeAgentLifecyclePersistence({
    admitManifest: async () => [],
    database: store.database,
    generateId: async () => ids[nextId++]!,
    now: () => new Date(Date.UTC(2026, 6, 26, 12, 0, tick++)),
    resolveEnvironment: async (request) =>
      [ENVIRONMENT_ID, TARGET_ENVIRONMENT_ID].includes(request.scope.environmentId as Ulid)
        ? ({
            id: request.scope.environmentId,
            organizationId: ORGANIZATION_ID,
            projectId: PROJECT_ID,
          } as AgentEnvironmentScope)
        : undefined,
  });
  const seedAdapter = (adapter: PlatformRecord) => {
    store.put(adapter);
    for (const requirement of uniqueClaimRequirements(adapter)) {
      store.put(
        Schema.decodeUnknownSync(UniqueClaimRecord)(makeUniqueClaimRecord(requirement, CREATED_AT)),
      );
    }
  };
  store.put(artifactRecord(V1_HASH, "object-version-1", 48));
  store.put(artifactRecord(V2_HASH, "object-version-2", 48));
  seedAdapter(callbackAdapter());
  seedAdapter(hostedAdapter(0, V1_EXECUTION, V1_OUTPUT_SCHEMA));
  const pins = () =>
    [...store.records.values()].filter(
      (record) => record.itemType === "agent-release-hosted-code-tool",
    );
  const releases = () =>
    [...store.records.values()].filter((record) => record.itemType === "agent-release");
  const publish = async (sandbox: SandboxPolicy, hostedAuthorization?: "none" | "workspace") => {
    const definition = await service.agentDefinitions.create(
      invocation({ manifest: manifest(sandbox, hostedAuthorization) }),
    );
    return service.agentReleases.publish(
      invocation({ expectedDefinitionVersion: 0 }, definition.id),
    );
  };
  const loadPin = (agentReleaseId: string) =>
    loadReleaseHostedCodeTool(store.database, {
      agentReleaseId,
      organizationId: ORGANIZATION_ID,
      toolName: HOSTED_TOOL,
    });
  return { loadPin, pins, publish, releases, seedAdapter, service, store };
}

const MICROVM_SANDBOX = { mode: "run-ephemeral", provider: "aws_lambda_microvm" } as const;

describe("hosted code release pins", () => {
  test("publish snapshots the exact artifact, contract, limits, and secret names", async () => {
    const { loadPin, pins, publish } = fixture();

    const release = await publish(MICROVM_SANDBOX);

    expect(pins()).toHaveLength(1);
    const pin = await loadPin(release.id);
    expect(pin?.data).toEqual({
      agentReleaseId: release.id,
      artifact: {
        bucket: "platform-artifacts",
        byteSize: 48,
        key: `organizations/${ORGANIZATION_ID}/hosted-code-artifacts/${V1_HASH.slice(7)}.mjs`,
        versionId: "object-version-1",
      },
      contentHash: V1_HASH,
      createdAt: release.createdAt,
      effect: "execute",
      entrypoint: "handler",
      environmentId: ENVIRONMENT_ID,
      inputSchema: {
        properties: { orderId: { type: "string" } },
        required: ["orderId"],
        type: "object",
      },
      language: "javascript",
      memoryMiB: 256,
      network: "none",
      organizationId: ORGANIZATION_ID,
      outputSchema: V1_OUTPUT_SCHEMA,
      projectId: PROJECT_ID,
      secretNames: ["ORDERS_TOKEN"],
      sourceLanguage: "typescript",
      timeoutMs: 5_000,
      toolAdapterId: ADAPTER_ID,
      toolAdapterVersion: 0,
      toolName: HOSTED_TOOL,
      version: 0,
    });
  });

  test("later extension updates do not change a published release's pin", async () => {
    const { loadPin, publish, seedAdapter, service } = fixture();
    const first = await publish(MICROVM_SANDBOX);
    const pinned = await loadPin(first.id);

    seedAdapter(
      hostedAdapter(
        1,
        {
          ...V1_EXECUTION,
          contentHash: V2_HASH,
          memoryMiB: 1_024,
          network: "sandbox",
          secretNames: ["ORDERS_TOKEN", "WAREHOUSE_TOKEN"],
          timeoutMs: 30_000,
        },
        { properties: { v: { type: "string" } }, type: "object" },
      ),
    );
    const second = await service.agentReleases.publish(
      invocation({ expectedDefinitionVersion: 1 }, first.agentDefinitionId),
    );

    expect(await loadPin(first.id)).toEqual(pinned);
    expect((await loadPin(second.id))?.data).toMatchObject({
      artifact: { versionId: "object-version-2" },
      contentHash: V2_HASH,
      memoryMiB: 1_024,
      network: "sandbox",
      outputSchema: { properties: { v: { type: "string" } }, type: "object" },
      secretNames: ["ORDERS_TOKEN", "WAREHOUSE_TOKEN"],
      timeoutMs: 30_000,
      toolAdapterVersion: 1,
    });
  });

  test.each([
    ["without a sandbox", { mode: "none" } as const, undefined, "/spec/capabilities/tools/0/name"],
    [
      "with a workspace authorization",
      MICROVM_SANDBOX,
      "workspace" as const,
      "/spec/capabilities/tools/0/authorization",
    ],
  ])("rejects publishing a hosted code tool %s", async (_case, sandbox, authorization, path) => {
    const { pins, publish, releases } = fixture();

    const rejection = await publish(sandbox, authorization).catch((cause: unknown) => cause);

    expect(rejection).toBeInstanceOf(PersistenceError);
    expect(rejection).toMatchObject({ code: "invalid_agent_manifest", kind: "unprocessable" });
    expect((rejection as PersistenceError).message.startsWith(`${path}:`)).toBe(true);
    expect(releases()).toHaveLength(0);
    expect(pins()).toHaveLength(0);
  });

  test("manifests without hosted code tools publish without a sandbox or pins", async () => {
    const { pins, service } = fixture();
    const definition = await service.agentDefinitions.create(
      invocation({ manifest: manifest({ mode: "none" }, undefined, [CALLBACK_TOOL]) }),
    );

    expect(
      service.agentReleases.publish(invocation({ expectedDefinitionVersion: 0 }, definition.id)),
    ).resolves.toMatchObject({ releaseNumber: 1 });
    expect(pins()).toHaveLength(0);
  });

  test("promotion snapshots hosted code tools resolved in the target environment", async () => {
    const { loadPin, pins, publish, seedAdapter, service, store } = fixture();
    store.put(artifactRecord(V1_HASH, "target-object-version", 48, TARGET_ENVIRONMENT_ID));
    seedAdapter(
      hostedAdapter(3, { ...V1_EXECUTION, secretNames: ["TARGET_TOKEN"] }, V1_OUTPUT_SCHEMA, {
        environmentId: TARGET_ENVIRONMENT_ID,
        id: TARGET_ADAPTER_ID,
      }),
    );
    const source = await publish(MICROVM_SANDBOX);
    const sourcePin = await loadPin(source.id);

    const promoted = await service.agentReleases.promote(
      invocation({ targetEnvironmentId: TARGET_ENVIRONMENT_ID }, source.id),
    );

    expect(promoted.created).toBe(true);
    expect(pins()).toHaveLength(2);
    expect(await loadPin(source.id)).toEqual(sourcePin);
    expect((await loadPin(promoted.release.id))?.data).toMatchObject({
      agentReleaseId: promoted.release.id,
      artifact: { versionId: "target-object-version" },
      contentHash: V1_HASH,
      environmentId: TARGET_ENVIRONMENT_ID,
      secretNames: ["TARGET_TOKEN"],
      toolAdapterId: TARGET_ADAPTER_ID,
      toolAdapterVersion: 3,
    });
  });

  test("promotion is rejected when the target lacks a hosted code tool the source pinned", async () => {
    const { pins, publish, releases, service } = fixture();
    const source = await publish(MICROVM_SANDBOX);

    const rejection = await service.agentReleases
      .promote(invocation({ targetEnvironmentId: TARGET_ENVIRONMENT_ID }, source.id))
      .catch((cause: unknown) => cause);

    expect(rejection).toBeInstanceOf(PersistenceError);
    expect(rejection).toMatchObject({
      code: "hosted_code_tool_unavailable",
      kind: "unprocessable",
    });
    expect((rejection as PersistenceError).message).toContain(HOSTED_TOOL);
    expect(releases()).toHaveLength(1);
    expect(pins()).toHaveLength(1);
  });

  test("promotion is rejected when the target's hosted code artifact differs from the source pin", async () => {
    const { pins, publish, releases, seedAdapter, service, store } = fixture();
    store.put(artifactRecord(V2_HASH, "target-object-version", 48, TARGET_ENVIRONMENT_ID));
    seedAdapter(
      hostedAdapter(3, { ...V1_EXECUTION, contentHash: V2_HASH }, V1_OUTPUT_SCHEMA, {
        environmentId: TARGET_ENVIRONMENT_ID,
        id: TARGET_ADAPTER_ID,
      }),
    );
    const source = await publish(MICROVM_SANDBOX);

    const rejection = await service.agentReleases
      .promote(invocation({ targetEnvironmentId: TARGET_ENVIRONMENT_ID }, source.id))
      .catch((cause: unknown) => cause);

    expect(rejection).toBeInstanceOf(PersistenceError);
    expect(rejection).toMatchObject({ code: "hosted_code_tool_mismatch", kind: "unprocessable" });
    expect((rejection as PersistenceError).message).toContain(V1_HASH);
    expect((rejection as PersistenceError).message).toContain(V2_HASH);
    expect(releases()).toHaveLength(1);
    expect(pins()).toHaveLength(1);
  });
});
