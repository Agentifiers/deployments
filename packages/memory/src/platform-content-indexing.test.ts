import { describe, expect, it } from "bun:test";
import type { DynamoDatabaseService, PlatformRecord, Ulid } from "@deployments-ai/db";
import { DatabaseError, withCanonicalRecordKeys } from "@deployments-ai/db";
import { memoryContentHash } from "./governance.ts";
import { ids, memoryFixture } from "./test-fixtures.ts";
import { makeMemoryPlatform } from "./platform.ts";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";
import { fixedNow, indexedUlid, memoryDatabase } from "./platform-indexing-test-fixtures.ts";

describe("memory platform", () => {
  it("keeps observability attribution canonical but redacts every public memory response", async () => {
    const { database, tables } = memoryDatabase();
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
      workspaceId: ids.workspace,
    };
    const observability = {
      captureMode: "metadata-only" as const,
      runSpanId: "2b7e151628aed2a6",
      sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid,
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      workspaceId: ids.workspace,
    };
    const space = await platform.createMemorySpace(scope, {
      kind: "workspace",
      name: "Attributed memory",
      workspaceId: ids.workspace,
    });
    const imported = await platform.importMemories(scope, {
      items: [
        {
          content: "Production deploys use the Tuesday change window.",
          observability,
          scope: "workspace",
          workspaceId: ids.workspace,
        },
      ],
      memorySpaceId: space.data.id,
    });
    expect(imported.imported[0]?.data).not.toHaveProperty("observability");
    const stored = [...(tables.get("control")?.values() ?? [])].find(
      (record) => record.itemType === "memory",
    );
    expect(stored?.data).toHaveProperty("observability", observability);

    const review = (await platform.listReviewItems(scope, { status: "open" }))[0]!;
    const approved = await platform.resolveReview(scope, {
      decision: "approve",
      memoryId: imported.imported[0]!.data.id,
      reviewId: review.data.id,
    });
    expect(approved.memory.data).not.toHaveProperty("observability");
    await platform.processIndexJob(scope, {
      idempotencyKey: `${approved.memory.data.id}:1:${fixedNow.getTime() * 1_000 + 1}:update`,
      memoryId: approved.memory.data.id,
    });

    const listed = await platform.listMemoriesPage(scope, { memorySpaceId: space.data.id });
    const exported = await platform.exportMemoriesPage(scope, { memorySpaceId: space.data.id });
    const recalled = await platform.search(scope, {
      memorySpaceIds: [space.data.id],
      observability,
      query: "When are production deploys?",
      searchKeys: [`workspace:${ids.workspace}`],
    });
    expect(listed.items[0]?.data).not.toHaveProperty("observability");
    expect(exported.items[0]?.data).not.toHaveProperty("observability");
    expect(recalled.attempt.data).not.toHaveProperty("observability");
    expect(recalled.results[0]?.memory.data).not.toHaveProperty("observability");

    const archived = await platform.archiveMemory(scope, approved.memory.data.id);
    const restored = await platform.restoreMemory(scope, approved.memory.data.id);
    const rearchived = await platform.archiveMemory(scope, approved.memory.data.id);
    const deleted = await platform.deleteMemory(scope, approved.memory.data.id);
    for (const memory of [archived, restored, rearchived, deleted]) {
      expect(memory.data).not.toHaveProperty("observability");
    }
  });

  it("persists canonical imports without resolving provider credentials", async () => {
    const { database, put, transactions } = memoryDatabase();
    const target = {
      componentIds: [ids.space],
      embeddingProfileId: ids.agent,
      location: { region: "aws-us-east-2" },
      providerId: "aws-native" as const,
      schemaGeneration: 1,
      targetId: ids.toolCall,
    };
    const candidate = { ...target, targetId: ids.run };
    let providerResolutions = 0;
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchPlacementResolver: async () => {
        providerResolutions += 1;
        throw new Error("provider credentials unavailable");
      },
      searchRoutingResolver: async () => ({
        candidate: { providerId: candidate.providerId, target: candidate },
        fenceEpoch: 7,
        fenceVersion: 3,
        placementGeneration: 5,
        placementPhase: "active",
        placementVersion: 4,
        read: { providerId: target.providerId, target },
        writes: [{ providerId: target.providerId, target }],
      }),
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
      workspaceId: ids.workspace,
    };
    const space = await platform.createMemorySpace(scope, {
      kind: "workspace",
      name: "Credential-independent",
    });

    const predecessor = memoryFixture({
      memorySpaceId: space.data.id,
      scope: "thread",
      threadId: ids.thread,
    });
    put("control", predecessor);
    expect(
      platform.importMemories(scope, {
        items: [
          {
            content: "Supersession also survives provider outages.",
            scope: "thread",
            source: "tool",
            supersedesMemoryId: predecessor.data.id,
            threadId: ids.thread,
            workspaceId: ids.workspace,
          },
        ],
        memorySpaceId: space.data.id,
      }),
    ).resolves.toMatchObject({ imported: [expect.any(Object)] });
    const gateChecks = transactions
      .at(-1)
      ?.filter(
        (operation) =>
          operation.kind === "condition-check" &&
          operation.expressionAttributeValues?.[":itemType"] === "memory-provider-mutation-gate",
      );
    expect(gateChecks).toHaveLength(2);
    const jobs = transactions
      .at(-1)
      ?.flatMap((operation) =>
        operation.kind === "put" && operation.record.itemType === "memory-index-job"
          ? [operation.record]
          : [],
      );
    expect(jobs?.map((job) => job.data.targetId).toSorted()).toEqual(
      [target.targetId, candidate.targetId, target.targetId, candidate.targetId].toSorted(),
    );
    expect(providerResolutions).toBe(0);
  });

  it("keeps lifecycle events contiguous after storage-only redispatch deferrals", async () => {
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
      workspaceId: ids.workspace,
    };
    const memory = memoryFixture();
    put("control", memory);
    const queued = await platform.enqueueIndexJob({
      memory,
      scope,
      synchronizationGeneration: 7,
    });
    const { eventVersion: _legacyMissingEventVersion, ...queuedData } = queued.data;
    put(
      "execution",
      withCanonicalRecordKeys({
        data: {
          ...queuedData,
          nextDueAt: "2026-07-21T18:10:00.000Z",
          updatedAt: "2026-07-21T18:05:00.000Z",
          version: queued.data.version + 7,
        },
        itemType: "memory-index-job" as const,
      }) as PlatformRecord,
    );

    const completed = await platform.processIndexJob(scope, {
      idempotencyKey: queued.data.idempotencyKey,
      memoryId: memory.data.id,
    });
    const lifecycleVersions = [...(tables.get("events")?.values() ?? [])]
      .filter(
        (record) =>
          record.itemType === "semantic-event" && record.data.aggregateId === queued.data.id,
      )
      .map((record) =>
        record.itemType === "semantic-event" ? record.data.aggregateVersion : Number.NaN,
      )
      .toSorted((left, right) => left - right);

    expect(completed.data).toMatchObject({ eventVersion: 3, status: "succeeded", version: 9 });
    expect(lifecycleVersions).toEqual([1, 2, 3]);
  });

  it("retries only the conflicted import item after a write conflict", async () => {
    const fixture = memoryDatabase();
    let createAttempts = 0;
    const database: DynamoDatabaseService = {
      ...fixture.database,
      transactWrite: (operations, token) => {
        if (
          operations.some(
            (operation) =>
              operation.kind === "put" &&
              operation.record.itemType === "memory" &&
              !operation.previousRecord,
          )
        ) {
          createAttempts += 1;
          if (createAttempts === 2) {
            return Promise.reject(
              new DatabaseError({
                cause: { name: "TransactionCanceledException" },
                message: "memory changed",
                operation: "transact-write",
                reason: "conflict",
                table: "control",
              }),
            );
          }
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
    const space = await platform.createMemorySpace(scope, { name: "Directory retry" });
    const result = await platform.importMemories(scope, {
      items: [
        { agentDefinitionId: ids.agent, content: "Committed batch fact.", scope: "agent" },
        { agentDefinitionId: ids.agent, content: "Retry-safe batch fact.", scope: "agent" },
      ],
      memorySpaceId: space.data.id,
    });

    expect(result.imported).toHaveLength(2);
    expect(result.replayed).toHaveLength(0);
    expect(createAttempts).toBe(3);
  });

  it("hydrates referenced memory bodies for exports", async () => {
    const { database, put } = memoryDatabase();
    const content = "Referenced durable export guidance.";
    const bytes = new TextEncoder().encode(content);
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      loadBlob: async () => bytes,
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
      workspaceId: ids.workspace,
    };
    const contentHash = memoryContentHash(content);
    const memory = memoryFixture({
      body: undefined,
      bodyRef: {
        bucket: "platform-artifacts",
        byteSize: bytes.byteLength,
        contentType: "text/plain; charset=utf-8",
        key: "memory/export-body.txt",
        sha256: contentHash,
      },
      contentHash,
    });
    put("control", memory);

    const exported = await platform.exportMemoriesPage(scope, {
      memorySpaceId: memory.data.memorySpaceId,
    });

    expect(exported.items).toHaveLength(1);
    expect(exported.items[0]?.data.body).toBe(content);
    expect(exported.items[0]?.data.bodyRef).toBeUndefined();
  });

  it("strongly revalidates stale memory list projections", async () => {
    const state = memoryDatabase();
    const stale = memoryFixture({ body: "Stale plaintext", status: "active" });
    const canonical = withCanonicalRecordKeys({
      data: {
        ...stale.data,
        body: "Legacy deleted plaintext",
        metadata: { legacySecret: "must not escape" },
        deletedAt: fixedNow.toISOString(),
        status: "deleted" as const,
        updatedAt: fixedNow.toISOString(),
        version: stale.data.version + 1,
      },
      itemType: "memory" as const,
    }) as PlatformRecord;
    state.put("control", canonical);
    let queryCalls = 0;
    const database: DynamoDatabaseService = {
      ...state.database,
      queryRecords: (table, input) =>
        queryCalls++ === 0
          ? Promise.resolve({ items: [stale] })
          : state.database.queryRecords(table, input),
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
      workspaceId: ids.workspace,
    };

    const page = await platform.listMemoriesPage(scope);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.data).toMatchObject({ id: stale.data.id, status: "deleted" });
    expect(page.items[0]?.data).not.toHaveProperty("body");
    expect(page.items[0]?.data).not.toHaveProperty("metadata");
    const listed = await platform.listMemories(scope, { all: true, status: "deleted" });
    expect(listed[0]?.data).not.toHaveProperty("body");
    expect(listed[0]?.data).not.toHaveProperty("metadata");
    const exported = await platform.exportMemoriesPage(scope, { status: "deleted" });
    expect(exported.items[0]?.data).not.toHaveProperty("body");
    expect(exported.items[0]?.data).not.toHaveProperty("metadata");
    expect(platform.exportMemoriesPage(scope, { status: "active" })).resolves.toMatchObject({
      items: [],
    });
  });

  it("hydrates and verifies referenced memory bodies in search results", async () => {
    const { database, put, tables } = memoryDatabase();
    const search = fakeMemorySearchProvider();
    const content = "Referenced durable recall guidance.";
    const bytes = new TextEncoder().encode(content);
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      loadBlob: async (reference) => {
        if (reference.key === "memory/unavailable-search-body.txt") {
          throw new Error("object unavailable");
        }
        return reference.key === "memory/search-body.txt" ? bytes : new Uint8Array([1]);
      },
      now: () => fixedNow,
      searchProvider: search.provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
      workspaceId: ids.workspace,
    };
    const space = await platform.createMemorySpace(scope, { name: "Referenced recall" });
    const contentHash = memoryContentHash(content);
    const memory = memoryFixture({
      body: undefined,
      bodyRef: {
        bucket: "platform-artifacts",
        byteSize: bytes.byteLength,
        contentType: "text/plain; charset=utf-8",
        key: "memory/search-body.txt",
        sha256: contentHash,
        versionId: "version-1",
      },
      contentHash,
      memorySpaceId: space.data.id,
    });
    put("control", memory);
    const invalidMemory = memoryFixture({
      body: undefined,
      bodyRef: {
        bucket: "platform-artifacts",
        byteSize: 2,
        contentType: "text/plain; charset=utf-8",
        key: "memory/invalid-search-body.txt",
        sha256: contentHash,
      },
      contentHash,
      id: ids.memory2,
      memorySpaceId: space.data.id,
      version: memory.data.version,
    });
    put("control", invalidMemory);
    const unavailableMemory = memoryFixture({
      body: undefined,
      bodyRef: {
        bucket: "platform-artifacts",
        byteSize: bytes.byteLength,
        contentType: "text/plain; charset=utf-8",
        key: "memory/unavailable-search-body.txt",
        sha256: contentHash,
      },
      contentHash,
      id: indexedUlid(10_001),
      memorySpaceId: space.data.id,
      version: memory.data.version,
    });
    put("control", unavailableMemory);
    search.rows.set(invalidMemory.data.id, {
      contentHash,
      id: invalidMemory.data.id,
      memorySpaceId: invalidMemory.data.memorySpaceId,
      memoryVersion: invalidMemory.data.version,
      reviewStatus: "approved",
      scopeKey: `workspace:${ids.workspace}`,
      searchKey: invalidMemory.data.searchKey,
      sensitivity: "internal",
      status: "active",
    });
    search.rows.set(memory.data.id, {
      contentHash,
      id: memory.data.id,
      memorySpaceId: memory.data.memorySpaceId,
      memoryVersion: memory.data.version,
      reviewStatus: "approved",
      scopeKey: `workspace:${ids.workspace}`,
      searchKey: memory.data.searchKey,
      sensitivity: "internal",
      status: "active",
    });
    search.rows.set(unavailableMemory.data.id, {
      contentHash,
      id: unavailableMemory.data.id,
      memorySpaceId: unavailableMemory.data.memorySpaceId,
      memoryVersion: unavailableMemory.data.version,
      reviewStatus: "approved",
      scopeKey: `workspace:${ids.workspace}`,
      searchKey: unavailableMemory.data.searchKey,
      sensitivity: "internal",
      status: "active",
    });

    const recall = await platform.search(scope, {
      memorySpaceIds: [space.data.id],
      query: "durable recall",
      topK: 1,
    });

    expect(recall.results).toHaveLength(1);
    expect(recall.results[0]?.memory.data.body).toBe(content);
    expect(recall.results[0]?.memory.data.bodyRef).toBeUndefined();
    expect(recall.attempt.data.candidateCount).toBe(1);
    expect(recall.attempt.data.retrievedCount).toBe(1);
    expect(
      [...(tables.get("execution")?.values() ?? [])].find(
        (record) => record.itemType === "memory-recall-attempt",
      ),
    ).toMatchObject({ data: { candidateCount: 3, retrievedCount: 1 } });
  });

  it("bounds quality aggregation to the requested sample size", async () => {
    const { database, put, queries } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    for (let index = 0; index < 205; index += 1) {
      const attemptId = indexedUlid(1_000 + index);
      put(
        "execution",
        withCanonicalRecordKeys({
          data: {
            candidateCount: 1,
            createdAt: fixedNow.toISOString(),
            environmentId: ids.environment,
            id: attemptId,
            injectedCount: 1,
            latencyMs: index,
            organizationId: ids.organization,
            projectId: ids.project,
            purpose: "explicit-search",
            retrievedCount: 1,
            status: "completed" as const,
            strategy: "dense-v1" as const,
            version: 0,
          },
          itemType: "memory-recall-attempt" as const,
        }) as PlatformRecord,
      );
      put(
        "execution",
        withCanonicalRecordKeys({
          data: {
            createdAt: fixedNow.toISOString(),
            environmentId: ids.environment,
            id: indexedUlid(2_000 + index),
            injected: true,
            memoryId: ids.memory,
            organizationId: ids.organization,
            projectId: ids.project,
            provider: "aws-native" as const,
            purpose: "explicit-search",
            rank: 1,
            recallAttemptId: attemptId,
            reviewStatus: "approved",
            score: 0.9,
            searchKey: `workspace:${ids.workspace}`,
            sensitivity: "internal",
            usefulness: "useful" as const,
            version: 0,
          },
          itemType: "memory-retrieval" as const,
        }) as PlatformRecord,
      );
    }

    expect(
      platform.quality(
        {
          environmentId: ids.environment,
          organizationId: ids.organization,
          projectId: ids.project,
        },
        { limit: 200 },
      ),
    ).resolves.toMatchObject({
      attempts: 200,
      completed: 200,
      retrievals: 200,
      sampleLimit: 200,
      usefulness: { useful: 200 },
    });
    expect(
      queries.filter((query) => query.input.IndexName === "gsi1").map((query) => query.table),
    ).toEqual(["execution", "execution", "execution", "execution"]);
  });
});
