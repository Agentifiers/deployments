import { describe, expect, it } from "bun:test";
import type {
  DynamoDatabaseService,
  PlatformRecord,
  QueryRecordsResult,
  TransactionOperation,
  Ulid,
} from "@deployments-ai/db";
import { withCanonicalRecordKeys } from "@deployments-ai/db";
import { ids, optionalExpressionString } from "./test-fixtures.ts";
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
  const clientRequestTokens: (string | undefined)[] = [];
  const queries: { readonly input: Record<string, unknown>; readonly table: string }[] = [];
  const transactions: (readonly TransactionOperation[])[] = [];
  const transactionSizes: number[] = [];
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
    transactWrite: async (operations: readonly TransactionOperation[], clientRequestToken) => {
      clientRequestTokens.push(clientRequestToken);
      transactions.push(operations);
      transactionSizes.push(operations.length);
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
  return { clientRequestTokens, database, put, queries, tables, transactions, transactionSizes };
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
      captureMode: "metadata-only" as const,
      createdAt: fixedNow.toISOString(),
      environmentId: scope.environmentId,
      executor: "test",
      id: runId,
      idempotencyKey: `run:${runId}`,
      organizationId: scope.organizationId,
      priority: 0,
      projectId: scope.projectId,
      redactionPolicyVersion: 1 as const,
      schemaVersion: 1 as const,
      spanId: "0123456789abcdef" as const,
      status: "completed" as const,
      threadId: ids.thread,
      traceId: "0123456789abcdef0123456789abcdef" as const,
      trigger: "test",
      updatedAt: fixedNow.toISOString(),
      version: 0,
      ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
    },
    itemType: "run" as const,
  }) as Extract<PlatformRecord, { readonly itemType: "run" }>;
  put("execution", run);
  put(
    "control",
    withCanonicalRecordKeys({
      data: {
        createdAt: fixedNow.toISOString(),
        environmentId: scope.environmentId,
        id: runId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        runPk: run.pk,
        runSk: run.sk,
        ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
      },
      itemType: "run-locator" as const,
    }) as PlatformRecord,
  );
  return run;
}

