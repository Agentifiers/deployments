import type {
  DynamoDatabaseService,
  PlatformRecord,
  QueryRecordsResult,
  TransactionOperation,
  Ulid,
} from "@deployments-ai/db";
import { describe, expect, it } from "bun:test";
import { makeMemoryPlatform } from "./platform.ts";
import { ids, memoryFixture, optionalExpressionString } from "./test-fixtures.ts";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";
const fixedNow = new Date("2026-07-21T18:00:00.000Z");
const observability = {
  captureMode: "metadata-only" as const,
  runSpanId: "0123456789abcdef" as const,
  sessionId: ids.thread,
  traceId: "0123456789abcdef0123456789abcdef" as const,
};
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
    putRecord: async (record, conditionExpression) => {
      const name = record.itemType === "semantic-event" ? "events" : tableName(record);
      const recordKey = `${record.pk}\u0000${record.sk}`;
      if (conditionExpression?.includes("attribute_not_exists") && table(name).has(recordKey)) {
        throw new Error("conditional write failed");
      }
      put(name, record);
    },
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
    record.itemType === "memory-review-item" ||
    record.itemType === "memory-shadow-job"
  ) {
    return "execution";
  }
  return "control";
}

describe("memory platform", () => {
  it("uses the provider-search deadline independently of the generic phase deadline", async () => {
    const { database } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: {
        ...fakeMemorySearchProvider().provider,
        delete: async () => ({ status: "synchronized" }),
        readiness: async () => ({
          denseReady: true,
          lexicalReady: true,
          reference: "test",
          ready: true,
          schemaReady: true,
        }),
        query: async () => {
          await Bun.sleep(50);
          return [];
        },
        queryExact: async () => [],
        queryLexical: async () => {
          await Bun.sleep(50);
          return [];
        },
        synchronizeLifecycle: async () => ({ status: "synchronized" }),
        write: async () => ({ status: "written" }),
      },
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(scope, { name: "Search deadline" });
    await platform.upsertPolicy(scope, {
      activeRecallEnabled: true,
      activeRecallRolloutPercent: 100,
      processingConfig: {
        memoryRetrieval: {
          phaseDeadlineMs: 20,
          rolloutPercent: 100,
          searchDeadlineMs: 100,
          strategy: "hybrid-rrf-v1",
        },
      },
    });

    const result = await platform.search(scope, {
      memorySpaceIds: [space.data.id],
      purpose: "active-recall",
      query: "deployment marker",
      runId: ids.run,
      threadId: ids.thread,
    });

    expect(result.attempt.data).toMatchObject({
      status: "completed",
      strategy: "hybrid-rrf-v1",
    });
    expect(result.attempt.data.phaseTimingsMs?.search).toBeGreaterThanOrEqual(50);
  });

  it("bounds the complete rerank operation by its phase deadline", async () => {
    const { database, put } = memoryDatabase();
    let rerankDeadlineMs: number | undefined;
    let rerankSignal: AbortSignal | undefined;
    const rows: {
      contentHash: string;
      dist: number;
      id: string;
      memorySpaceId: string;
      memoryVersion: number;
      scopeKey: string;
      searchKey: string;
    }[] = [];
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      rerank: async (request) => {
        rerankDeadlineMs = request.deadlineMs;
        rerankSignal = request.signal;
        await Bun.sleep(200);
        return {
          latencyMs: 200,
          model: "test-reranker",
          provider: "test",
          scores: request.candidates.map((candidate, index) => ({
            memoryId: candidate.memory.data.id,
            score: 1 - index / 10,
          })),
        };
      },
      searchProvider: {
        ...fakeMemorySearchProvider().provider,
        delete: async () => ({ status: "synchronized" }),
        readiness: async () => ({
          denseReady: true,
          lexicalReady: true,
          reference: "test",
          ready: true,
          schemaReady: true,
        }),
        query: async () => rows,
        queryExact: async () => [],
        queryLexical: async () => rows,
        synchronizeLifecycle: async () => ({ status: "synchronized" }),
        write: async () => ({ status: "written" }),
      },
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(scope, { name: "Rerank deadline" });
    for (const memory of [
      memoryFixture({
        id: indexedUlid(13_490),
        memorySpaceId: space.data.id,
        scope: "organization",
        searchKey: `organization:${ids.organization}`,
        workspaceId: undefined,
      }),
      memoryFixture({
        id: indexedUlid(13_491),
        memorySpaceId: space.data.id,
        scope: "organization",
        searchKey: `organization:${ids.organization}`,
        workspaceId: undefined,
      }),
    ]) {
      put("control", memory);
      rows.push({
        contentHash: memory.data.contentHash,
        dist: rows.length / 10,
        id: memory.data.id,
        memorySpaceId: memory.data.memorySpaceId,
        memoryVersion: memory.data.version,
        scopeKey: `organization:${ids.organization}`,
        searchKey: memory.data.searchKey,
      });
    }
    await platform.upsertPolicy(scope, {
      processingConfig: {
        memoryRetrieval: {
          deadlineMs: 1_100,
          rerankDeadlineMs: 50,
          rolloutPercent: 100,
          strategy: "hybrid-rerank-v1",
        },
      },
    });

    const startedAt = Date.now();
    await platform.search(scope, {
      memorySpaceIds: [space.data.id],
      query: "deployment marker",
      strategyOverride: "hybrid-rerank-v1",
    });
    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(rerankSignal?.aborted).toBe(true);
    expect(rerankDeadlineMs).toBeGreaterThan(0);
    expect(rerankDeadlineMs).toBeLessThanOrEqual(50);
  });

  it("executes a queued shadow override even when served rollout is zero", async () => {
    const { database } = memoryDatabase();
    let embeddingCalls = 0;
    let lexicalQueries = 0;
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => {
        embeddingCalls += 1;
        return { embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" };
      },
      now: () => fixedNow,
      searchProvider: {
        ...fakeMemorySearchProvider().provider,
        delete: async () => ({ status: "synchronized" }),
        readiness: async () => ({
          denseReady: true,
          lexicalReady: true,
          reference: "test",
          ready: true,
          schemaReady: true,
        }),
        query: async () => [],
        queryExact: async () => [],
        queryLexical: async () => {
          lexicalQueries += 1;
          return [];
        },
        synchronizeLifecycle: async () => ({ status: "synchronized" }),
        write: async () => ({ status: "written" }),
      },
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(scope, { name: "Shadow override" });
    await platform.upsertPolicy(scope, {
      processingConfig: {
        memoryRetrieval: { rolloutPercent: 0, strategy: "hybrid-rrf-v1" },
      },
    });

    const shadowAttemptId = indexedUlid(13_500);
    const shadowOfAttemptId = indexedUlid(13_501);
    const input = {
      memorySpaceIds: [space.data.id],
      query: "deployment marker",
      shadow: true,
      shadowAttemptId,
      shadowOfAttemptId,
      strategyOverride: "hybrid-rrf-v1",
    } as const;
    const result = await platform.search(scope, input);
    const replay = await platform.search(scope, input);

    expect(result.attempt.data.strategy).toBe("hybrid-rrf-v1");
    expect(result.attempt.data.id).toBe(shadowAttemptId);
    expect(replay.attempt.data.id).toBe(shadowAttemptId);
    expect(embeddingCalls).toBe(1);
    expect(lexicalQueries).toBe(1);
  });

  it("serves a trusted explicit strategy override outside rollout", async () => {
    const { database } = memoryDatabase();
    let lexicalQueries = 0;
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: {
        ...fakeMemorySearchProvider().provider,
        delete: async () => ({ status: "synchronized" }),
        readiness: async () => ({
          denseReady: true,
          lexicalReady: true,
          reference: "test",
          ready: true,
          schemaReady: true,
        }),
        query: async () => [],
        queryExact: async () => [],
        queryLexical: async () => {
          lexicalQueries += 1;
          return [];
        },
        synchronizeLifecycle: async () => ({ status: "synchronized" }),
        write: async () => ({ status: "written" }),
      },
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(scope, { name: "Strategy evidence" });
    await platform.upsertPolicy(scope, {
      processingConfig: {
        memoryRetrieval: { rolloutPercent: 0, strategy: "hybrid-rrf-v1" },
      },
    });

    const result = await platform.search(scope, {
      memorySpaceIds: [space.data.id],
      query: "deployment marker",
      strategyOverride: "hybrid-rrf-v1",
    });

    expect(result.attempt.data.strategy).toBe("hybrid-rrf-v1");
    expect(lexicalQueries).toBe(1);
  });

  it("shadows a partial rollout target only while dense is served", async () => {
    const { database, tables } = memoryDatabase();
    let lexicalQueries = 0;
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: {
        ...fakeMemorySearchProvider().provider,
        delete: async () => ({ status: "synchronized" }),
        readiness: async () => ({
          denseReady: true,
          lexicalReady: true,
          reference: "test",
          ready: true,
          schemaReady: true,
        }),
        query: async () => [],
        queryExact: async () => [],
        queryLexical: async () => {
          lexicalQueries += 1;
          return [];
        },
        synchronizeLifecycle: async () => ({ status: "synchronized" }),
        write: async () => ({ status: "written" }),
      },
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(scope, { name: "Partial rollout shadow" });
    await platform.upsertPolicy(scope, {
      processingConfig: {
        memoryRetrieval: {
          rolloutPercent: 0,
          shadowRolloutPercent: 100,
          shadowStrategy: "hybrid-rrf-v1",
          strategy: "hybrid-rrf-v1",
        },
      },
    });

    const dense = await platform.search(scope, {
      memorySpaceIds: [space.data.id],
      observability,
      query: "deployment marker",
    });
    expect(dense.attempt.data.strategy).toBe("dense-v1");
    const shadowEvents = [...(tables.get("events")?.values() ?? [])].filter(
      (record): record is Extract<PlatformRecord, { readonly itemType: "semantic-event" }> =>
        record.itemType === "semantic-event" && record.data.eventType === "memory.shadow.queued",
    );
    expect(shadowEvents).toHaveLength(1);
    expect(shadowEvents[0]!.data.payload).toEqual({ jobId: expect.any(String) });
    expect(JSON.stringify(shadowEvents[0]!.data.payload)).not.toContain("deployment marker");
    const shadowJobs = [...(tables.get("execution")?.values() ?? [])].filter(
      (record) => record.itemType === "memory-shadow-job",
    );
    expect(shadowJobs).toHaveLength(1);
    expect(shadowJobs[0]?.data).toMatchObject({
      expiresAt: expect.any(String),
      input: {
        observability,
        query: "deployment marker",
        shadow: true,
        strategyOverride: "hybrid-rrf-v1",
      },
    });
    expect(shadowJobs[0]?.data.input.targetId).toBeString();
    expect(shadowJobs[0]?.ttl).toBeNumber();
    expect(lexicalQueries).toBe(0);

    await platform.executeShadowJob(scope, shadowJobs[0]!.data.id);
    expect(lexicalQueries).toBe(1);
    expect(
      [...(tables.get("execution")?.values() ?? [])].filter(
        (record) => record.itemType === "memory-shadow-job",
      ),
    ).toEqual([]);
    await platform.executeShadowJob(scope, shadowJobs[0]!.data.id);
    expect(lexicalQueries).toBe(1);

    await platform.upsertPolicy(scope, {
      processingConfig: {
        memoryRetrieval: {
          rolloutPercent: 100,
          shadowRolloutPercent: 100,
          shadowStrategy: "hybrid-rrf-v1",
          strategy: "hybrid-rrf-v1",
        },
      },
    });
    const hybrid = await platform.search(scope, {
      memorySpaceIds: [space.data.id],
      query: "deployment marker",
    });
    expect(hybrid.attempt.data.strategy).toBe("hybrid-rrf-v1");
    expect(
      [...(tables.get("events")?.values() ?? [])].filter(
        (record) =>
          record.itemType === "semantic-event" && record.data.eventType === "memory.shadow.queued",
      ),
    ).toHaveLength(1);
    expect(lexicalQueries).toBe(2);
  });

  it("retains a shadow job when duplicate delivery observes a fresh running claim", async () => {
    const { database, tables } = memoryDatabase();
    let embeddingCalls = 0;
    let markShadowStarted: (() => void) | undefined;
    let releaseShadow: (() => void) | undefined;
    const shadowStarted = new Promise<void>((resolve) => {
      markShadowStarted = resolve;
    });
    const shadowRelease = new Promise<void>((resolve) => {
      releaseShadow = resolve;
    });
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => {
        embeddingCalls += 1;
        if (embeddingCalls === 2) {
          markShadowStarted?.();
          await shadowRelease;
        }
        return { embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" };
      },
      now: () => fixedNow,
      searchProvider: {
        ...fakeMemorySearchProvider().provider,
        delete: async () => ({ status: "synchronized" }),
        readiness: async () => ({
          denseReady: true,
          lexicalReady: true,
          reference: "test",
          ready: true,
          schemaReady: true,
        }),
        query: async () => [],
        queryExact: async () => [],
        queryLexical: async () => [],
        synchronizeLifecycle: async () => ({ status: "synchronized" }),
        write: async () => ({ status: "written" }),
      },
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(scope, { name: "Running shadow claim" });
    await platform.upsertPolicy(scope, {
      processingConfig: {
        memoryRetrieval: {
          rolloutPercent: 0,
          shadowRolloutPercent: 100,
          shadowStrategy: "hybrid-rrf-v1",
          strategy: "hybrid-rrf-v1",
        },
      },
    });
    await platform.search(scope, {
      memorySpaceIds: [space.data.id],
      query: "deployment marker",
    });
    const shadowJob = [...(tables.get("execution")?.values() ?? [])].find(
      (record) => record.itemType === "memory-shadow-job",
    );
    expect(shadowJob?.itemType).toBe("memory-shadow-job");
    if (!shadowJob || shadowJob.itemType !== "memory-shadow-job") throw new Error("missing job");

    const shadowInput = shadowJob.data.input;
    const runningSearch = platform.search(scope, {
      memorySpaceIds: shadowInput.memorySpaceIds,
      query: shadowInput.query,
      shadow: true,
      shadowAttemptId: shadowInput.shadowAttemptId,
      shadowOfAttemptId: shadowInput.shadowOfAttemptId,
      strategyOverride: shadowInput.strategyOverride,
      ...(shadowInput.allowedScopeKeys ? { allowedScopeKeys: shadowInput.allowedScopeKeys } : {}),
      ...(shadowInput.purpose ? { purpose: shadowInput.purpose } : {}),
      ...(shadowInput.runId && shadowInput.threadId
        ? { runId: shadowInput.runId, threadId: shadowInput.threadId }
        : {}),
      ...(shadowInput.searchKeys ? { searchKeys: shadowInput.searchKeys } : {}),
      ...(shadowInput.toolCallId ? { toolCallId: shadowInput.toolCallId } : {}),
      ...(shadowInput.topK === undefined ? {} : { topK: shadowInput.topK }),
    });
    await shadowStarted;
    const duplicate = await platform.executeShadowJob(scope, shadowJob.data.id);

    expect(duplicate?.attempt.data.status).toBe("running");
    expect(
      [...(tables.get("execution")?.values() ?? [])].filter(
        (record) => record.itemType === "memory-shadow-job",
      ),
    ).toHaveLength(1);

    releaseShadow?.();
    await runningSearch;
    await platform.executeShadowJob(scope, shadowJob.data.id);
    expect(
      [...(tables.get("execution")?.values() ?? [])].filter(
        (record) => record.itemType === "memory-shadow-job",
      ),
    ).toEqual([]);
  });
});
