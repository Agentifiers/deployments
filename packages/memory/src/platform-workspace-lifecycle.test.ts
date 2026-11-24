import { describe, expect, it } from "bun:test";
import type {
  DynamoDatabaseService,
  PlatformRecord,
  QueryRecordsResult,
  TransactionOperation,
  Ulid,
} from "@deployments-ai/db";
import { withCanonicalRecordKeys } from "@deployments-ai/db";
import { ids, memoryFixture, optionalExpressionString } from "./test-fixtures.ts";
import { putAgentRelease } from "./memory-flush-test-fixtures.ts";
import { makeMemoryPlatform, type MemoryPlatformScope } from "./platform.ts";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";

const fixedNow = new Date("2026-07-21T18:00:00.000Z");
const ulidAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function indexedUlid(index: number) {
  let value = index;
  let suffix = "";
  for (let position = 0; position < 6; position += 1) {
    suffix = ulidAlphabet[value % ulidAlphabet.length] + suffix;
    value = Math.floor(value / ulidAlphabet.length);
  }
  return `01ARZ3NDEKTSV4RRFFQ6${suffix}` as Ulid;
}

function memoryDatabase() {
  const tables = new Map<string, Map<string, PlatformRecord>>();
  const queries: { readonly input: Record<string, unknown>; readonly table: string }[] = [];
  const table = (name: string) => {
    let records = tables.get(name);
    if (!records) {
      records = new Map();
      tables.set(name, records);
    }
    return records;
  };
  const put = (name: string, value: PlatformRecord) => {
    table(name).set(`${value.pk}\u0000${value.sk}`, value);
  };
  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => {
      for (const values of tables.values()) values.delete(`${record.pk}\u0000${record.sk}`);
    },
    getRecord: async (name, key) => {
      const value = table(name).get(`${key.pk}\u0000${key.sk}`);
      return value;
    },
    putRecord: async (record) =>
      put(record.itemType === "semantic-event" ? "events" : tableName(record), record),
    queryRecords: async (name, input) => {
      queries.push({ input: input as Record<string, unknown>, table: name });
      const values = [...table(name).values()];
      const expressions = input.ExpressionAttributeValues as Record<string, unknown> | undefined;
      const pkName =
        input.IndexName === "gsi2" ? "gsi2pk" : input.IndexName === "gsi1" ? "gsi1pk" : "pk";
      const skName =
        input.IndexName === "gsi2" ? "gsi2sk" : input.IndexName === "gsi1" ? "gsi1sk" : "sk";
      const partition = optionalExpressionString(expressions, ":pk");
      const prefix = optionalExpressionString(expressions, ":prefix");
      const exact = expressions?.[":run"];
      const lowerBound = optionalExpressionString(expressions, ":since");
      const matching = values
        .filter((value) => partition === undefined || value[pkName] === partition)
        .filter((value) => exact === undefined || value[skName] === exact)
        .filter(
          (value) =>
            lowerBound === undefined ||
            (typeof value[skName] === "string" && value[skName] >= lowerBound),
        )
        .filter(
          (value) =>
            prefix === undefined ||
            (typeof value[skName] === "string" && value[skName].startsWith(prefix)),
        );
      const start = Number(
        (input.ExclusiveStartKey as Record<string, unknown> | undefined)?.cursor ?? 0,
      );
      const end = Math.min(start + (input.Limit ?? 100), matching.length);
      return {
        items: matching.slice(start, end),
        ...(end < matching.length
          ? {
              lastEvaluatedKey: {
                cursor: end,
                gsi2pk: partition ?? "ENV#test",
                gsi2sk: `${prefix ?? "ITEM#"}${end}`,
                pk: `PK#${end}`,
                sk: `SK#${end}`,
              },
            }
          : {}),
      } satisfies QueryRecordsResult;
    },
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        if (operation.kind === "delete") {
          table(tableName(operation.record)).delete(
            `${operation.record.pk}\u0000${operation.record.sk}`,
          );
        } else {
          put(tableName(operation.record), operation.record);
        }
      }
    },
  };
  return { database, put, queries };
}

function tableName(record: PlatformRecord) {
  if (record.itemType === "semantic-event" || record.itemType === "idempotency") return "events";
  if (
    record.itemType === "memory-index-job" ||
    record.itemType === "memory-flush" ||
    record.itemType === "memory-recall-attempt" ||
    record.itemType === "memory-retrieval" ||
    record.itemType === "memory-review-item"
  ) {
    return "execution";
  }
  return "control";
}