describe("memory platform", () => {
  it("rejects restoring memory into an archived space", async () => {
    const { database } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(scope, { name: "Archived restore" });
    const imported = await platform.importMemories(scope, {
      items: [{ content: "Archived restore fact.", scope: "organization" }],
      memorySpaceId: space.data.id,
    });
    const memoryId = imported.imported[0]!.data.id;
    await platform.archiveMemory(scope, memoryId);
    await platform.archiveMemorySpace(scope, space.data.id);

    expect(platform.restoreMemory(scope, memoryId)).rejects.toMatchObject({
      code: "memory_space_archived",
      statusCode: 409,
    });
  });

  it("redirects a failed flush through the public enqueue path", async () => {
    const { database, put, tables } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(scope, { name: "Retry flush" });
    const retrySpace = await platform.createMemorySpace(scope, { name: "Retry flush target" });
    const run = await grantedFlushRun(platform, put, scope, space.data.id);
    await platform.grantMemorySpace(scope, {
      agentDefinitionId: ids.agent,
      memorySpaceId: retrySpace.data.id,
      permission: "read-write",
    });
    const queued = await platform.enqueueFlush(scope, run, { memorySpaceId: space.data.id });
    const claimed = await platform.claimFlush(
      scope,
      ids.run,
      queued.data.idempotencyKey,
      "worker-1",
    );
    const failed = await platform.failFlush(claimed, new Error("model unavailable"));
    await platform.archiveMemorySpace(scope, space.data.id);

    const requeued = await platform.enqueueFlush(scope, run, {
      memorySpaceId: retrySpace.data.id,
    });

    expect(requeued.data.status).toBe("queued");
    expect(requeued.data.memorySpaceId).toBe(retrySpace.data.id);
    expect(requeued.data.version).toBe(failed.data.version + 1);
    expect(requeued.data.error).toBeUndefined();
    expect(
      [...(tables.get("events")?.values() ?? [])]
        .filter(
          (record): record is Extract<PlatformRecord, { readonly itemType: "semantic-event" }> =>
            record.itemType === "semantic-event" && record.data.aggregateId === queued.data.id,
        )
        .map((record) => record.data.aggregateVersion),
    ).toEqual([1, 2, 3, 4]);
  });

  it("retains hashed candidate and memory progress across queue retries", async () => {
    const { database, put } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(scope, { name: "Flush progress" });
    const run = await grantedFlushRun(platform, put, scope, space.data.id);
    const queued = await platform.enqueueFlush(scope, run, { memorySpaceId: space.data.id });
    const claimed = await platform.claimFlush(
      scope,
      ids.run,
      queued.data.idempotencyKey,
      "worker-1",
    );
    const failed = await platform.failFlush(claimed, new Error("completion failed"), {
      candidateKeys: ["candidate-hash"],
      memoryIds: [ids.memory],
      rejectedCount: 1,
    });

    const retried = await platform.claimFlush(
      scope,
      ids.run,
      queued.data.idempotencyKey,
      "worker-2",
    );

    expect(failed.data).toMatchObject({
      candidateCount: 1,
      candidateKeys: ["candidate-hash"],
      memoryIds: [ids.memory],
      rejectedCount: 1,
    });
    expect(retried.data).toMatchObject({
      candidateKeys: ["candidate-hash"],
      memoryIds: [ids.memory],
    });
  });

  it("records the model that produced each flush completion", async () => {
    const { database, put } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(scope, { name: "Flush model" });
    const run = await grantedFlushRun(platform, put, scope, space.data.id);
    const queued = await platform.enqueueFlush(scope, run, { memorySpaceId: space.data.id });
    const claimed = await platform.claimFlush(
      scope,
      ids.run,
      queued.data.idempotencyKey,
      "worker-1",
    );
    const failed = await platform.failFlush(claimed, new Error("write failed"), {
      candidateKeys: ["candidate-hash"],
      completionModelId: "openrouter/anthropic/claude-haiku-4.5",
      memoryIds: [ids.memory],
      rejectedCount: 0,
    });
    const retried = await platform.claimFlush(
      scope,
      ids.run,
      queued.data.idempotencyKey,
      "worker-2",
    );
    const completed = await platform.completeFlush(
      retried,
      [ids.memory],
      1,
      0,
      ["candidate-hash"],
      undefined,
      "openrouter/openai/gpt-4o",
    );

    expect(
      [failed, retried, completed].map(({ data }) => [data.status, data.completionModelId]),
    ).toEqual([
      ["failed", "openrouter/anthropic/claude-haiku-4.5"],
      ["running", "openrouter/anthropic/claude-haiku-4.5"],
      ["succeeded", "openrouter/openai/gpt-4o"],
    ]);
  });

  it("rejects conflicting flush requests for the same run", async () => {
    const { database, put } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(scope, { name: "Flush identity" });
    const run = await grantedFlushRun(platform, put, scope, space.data.id);
    const queued = await platform.enqueueFlush(scope, run, {
      idempotencyKey: "flush-request",
      memoryMode: "organization",
      memorySpaceId: space.data.id,
      modelId: "openrouter/provider-model",
    });

    const replayed = await platform.enqueueFlush(scope, run, {
      idempotencyKey: "flush-request",
      memoryMode: "organization",
      memorySpaceId: space.data.id,
      modelId: "openrouter/provider-model",
    });

    expect(replayed.data.id).toBe(queued.data.id);
    expect(replayed.data.modelId).toBe("openrouter/provider-model");
    expect(
      platform.enqueueFlush(scope, run, {
        idempotencyKey: "different-flush-request",
        memoryMode: "off",
        memorySpaceId: space.data.id,
      }),
    ).rejects.toMatchObject({ code: "flush_request_conflict", statusCode: 409 });
  });

  it("resolves omitted flush settings from the run agent so an explicit enqueue replays the automatic flush", async () => {
    const { database, put } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(scope, { name: "Automatic flush" });
    const run = await grantedFlushRun(platform, put, scope, space.data.id);
    putAgentRelease(put, scope, {
      memory: { mode: "organization", reviewMode: "auto-approve" },
      modelId: "openrouter/example/agent-model",
      runtime: { contextCheckpointMode: "auto" },
    });
    // The completed-run worker passes the agent's compiled memory settings explicitly.
    const automatic = await platform.enqueueFlush(scope, run, {
      checkpointMode: "auto",
      memoryMode: "organization",
      modelId: "openrouter/example/agent-model",
      reviewMode: "auto-approve",
    });

    // The public API cannot name those settings; omitting them means the agent's own.
    const explicit = await platform.enqueueFlush(scope, run, {
      idempotencyKey: "api-flush-request",
      memoryMode: "organization",
      memorySpaceId: space.data.id,
    });

    expect(explicit.data).toMatchObject({
      checkpointMode: "auto",
      id: automatic.data.id,
      modelId: "openrouter/example/agent-model",
      reviewMode: "auto-approve",
    });
    expect(
      platform.enqueueFlush(scope, run, {
        idempotencyKey: "other-model-request",
        memoryMode: "organization",
        memorySpaceId: space.data.id,
        modelId: "openrouter/example/other-model",
      }),
    ).rejects.toMatchObject({ code: "flush_request_conflict", statusCode: 409 });
  });

  it("keeps off-mode flushes terminal and prevents later extraction", async () => {
    const { database, put } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(scope, { name: "Off-mode flush" });
    const run = await grantedFlushRun(platform, put, scope, space.data.id);
    const queued = await platform.enqueueFlush(scope, run, { memoryMode: "off" });
    const claimed = await platform.claimFlush(
      scope,
      run.data.id,
      queued.data.idempotencyKey,
      "worker-1",
    );
    const completed = await platform.completeFlush(claimed, [], 0);

    expect(platform.enqueueFlush(scope, run, { memoryMode: "off" })).resolves.toMatchObject({
      data: { id: completed.data.id, status: "succeeded", version: completed.data.version },
    });
    expect(
      platform.enqueueFlush(scope, run, {
        memoryMode: "organization",
        memorySpaceId: space.data.id,
      }),
    ).rejects.toMatchObject({ code: "flush_request_conflict", statusCode: 409 });
  });

  it("filters archived spaces from run-derived grants", async () => {
    const { database, put } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
      workspaceId: ids.workspace,
    };
    const activeSpace = await platform.createMemorySpace(scope, { name: "Active grant" });
    const archivedSpace = await platform.createMemorySpace(scope, { name: "Archived grant" });
    await grantedFlushRun(platform, put, scope, activeSpace.data.id);
    await platform.grantMemorySpace(scope, {
      agentDefinitionId: ids.agent,
      memorySpaceId: archivedSpace.data.id,
      permission: "read-write",
    });
    await platform.archiveMemorySpace(scope, archivedSpace.data.id);

    const access = await platform.memoryAccessForRun(scope, ids.run);
    expect(access.readMemorySpaceIds).toEqual([activeSpace.data.id]);
    expect(access.writeMemorySpaceIds).toEqual([activeSpace.data.id]);
  });

  it("never forwards memory keys as DynamoDB client request tokens", async () => {
    const { clientRequestTokens, database, put } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(scope, { name: "Token test" });
    await platform.importMemories(scope, {
      items: [{ agentDefinitionId: ids.agent, content: "Token fact.", scope: "agent" }],
      memorySpaceId: space.data.id,
    });
    const run = await grantedFlushRun(platform, put, scope, space.data.id);
    await platform.enqueueFlush(scope, run, { memorySpaceId: space.data.id });

    expect(clientRequestTokens.filter(Boolean)).toEqual([]);
  });

  it("conditions grant creation on the memory space remaining active", async () => {
    const fixture = memoryDatabase();
    let sawActiveSpaceCondition = false;
    const database: DynamoDatabaseService = {
      ...fixture.database,
      transactWrite: (operations, token) => {
        if (
          operations.some(
            (operation) =>
              operation.kind === "condition-check" &&
              operation.expressionAttributeValues?.[":itemType"] === "memory-space" &&
              operation.expressionAttributeValues?.[":status"] === "active",
          )
        ) {
          sawActiveSpaceCondition = true;
          return Promise.reject(new Error("memory space archived concurrently"));
        }
        return fixture.database.transactWrite(operations, token);
      },
    };
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(scope, { name: "Grant race" });

    expect(
      platform.grantMemorySpace(scope, {
        agentDefinitionId: ids.agent,
        memorySpaceId: space.data.id,
        permission: "read-write",
      }),
    ).rejects.toThrow("memory space archived concurrently");
    expect(sawActiveSpaceCondition).toBe(true);
  });
});
