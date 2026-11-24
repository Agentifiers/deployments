import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type {
  MemoryIndexStateRecord,
  MemoryRepository,
  UpdateMemoryIndexStateInput,
} from "./repository.ts";
import { makeMemoryService } from "./service.ts";
import { ids, memoryFixture } from "./test-fixtures.ts";
import { type CanonicalMemoryRecord, type MemorySensitivity } from "./memory-record.ts";
import { memoryContentHash } from "./governance.ts";
import { staticMemorySearchPlacementResolver } from "./provider.ts";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";

function trackIndexStates(states: string[]) {
  return (input: UpdateMemoryIndexStateInput) => {
    states.push(input.status);
    return Effect.succeed({ data: { attemptId: input.attemptId } } as MemoryIndexStateRecord);
  };
}

describe("memory service", () => {
  it("removes policy-disallowed sensitivity from the search provider", async () => {
    const restricted = memoryFixture({ sensitivity: "restricted" });
    const states: string[] = [];
    let deleted = false;
    let written = false;
    const repository = {
      getIndexState: () => Effect.succeed(undefined),
      getMemory: () => Effect.succeed(restricted),
      updateIndexState: trackIndexStates(states),
    } as MemoryRepository;
    const search = fakeMemorySearchProvider({
      delete: async () => {
        deleted = true;
        return { status: "synchronized" as const };
      },
      query: async () => [],
      synchronizeLifecycle: async () => ({ status: "synchronized" as const }),
      write: async () => {
        written = true;
        return { status: "written" as const };
      },
    }).provider;

    await Effect.runPromise(
      makeMemoryService(repository, staticMemorySearchPlacementResolver(search)).index({
        allowedSensitivities: ["internal", "public"],
        environmentId: ids.environment,
        expectedContentHash: restricted.data.contentHash,
        expectedMemoryVersion: restricted.data.version,
        memoryId: ids.memory,
        now: new Date("2026-07-21T13:00:00.000Z"),
        organizationId: ids.organization,
        projectId: ids.project,
        synchronizationGeneration: 7,
      }),
    );

    expect(deleted).toBe(true);
    expect(written).toBe(false);
    expect(states).toEqual(["pending", "suppressed"]);
  });

  it("indexes future-valid memories once and relies on query-time validity filters", async () => {
    const memory = memoryFixture({ validFrom: "2026-07-22T00:00:00.000Z" });
    const states: string[] = [];
    let lifecycleCalls = 0;
    let writeCalls = 0;
    const repository = {
      getIndexState: () => Effect.succeed(undefined),
      getMemory: () => Effect.succeed(memory),
      updateIndexState: trackIndexStates(states),
    } as MemoryRepository;
    const search = fakeMemorySearchProvider({
      delete: async () => ({ status: "synchronized" as const }),
      query: async () => [],
      synchronizeLifecycle: async () => {
        lifecycleCalls += 1;
        return { status: "synchronized" as const };
      },
      write: async () => {
        writeCalls += 1;
        return { status: "written" as const };
      },
    }).provider;

    await Effect.runPromise(
      makeMemoryService(repository, staticMemorySearchPlacementResolver(search)).index({
        allowedSensitivities: ["internal"],
        content: memory.data.body ?? "",
        embedding: [0.1, 0.2, 0.3],
        embeddingContentHash: memory.data.contentHash,
        embeddingModel: "openai/text-embedding-3-small",
        embeddingProvider: "bifrost",
        environmentId: ids.environment,
        expectedContentHash: memory.data.contentHash,
        expectedMemoryVersion: memory.data.version,
        memoryId: memory.data.id,
        now: new Date("2026-07-21T13:00:00.000Z"),
        organizationId: ids.organization,
        projectId: ids.project,
        synchronizationGeneration: 7,
      }),
    );

    expect(writeCalls).toBe(1);
    expect(lifecycleCalls).toBe(0);
    expect(states).toEqual(["pending", "ready"]);
  });

  it("removes deleted memory without requiring plaintext or an embedding", async () => {
    const deletedMemory = memoryFixture({
      body: undefined,
      deletedAt: "2026-07-21T13:00:00.000Z",
      status: "deleted",
      version: 4,
    });
    const states: string[] = [];
    let deleted = false;
    const repository = {
      getIndexState: () => Effect.succeed(undefined),
      getMemory: () => Effect.succeed(deletedMemory),
      updateIndexState: trackIndexStates(states),
    } as MemoryRepository;
    const search = fakeMemorySearchProvider({
      delete: async () => {
        deleted = true;
        return { status: "synchronized" as const };
      },
      query: async () => [],
      synchronizeLifecycle: async () => ({ status: "synchronized" as const }),
      write: async () => ({ status: "written" as const }),
    }).provider;

    await Effect.runPromise(
      makeMemoryService(repository, staticMemorySearchPlacementResolver(search)).index({
        allowedSensitivities: [],
        environmentId: ids.environment,
        expectedContentHash: deletedMemory.data.contentHash,
        expectedMemoryVersion: deletedMemory.data.version,
        memoryId: ids.memory,
        organizationId: ids.organization,
        projectId: ids.project,
        synchronizationGeneration: 7,
      }),
    );

    expect(deleted).toBe(true);
    expect(states).toEqual(["pending", "deleted"]);
  });

  it("keeps namespace-missing deletions and suppressions pending for reconciliation", async () => {
    const indexStates = async (
      memory: CanonicalMemoryRecord,
      allowedSensitivities: readonly MemorySensitivity[],
    ) => {
      const states: string[] = [];
      const repository = {
        getIndexState: () => Effect.succeed(undefined),
        getMemory: () => Effect.succeed(memory),
        updateIndexState: trackIndexStates(states),
      } as MemoryRepository;
      const search = fakeMemorySearchProvider({
        delete: async () => ({ status: "namespace-missing" as const }),
        query: async () => [],
        synchronizeLifecycle: async () => ({ status: "namespace-missing" as const }),
        write: async () => ({ status: "namespace-missing" as const }),
      }).provider;

      await Effect.runPromise(
        makeMemoryService(repository, staticMemorySearchPlacementResolver(search)).index({
          allowedSensitivities,
          environmentId: ids.environment,
          expectedContentHash: memory.data.contentHash,
          expectedMemoryVersion: memory.data.version,
          memoryId: ids.memory,
          organizationId: ids.organization,
          projectId: ids.project,
          synchronizationGeneration: 7,
        }),
      );
      return states;
    };

    const deleted = memoryFixture({
      body: undefined,
      deletedAt: "2026-07-21T13:00:00.000Z",
      status: "deleted",
    });
    const suppressed = memoryFixture({ sensitivity: "restricted" });

    expect(indexStates(deleted, [])).resolves.toEqual(["pending", "stale"]);
    expect(indexStates(suppressed, ["internal", "public"])).resolves.toEqual(["pending", "stale"]);
  });

  it("keeps conditional index conflicts stale for reconciliation", async () => {
    const memory = memoryFixture();
    const states: string[] = [];
    const repository = {
      getIndexState: () => Effect.succeed(undefined),
      getMemory: () => Effect.succeed(memory),
      updateIndexState: trackIndexStates(states),
    } as MemoryRepository;
    const search = fakeMemorySearchProvider({
      delete: async () => ({ status: "not-applied" as const }),
      query: async () => [],
      synchronizeLifecycle: async () => ({ status: "not-applied" as const }),
      write: async () => ({ rowsAffected: 0, status: "not-applied" as const }),
    }).provider;

    await Effect.runPromise(
      makeMemoryService(repository, staticMemorySearchPlacementResolver(search)).index({
        allowedSensitivities: ["internal"],
        content: memory.data.body ?? "",
        embedding: [0.1, 0.2, 0.3],
        embeddingContentHash: memory.data.contentHash,
        embeddingModel: "openai/text-embedding-3-small",
        embeddingProvider: "bifrost",
        environmentId: ids.environment,
        expectedContentHash: memory.data.contentHash,
        expectedMemoryVersion: memory.data.version,
        memoryId: ids.memory,
        now: new Date("2026-07-21T13:00:00.000Z"),
        organizationId: ids.organization,
        projectId: ids.project,
        synchronizationGeneration: 7,
      }),
    );

    expect(states).toEqual(["pending", "stale"]);
  });

  it("rejects stale plaintext before creating pending index state", async () => {
    const memory = memoryFixture();
    const states: string[] = [];
    const repository = {
      getIndexState: () => Effect.succeed(undefined),
      getMemory: () => Effect.succeed(memory),
      updateIndexState: trackIndexStates(states),
    } as MemoryRepository;
    const search = fakeMemorySearchProvider({
      delete: async () => ({ status: "synchronized" as const }),
      query: async () => [],
      synchronizeLifecycle: async () => ({ status: "synchronized" as const }),
      write: async () => ({ status: "written" as const }),
    }).provider;

    expect(
      Effect.runPromise(
        makeMemoryService(repository, staticMemorySearchPlacementResolver(search)).index({
          allowedSensitivities: ["internal"],
          content: "Stale ungoverned content",
          embedding: [0.1, 0.2, 0.3],
          embeddingContentHash: memory.data.contentHash,
          embeddingModel: "openai/text-embedding-3-small",
          embeddingProvider: "bifrost",
          environmentId: ids.environment,
          expectedContentHash: memory.data.contentHash,
          expectedMemoryVersion: memory.data.version,
          memoryId: ids.memory,
          organizationId: ids.organization,
          projectId: ids.project,
          synchronizationGeneration: 7,
        }),
      ),
    ).rejects.toThrow("must match canonical DynamoDB content");
    expect(states).toEqual([]);
  });

  it("rejects secret-like canonical content before any external mutation", async () => {
    const content = "password = super-secret-production-value";
    const memory = memoryFixture({ body: content, contentHash: memoryContentHash(content) });
    const states: string[] = [];
    let externalCalls = 0;
    const repository = {
      getIndexState: () => Effect.succeed(undefined),
      getMemory: () => Effect.succeed(memory),
      updateIndexState: trackIndexStates(states),
    } as MemoryRepository;
    const external = async () => {
      externalCalls += 1;
      return { status: "written" as const };
    };
    const search = fakeMemorySearchProvider({
      delete: external,
      query: async () => [],
      synchronizeLifecycle: external,
      write: external,
    }).provider;

    expect(
      Effect.runPromise(
        makeMemoryService(repository, staticMemorySearchPlacementResolver(search)).index({
          allowedSensitivities: ["internal"],
          content,
          embedding: [0.1, 0.2, 0.3],
          embeddingContentHash: memory.data.contentHash,
          embeddingModel: "openai/text-embedding-3-small",
          embeddingProvider: "bifrost",
          environmentId: ids.environment,
          expectedContentHash: memory.data.contentHash,
          expectedMemoryVersion: memory.data.version,
          memoryId: ids.memory,
          organizationId: ids.organization,
          projectId: ids.project,
          synchronizationGeneration: 7,
        }),
      ),
    ).rejects.toThrow("cannot be sent to a search provider");
    expect(states).toEqual([]);
    expect(externalCalls).toBe(0);
  });

  it("rejects canonical personal data before any external mutation", async () => {
    const content = "Email Ava at ava@example.com about the release.";
    const memory = memoryFixture({ body: content, contentHash: memoryContentHash(content) });
    const states: string[] = [];
    let externalCalls = 0;
    const repository = {
      getIndexState: () => Effect.succeed(undefined),
      getMemory: () => Effect.succeed(memory),
      updateIndexState: trackIndexStates(states),
    } as MemoryRepository;
    const external = async () => {
      externalCalls += 1;
      return { status: "written" as const };
    };
    const search = fakeMemorySearchProvider({
      delete: external,
      query: async () => [],
      synchronizeLifecycle: external,
      write: external,
    }).provider;

    expect(
      Effect.runPromise(
        makeMemoryService(repository, staticMemorySearchPlacementResolver(search)).index({
          allowedSensitivities: ["internal", "restricted"],
          content,
          embedding: [0.1, 0.2, 0.3],
          embeddingContentHash: memory.data.contentHash,
          embeddingModel: "openai/text-embedding-3-small",
          embeddingProvider: "bifrost",
          environmentId: ids.environment,
          expectedContentHash: memory.data.contentHash,
          expectedMemoryVersion: memory.data.version,
          memoryId: ids.memory,
          organizationId: ids.organization,
          projectId: ids.project,
          synchronizationGeneration: 7,
        }),
      ),
    ).rejects.toThrow("fails governance or changes during inspection");
    expect(states).toEqual([]);
    expect(externalCalls).toBe(0);
  });
});