async function grantedFlushRun(
  platform: ReturnType<typeof makeMemoryPlatform>,
  put: ReturnType<typeof memoryDatabase>["put"],
  scope: MemoryPlatformScope,
  memorySpaceId: Ulid,
  runId: Ulid = ids.run,
) {
  const deploymentId = indexedUlid(12_000);
  put(
    "control",
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId: ids.agent,
        agentReleaseId: ids.memory2,
        createdAt: fixedNow.toISOString(),
        currentState: "ready" as const,
        desiredState: "running" as const,
        environmentId: scope.environmentId,
        id: deploymentId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        updatedAt: fixedNow.toISOString(),
        version: 0,
      },
      itemType: "agent-deployment" as const,
    }) as PlatformRecord,
  );
  putAgentRelease(put, scope);
  await platform.grantMemorySpace(scope, {
    agentDefinitionId: ids.agent,
    memorySpaceId,
    permission: "read-write",
  });
  const run = withCanonicalRecordKeys({
    data: {
      agentDeploymentId: deploymentId,
      agentReleaseId: ids.memory2,
      attempt: 0,
      createdAt: fixedNow.toISOString(),
      environmentId: scope.environmentId,
      executor: "test",
      id: runId,
      idempotencyKey: `run:${runId}`,
      organizationId: scope.organizationId,
      priority: 0,
      projectId: scope.projectId,
      status: "completed" as const,
      threadId: ids.thread,
      trigger: "test",
      updatedAt: fixedNow.toISOString(),
      version: 0,
      ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
    },
    itemType: "run" as const,
  }) as Extract<PlatformRecord, { readonly itemType: "run" }>;
  put("execution", run);
  return run;
}

describe("memory platform workspace lifecycle", () => {
  it("denies records owned by a different claimed workspace", async () => {
    const { database, put } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const otherWorkspaceId = indexedUlid(13_000);
    const memory = memoryFixture({ id: indexedUlid(13_001), workspaceId: otherWorkspaceId });
    put("control", memory);
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
      workspaceId: ids.workspace,
    };

    expect(platform.requiredMemory(scope, memory.data.id)).rejects.toMatchObject({
      code: "memory_not_found",
      statusCode: 404,
    });
    expect(await platform.listMemories(scope, { all: true })).toEqual([]);
  });

  it("does not let workspace-scoped API credentials mutate broader memory records", async () => {
    const { database, put } = memoryDatabase();
    let searchPreparations = 0;
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider({
        prepare: async () => {
          searchPreparations += 1;
        },
      }).provider,
    });
    const tenantScope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(tenantScope, { name: "Organization-owned" });
    const imported = await platform.importMemories(tenantScope, {
      items: [{ content: "Organization-wide fact.", scope: "organization" }],
      memorySpaceId: space.data.id,
    });
    const workspaceApiScope = {
      ...tenantScope,
      exactWorkspaceMutations: true,
      workspaceId: ids.workspace,
    };

    expect(
      platform.archiveMemory(workspaceApiScope, imported.imported[0]!.data.id),
    ).rejects.toMatchObject({ code: "memory_not_found", statusCode: 404 });
    expect(platform.archiveMemorySpace(workspaceApiScope, space.data.id)).rejects.toMatchObject({
      code: "memory_space_not_found",
      statusCode: 404,
    });
    expect(
      platform.upsertPolicy(workspaceApiScope, { scope: "environment" }),
    ).rejects.toMatchObject({ code: "workspace_scope_conflict", statusCode: 403 });
    expect(platform.prepareNamespaceFullText(workspaceApiScope)).rejects.toMatchObject({
      code: "workspace_scope_conflict",
      statusCode: 403,
    });
    expect(searchPreparations).toBe(0);
    const workspaceSpace = await platform.createMemorySpace(workspaceApiScope, {
      kind: "workspace",
      name: "Workspace-owned",
    });
    expect(
      platform.importMemories(workspaceApiScope, {
        items: [{ content: "Broader fact.", scope: "organization" }],
        memorySpaceId: workspaceSpace.data.id,
      }),
    ).rejects.toMatchObject({ code: "workspace_scope_conflict", statusCode: 403 });
    const workspaceRunScope = { ...tenantScope, workspaceId: ids.workspace };
    const workspaceRun = await grantedFlushRun(
      platform,
      put,
      workspaceRunScope,
      workspaceSpace.data.id,
      indexedUlid(15_350),
    );
    await platform.grantMemorySpace(workspaceRunScope, {
      agentDefinitionId: ids.agent,
      memorySpaceId: space.data.id,
      permission: "read-write",
    });
    expect(
      platform.enqueueFlush(workspaceApiScope, workspaceRun, { memoryMode: "organization" }),
    ).rejects.toMatchObject({ code: "workspace_scope_conflict", statusCode: 403 });
    const run = await grantedFlushRun(platform, put, tenantScope, space.data.id);
    expect(
      platform.enqueueFlush(workspaceApiScope, run, { memoryMode: "off" }),
    ).rejects.toMatchObject({ code: "run_not_found", statusCode: 404 });
  });
});
