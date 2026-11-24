import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { MemoryRepository } from "./repository.ts";
import { makeMemoryService } from "./service.ts";
import { ids, memoryFixture } from "./test-fixtures.ts";
import { memoryScopeKey, type CanonicalMemoryRecord } from "./memory-record.ts";
import {
  staticMemorySearchPlacementResolver,
  type MemorySearchProviderClient,
} from "./provider.ts";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";

describe("memory service", () => {
  it("uses separate AWS-native dense and lexical budgets and rejects oversized results", async () => {
    const repository = {
      getIndexState: () => Effect.succeed(undefined),
      getMemory: () => Effect.succeed(undefined),
      updateIndexState: () => Effect.die("not used"),
    } as MemoryRepository;
    const denseTopK: number[] = [];
    const lexicalTopK: number[] = [];
    let readinessChecks = 0;
    const target = {
      componentIds: [ids.run],
      embeddingProfileId: ids.toolCall,
      location: { region: "us-east-2" },
      providerId: "aws-native" as const,
      schemaGeneration: 1,
      targetId: ids.run,
    };
    const provider = {
      capabilities: {
        dense: true,
        denseResultLimit: 100,
        exact: true,
        lexical: true,
        purgeOrganization: true,
      },
      providerId: "aws-native",
      query: async (input: { readonly topK: number }) => {
        denseTopK.push(input.topK);
        return [];
      },
      queryExact: async () => [],
      queryLexical: async (input: { readonly topK: number }) => {
        lexicalTopK.push(input.topK);
        return [];
      },
      readiness: async () => {
        readinessChecks += 1;
        return {
          denseReady: true,
          lexicalReady: true,
          ready: true,
          reference: "aws-native",
          schemaReady: true,
        };
      },
      target,
    } as unknown as MemorySearchProviderClient;
    const service = makeMemoryService(repository, async () => ({
      placementGeneration: 1,
      read: provider,
      writes: [provider],
    }));
    const input = {
      allowedScopeKeys: ["workspace:test"],
      allowedSensitivities: ["internal" as const],
      embedding: [0.1, 0.2, 0.3],
      environmentId: ids.environment,
      memorySpaceIds: [ids.space],
      organizationId: ids.organization,
      projectId: ids.project,
      query: "deployment marker",
      searchKeys: ["workspace:test"],
      strategy: "hybrid-rrf-v1" as const,
      topK: 50,
    };

    await Effect.runPromise(
      service.searchEnhanced({ ...input, denseCandidateLimit: 30, resultLimit: 20 }),
    );
    expect(denseTopK).toEqual([30]);
    expect(lexicalTopK).toEqual([50]);

    expect(
      Effect.runPromise(
        service.searchEnhanced({ ...input, denseCandidateLimit: 30, resultLimit: 31 }),
      ),
    ).rejects.toMatchObject({ _tag: "MemoryIndexingError" });

    await Effect.runPromise(service.searchEnhanced({ ...input, resultLimit: 94 }));
    expect(denseTopK).toEqual([30, 94]);
    expect(lexicalTopK).toEqual([50, 94]);
    expect(readinessChecks).toBe(1);
  });

  it("routes exact and isolated ANN controls without invoking the normal provider query", async () => {
    const memory = memoryFixture();
    let approximateQueries = 0;
    let annQueries = 0;
    let exactQueries = 0;
    const row = {
      contentHash: memory.data.contentHash,
      denseSourceCandidateCounts: { "open-search": 1 },
      denseSourceDistances: { "open-search": 0.01 },
      denseSourceRanks: { "open-search": 1 },
      dist: 0.01,
      id: memory.data.id,
      memorySpaceId: memory.data.memorySpaceId,
      memoryVersion: memory.data.version,
      scopeKey: memoryScopeKey(memory),
      searchKey: memory.data.searchKey,
    };
    const provider = {
      capabilities: {
        dense: true,
        denseResultLimit: 100,
        exact: true,
        lexical: true,
        purgeOrganization: true,
      },
      providerId: "aws-native",
      query: async () => {
        approximateQueries += 1;
        return [];
      },
      queryDenseAnn: async () => {
        annQueries += 1;
        return [row];
      },
      queryDenseExact: async () => {
        exactQueries += 1;
        return [row];
      },
      target: {
        componentIds: [ids.run],
        embeddingProfileId: ids.toolCall,
        location: { region: "us-east-2" },
        providerId: "aws-native",
        schemaGeneration: 2,
        targetId: ids.run,
      },
    } as unknown as MemorySearchProviderClient;
    const repository = {
      getIndexState: () => Effect.succeed(undefined),
      getMemory: () => Effect.succeed(memory),
      updateIndexState: () => Effect.die("not used"),
    } as MemoryRepository;

    const result = await Effect.runPromise(
      makeMemoryService(repository, async () => ({
        placementGeneration: 2,
        read: provider,
        writes: [provider],
      })).searchEnhanced({
        allowedScopeKeys: [memoryScopeKey(memory)],
        allowedSensitivities: ["internal"],
        denseExactControl: true,
        embedding: [0.1, 0.2, 0.3],
        environmentId: ids.environment,
        memorySpaceIds: [ids.space],
        organizationId: ids.organization,
        projectId: ids.project,
        searchKeys: [memory.data.searchKey],
        topK: 10,
      }),
    );

    expect(result.results[0]).toMatchObject({
      denseSourceDistances: { "open-search": 0.01 },
      denseSourceRanks: { "open-search": 1 },
      memory: { data: { id: memory.data.id } },
    });
    expect(result.counts).toMatchObject({ denseOpenSearch: 1 });

    const annResult = await Effect.runPromise(
      makeMemoryService(repository, async () => ({
        placementGeneration: 2,
        read: provider,
        writes: [provider],
      })).searchEnhanced({
        allowedScopeKeys: [memoryScopeKey(memory)],
        allowedSensitivities: ["internal"],
        denseAnnControl: true,
        embedding: [0.1, 0.2, 0.3],
        environmentId: ids.environment,
        memorySpaceIds: [ids.space],
        organizationId: ids.organization,
        projectId: ids.project,
        searchKeys: [memory.data.searchKey],
        topK: 10,
      }),
    );
    expect(annResult.results[0]).toMatchObject({
      denseSourceRanks: { "open-search": 1 },
      memory: { data: { id: memory.data.id } },
    });
    expect({ annQueries, approximateQueries, exactQueries }).toEqual({
      annQueries: 1,
      approximateQueries: 0,
      exactQueries: 1,
    });
  });

  it("fails a requested hybrid search when lexical readiness is unavailable", async () => {
    const repository = {
      getIndexState: () => Effect.succeed(undefined),
      getMemory: () => Effect.succeed(undefined),
      updateIndexState: () => Effect.die("not used"),
    } as MemoryRepository;
    let denseQueries = 0;
    const target = {
      componentIds: [ids.run],
      embeddingProfileId: ids.toolCall,
      location: { region: "us-east-2" },
      providerId: "aws-native" as const,
      schemaGeneration: 1,
      targetId: ids.run,
    };
    const provider = {
      capabilities: {
        dense: true,
        denseResultLimit: 30,
        exact: true,
        lexical: true,
        purgeOrganization: true,
      },
      providerId: "aws-native",
      query: async () => {
        denseQueries += 1;
        return [];
      },
      queryExact: async () => [],
      queryLexical: async () => [],
      readiness: async () => ({
        denseReady: true,
        lexicalReady: false,
        ready: false,
        reference: "aws-native",
        schemaReady: false,
      }),
      target,
    } as unknown as MemorySearchProviderClient;
    const service = makeMemoryService(repository, async () => ({
      placementGeneration: 1,
      read: provider,
      writes: [provider],
    }));

    expect(
      Effect.runPromise(
        service.searchEnhanced({
          allowedScopeKeys: ["workspace:test"],
          allowedSensitivities: ["internal"],
          embedding: [0.1, 0.2, 0.3],
          environmentId: ids.environment,
          memorySpaceIds: [ids.space],
          organizationId: ids.organization,
          projectId: ids.project,
          query: "deployment marker",
          searchKeys: ["workspace:test"],
          strategy: "hybrid-rrf-v1",
          topK: 20,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "MemoryIndexingError",
      message: "Memory search provider is not ready for the requested hybrid strategy.",
    });
    expect(denseQueries).toBe(1);
  });

  it("starts hybrid provider queries while readiness is being checked", async () => {
    const repository = {
      getIndexState: () => Effect.succeed(undefined),
      getMemory: () => Effect.succeed(undefined),
      updateIndexState: () => Effect.die("not used"),
    } as MemoryRepository;
    const readinessStarted = Promise.withResolvers<void>();
    const releaseReadiness = Promise.withResolvers<void>();
    let denseStarted = false;
    let lexicalStarted = false;
    const target = {
      componentIds: [ids.run],
      embeddingProfileId: ids.toolCall,
      location: { region: "us-east-2" },
      providerId: "aws-native" as const,
      schemaGeneration: 1,
      targetId: ids.run,
    };
    const provider = {
      capabilities: {
        dense: true,
        denseResultLimit: 30,
        exact: true,
        lexical: true,
        purgeOrganization: true,
      },
      providerId: "aws-native",
      query: async () => {
        denseStarted = true;
        return [];
      },
      queryExact: async () => [],
      queryLexical: async () => {
        lexicalStarted = true;
        return [];
      },
      readiness: async () => {
        readinessStarted.resolve();
        await releaseReadiness.promise;
        return {
          denseReady: true,
          lexicalReady: true,
          ready: true,
          reference: "aws-native",
          schemaReady: true,
        };
      },
      target,
    } as unknown as MemorySearchProviderClient;
    const service = makeMemoryService(repository, async () => ({
      placementGeneration: 1,
      read: provider,
      writes: [provider],
    }));
    const search = Effect.runPromise(
      service.searchEnhanced({
        allowedScopeKeys: ["workspace:test"],
        allowedSensitivities: ["internal"],
        embedding: [0.1, 0.2, 0.3],
        environmentId: ids.environment,
        memorySpaceIds: [ids.space],
        organizationId: ids.organization,
        projectId: ids.project,
        query: "deployment marker",
        searchKeys: ["workspace:test"],
        strategy: "hybrid-rrf-v1",
        topK: 20,
      }),
    );

    await readinessStarted.promise;
    await Promise.resolve();
    const queriesStartedBeforeReadinessCompleted = { denseStarted, lexicalStarted };
    releaseReadiness.resolve();
    await search;

    expect(queriesStartedBeforeReadinessCompleted).toEqual({
      denseStarted: true,
      lexicalStarted: true,
    });
  });

  it("revalidates search candidates against canonical DynamoDB state", async () => {
    const valid = memoryFixture();
    const stale = memoryFixture({ id: ids.memory2, version: 4 });
    let queryTopK = 0;
    const repository = {
      getIndexState: () => Effect.succeed(undefined),
      getMemory: (_scope, memoryId) =>
        Effect.succeed(
          memoryId === ids.memory ? valid : memoryId === ids.memory2 ? stale : undefined,
        ),
      updateIndexState: () => Effect.die("not used"),
    } as MemoryRepository;
    const search = fakeMemorySearchProvider({
      query: async (input) => {
        queryTopK = input.topK;
        return [
          {
            contentHash: valid.data.contentHash,
            dist: 0.1,
            id: valid.data.id,
            memorySpaceId: valid.data.memorySpaceId,
            memoryVersion: valid.data.version,
            scopeKey: memoryScopeKey(valid),
            searchKey: valid.data.searchKey,
          },
          {
            contentHash: stale.data.contentHash,
            dist: 0.2,
            id: stale.data.id,
            memorySpaceId: stale.data.memorySpaceId,
            memoryVersion: 3,
            scopeKey: memoryScopeKey(stale),
            searchKey: stale.data.searchKey,
          },
        ];
      },
      delete: async () => ({ status: "synchronized" as const }),
      synchronizeLifecycle: async () => ({ status: "synchronized" as const }),
      write: async () => ({ status: "written" as const }),
    }).provider;
    const service = makeMemoryService(repository, staticMemorySearchPlacementResolver(search));

    const results = await Effect.runPromise(
      service.search({
        allowedScopeKeys: [memoryScopeKey(valid)],
        allowedSensitivities: ["internal"],
        embedding: [0.1, 0.2, 0.3],
        environmentId: ids.environment,
        memorySpaceIds: [ids.space],
        now: new Date("2026-07-21T13:00:00.000Z"),
        organizationId: ids.organization,
        projectId: ids.project,
        searchKeys: [valid.data.searchKey],
        topK: 2,
      }),
    );

    expect(queryTopK).toBe(6);
    expect(results).toEqual([{ memory: valid, rank: 1, score: 0.9 }]);
  });

  it("fuses dense and lexical candidates before canonical revalidation", async () => {
    const denseOnly = memoryFixture({ id: ids.memory });
    const shared = memoryFixture({ id: ids.memory2 });
    const lexicalOnly = memoryFixture({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAC" as never });
    const memories = new Map(
      [denseOnly, shared, lexicalOnly].map((memory) => [memory.data.id, memory]),
    );
    const row = (memory: CanonicalMemoryRecord, dist: number) => ({
      contentHash: memory.data.contentHash,
      dist,
      id: memory.data.id,
      memorySpaceId: memory.data.memorySpaceId,
      memoryVersion: memory.data.version,
      scopeKey: memoryScopeKey(memory),
      searchKey: memory.data.searchKey,
    });
    const repository = {
      getIndexState: () => Effect.succeed(undefined),
      getMemory: (_scope, memoryId) => Effect.succeed(memories.get(memoryId)),
      updateIndexState: () => Effect.die("not used"),
    } as MemoryRepository;
    const search = fakeMemorySearchProvider({
      delete: async () => ({ status: "synchronized" as const }),
      readiness: async () => ({
        denseReady: true,
        lexicalReady: true,
        reference: "test",
        ready: true,
        schemaReady: true,
      }),
      query: async () => [row(denseOnly, 0.1), row(shared, 0.2)],
      queryExact: async () => [],
      queryLexical: async () => [row(shared, 0.1), row(lexicalOnly, 0.2)],
      synchronizeLifecycle: async () => ({ status: "synchronized" as const }),
      write: async () => ({ status: "written" as const }),
    }).provider;

    const result = await Effect.runPromise(
      makeMemoryService(repository, staticMemorySearchPlacementResolver(search)).searchEnhanced({
        allowedScopeKeys: [memoryScopeKey(shared)],
        allowedSensitivities: ["internal"],
        embedding: [0.1, 0.2, 0.3],
        environmentId: ids.environment,
        memorySpaceIds: [ids.space],
        now: new Date("2026-07-21T13:00:00.000Z"),
        organizationId: ids.organization,
        projectId: ids.project,
        query: "deployment marker",
        searchKeys: [shared.data.searchKey],
        strategy: "hybrid-rrf-v1",
        topK: 3,
      }),
    );

    expect(result.strategy).toBe("hybrid-rrf-v1");
    expect(result.results[0]).toMatchObject({
      memory: shared,
      sourceRanks: { dense: 2, lexical: 1 },
    });
    expect(result.counts).toEqual({
      dense: 2,
      denseOpenSearch: 0,
      entity: 0,
      exact: 0,
      lexical: 2,
    });
  });

  it("bounds and parallelizes canonical reads for dense and hybrid candidates", async () => {
    const candidateId = (index: number) =>
      `01ARZ3NDEKTSV4RRFFQ6${index.toString(32).toUpperCase().padStart(6, "0")}` as never;
    const memories = Array.from({ length: 48 }, (_, index) =>
      memoryFixture({ id: candidateId(index) }),
    );
    const byId = new Map(memories.map((memory) => [memory.data.id, memory]));
    const row = (memory: CanonicalMemoryRecord, dist: number) => ({
      contentHash: memory.data.contentHash,
      dist,
      id: memory.data.id,
      memorySpaceId: memory.data.memorySpaceId,
      memoryVersion: memory.data.version,
      scopeKey: memoryScopeKey(memory),
      searchKey: memory.data.searchKey,
    });
    const metrics = { active: 0, maximum: 0, reads: 0 };
    const repository = {
      getIndexState: () => Effect.succeed(undefined),
      getMemory: (_scope, memoryId) =>
        Effect.promise(async () => {
          metrics.active += 1;
          metrics.maximum = Math.max(metrics.maximum, metrics.active);
          metrics.reads += 1;
          try {
            await Bun.sleep(5);
            return byId.get(memoryId);
          } finally {
            metrics.active -= 1;
          }
        }),
      updateIndexState: () => Effect.die("not used"),
    } as MemoryRepository;
    const search = fakeMemorySearchProvider({
      delete: async () => ({ status: "synchronized" as const }),
      readiness: async () => ({
        denseReady: true,
        lexicalReady: true,
        reference: "test",
        ready: true,
        schemaReady: true,
      }),
      query: async () => memories.slice(0, 24).map((memory, index) => row(memory, index / 100)),
      queryExact: async () => [],
      queryLexical: async () => memories.slice(24).map((memory, index) => row(memory, index / 100)),
      synchronizeLifecycle: async () => ({ status: "synchronized" as const }),
      write: async () => ({ status: "written" as const }),
    }).provider;
    const service = makeMemoryService(repository, staticMemorySearchPlacementResolver(search));
    const input = {
      allowedScopeKeys: [memoryScopeKey(memories[0]!)],
      allowedSensitivities: ["internal" as const],
      embedding: [0.1, 0.2, 0.3],
      environmentId: ids.environment,
      memorySpaceIds: [ids.space],
      now: new Date("2026-07-21T13:00:00.000Z"),
      organizationId: ids.organization,
      projectId: ids.project,
      query: "deployment marker",
      searchKeys: [memories[0]!.data.searchKey],
      topK: 4,
    };

    for (const strategy of ["dense-v1", "hybrid-rrf-v1"] as const) {
      metrics.active = 0;
      metrics.maximum = 0;
      metrics.reads = 0;
      const result = await Effect.runPromise(service.searchEnhanced({ ...input, strategy }));
      expect(result.results).toHaveLength(12);
      expect(metrics.reads).toBe(12);
      expect(metrics.maximum).toBeGreaterThan(1);
      expect(metrics.maximum).toBeLessThanOrEqual(8);
    }
  });
});
