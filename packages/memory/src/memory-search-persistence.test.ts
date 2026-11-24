import type { DynamoDatabaseService } from "@deployments-ai/db";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { makeMemoryPlatform } from "./platform.ts";
import { fixedNow, memoryDatabase } from "./platform-pagination-reconciliation-fixtures.ts";
import { ids, memoryFixture } from "./test-fixtures.ts";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";

function completesRecall(operations: Parameters<DynamoDatabaseService["transactWrite"]>[0]) {
  return operations.some(
    (operation) =>
      operation.kind === "put" &&
      operation.record.itemType === "memory-recall-attempt" &&
      operation.record.data.status === "completed",
  );
}

interface PhaseLatenciesMs {
  readonly embedding: number;
  readonly embeddingPreparation?: number;
  readonly search?: number;
}

async function phaseBudgetedSearch(latenciesMs: PhaseLatenciesMs) {
  const base = memoryDatabase();
  const search = fakeMemorySearchProvider();
  const platform = makeMemoryPlatform({
    database: base.database,
    embedding: async (request) => {
      vi.advanceTimersByTime(latenciesMs.embeddingPreparation ?? 0);
      const providerSignal = request.providerSignal?.();
      // The provider call is asynchronous, so search observes its start before its latency elapses.
      await new Promise<void>((resolve) => setImmediate(resolve));
      vi.advanceTimersByTime(latenciesMs.embedding);
      providerSignal?.throwIfAborted();
      return { embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" };
    },
    now: () => fixedNow,
    searchProvider: {
      ...search.provider,
      query: async (request) => {
        vi.advanceTimersByTime(latenciesMs.search ?? 0);
        request.signal?.throwIfAborted();
        return search.provider.query(request);
      },
    },
  });
  const scope = {
    environmentId: ids.environment,
    organizationId: ids.organization,
    projectId: ids.project,
  };
  const space = await platform.createMemorySpace(scope, { name: "Phase budgets" });
  await platform.upsertPolicy(scope, {
    processingConfig: {
      memoryRetrieval: { deadlineMs: 1_000, phaseDeadlineMs: 120 },
    },
  });
  const memory = memoryFixture({
    memorySpaceId: space.data.id,
    scope: "organization",
    searchKey: `organization:${ids.organization}`,
    workspaceId: undefined,
  });
  base.put("control", memory);
  search.rows.set(memory.data.id, {
    contentHash: memory.data.contentHash,
    id: memory.data.id,
    memorySpaceId: memory.data.memorySpaceId,
    memoryVersion: memory.data.version,
    reviewStatus: "approved",
    scopeKey: `organization:${ids.organization}`,
    searchKey: memory.data.searchKey,
    sensitivity: "internal",
    status: "active",
  });
  vi.useFakeTimers();
  return {
    recallAttempts: () =>
      [...(base.tables.get("execution")?.values() ?? [])].flatMap((record) =>
        record.itemType === "memory-recall-attempt" ? [record.data] : [],
      ),
    search: () =>
      platform.search(scope, {
        memorySpaceIds: [space.data.id],
        query: "synthetic delivery preference",
      }),
  };
}

describe("memory search persistence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses an independent deadline for completed-recall persistence", async () => {
    const base = memoryDatabase();
    let persistenceSignal: AbortSignal | undefined;
    let retrievalSignal: AbortSignal | undefined;
    const database: DynamoDatabaseService = {
      ...base.database,
      transactWrite: (operations, clientRequestToken, signal) => {
        if (!completesRecall(operations)) {
          return base.database.transactWrite(operations, clientRequestToken, signal);
        }
        persistenceSignal = signal;
        return (async () => {
          await Bun.sleep(125);
          if (signal?.aborted) throw signal.reason;
          await base.database.transactWrite(operations, clientRequestToken, signal);
        })();
      },
    };
    const platform = makeMemoryPlatform({
      database,
      embedding: async (request) => {
        retrievalSignal = request.signal;
        return { embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" };
      },
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(scope, { name: "Persistence budget" });
    await platform.upsertPolicy(scope, {
      processingConfig: {
        memoryRetrieval: { deadlineMs: 100, persistenceDeadlineMs: 500 },
      },
    });

    expect(
      platform.search(scope, {
        memorySpaceIds: [space.data.id],
        query: "deployment marker",
      }),
    ).resolves.toMatchObject({ attempt: { data: { status: "completed" } } });
    expect(retrievalSignal).toBeDefined();
    expect(persistenceSignal).toBeDefined();
    expect(persistenceSignal).not.toBe(retrievalSignal);
  });

  it("gives embedding and candidate search independent phase deadlines", async () => {
    const recall = await phaseBudgetedSearch({ embedding: 80, search: 80 });

    const result = await recall.search();

    expect(result.attempt.data).toMatchObject({ retrievedCount: 1, status: "completed" });
  });

  it("embeds when preparation before the provider call outlasts the phase deadline", async () => {
    const recall = await phaseBudgetedSearch({ embedding: 20, embeddingPreparation: 200 });

    const result = await recall.search();

    expect(result.attempt.data).toMatchObject({
      phaseTimingsMs: { embedding: 20, embeddingPreparation: 200 },
      retrievedCount: 1,
      status: "completed",
    });
  });

  it("aborts a provider call that outlasts the phase deadline", async () => {
    const recall = await phaseBudgetedSearch({ embedding: 300 });

    expect(recall.search()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(recall.recallAttempts()).toMatchObject([
      { failureStage: "embedding", phaseTimingsMs: { embedding: 300 }, status: "failed" },
    ]);
  });

  it("retains phase and candidate telemetry when final persistence fails", async () => {
    const base = memoryDatabase();
    const database: DynamoDatabaseService = {
      ...base.database,
      transactWrite: (operations, clientRequestToken, signal) =>
        completesRecall(operations)
          ? Promise.reject(new Error("completed recall persistence unavailable"))
          : base.database.transactWrite(operations, clientRequestToken, signal),
    };
    const search = fakeMemorySearchProvider();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: search.provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(scope, { name: "Failed persistence" });
    const memory = memoryFixture({
      memorySpaceId: space.data.id,
      scope: "organization",
      searchKey: `organization:${ids.organization}`,
      workspaceId: undefined,
    });
    base.put("control", memory);
    search.rows.set(memory.data.id, {
      contentHash: memory.data.contentHash,
      id: memory.data.id,
      memorySpaceId: memory.data.memorySpaceId,
      memoryVersion: memory.data.version,
      reviewStatus: "approved",
      scopeKey: `organization:${ids.organization}`,
      searchKey: memory.data.searchKey,
      sensitivity: "internal",
      status: "active",
    });

    expect(
      platform.search(scope, {
        memorySpaceIds: [space.data.id],
        query: "deployment marker",
      }),
    ).rejects.toThrow("completed recall persistence unavailable");
    const attempts = [...(base.tables.get("execution")?.values() ?? [])].filter(
      (record) => record.itemType === "memory-recall-attempt",
    );
    expect(attempts).toHaveLength(1);
    const failed = attempts.find(
      (record) => record.itemType === "memory-recall-attempt" && record.data.status === "failed",
    );

    expect(failed?.data).toMatchObject({
      candidateCount: 1,
      denseCandidateCount: 1,
      failureStage: "persistence",
      plannerModel: "test",
      plannerProvider: "test",
      provider: "aws-native",
      retrievedCount: 1,
    });
    expect(failed?.data.phaseTimingsMs).toMatchObject({
      embedding: expect.any(Number),
      hydration: expect.any(Number),
      persistence: expect.any(Number),
      placement: expect.any(Number),
      policy: expect.any(Number),
      preparation: expect.any(Number),
      search: expect.any(Number),
      selection: expect.any(Number),
    });
  });
});
