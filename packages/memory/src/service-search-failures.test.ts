import { DatabaseError } from "@deployments-ai/db";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { AwsNativeMemoryError } from "./aws-native-contracts.ts";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";
import { MemoryPlatformError } from "./platform-types.ts";
import { staticMemorySearchPlacementResolver } from "./provider.ts";
import type { MemoryRepository } from "./repository.ts";
import { MemoryIndexingError, makeMemoryService } from "./service.ts";
import { ids } from "./test-fixtures.ts";

const input = {
  allowedScopeKeys: ["workspace:test"],
  allowedSensitivities: ["internal" as const],
  embedding: [0.1, 0.2, 0.3],
  environmentId: ids.environment,
  memorySpaceIds: [ids.space],
  organizationId: ids.organization,
  projectId: ids.project,
  searchKeys: ["workspace:test"],
  topK: 5,
};

const row = {
  contentHash: "hash",
  dist: 0.1,
  id: ids.memory,
  memorySpaceId: ids.space,
  memoryVersion: 1,
  scopeKey: "workspace:test",
  searchKey: "workspace:test",
};

function searchFailure(failure: unknown, stage: "provider" | "repository" = "provider") {
  const repository = {
    getIndexState: () => Effect.succeed(undefined),
    getMemory: () =>
      stage === "repository" ? Effect.fail(failure as DatabaseError) : Effect.succeed(undefined),
    updateIndexState: () => Effect.die("not used"),
  } as MemoryRepository;
  const provider = fakeMemorySearchProvider({
    query: async () => {
      if (stage === "provider") throw failure;
      return [row];
    },
  }).provider;
  return Effect.runPromise(
    Effect.flip(
      makeMemoryService(repository, staticMemorySearchPlacementResolver(provider)).searchEnhanced(
        input,
      ),
    ),
  );
}

describe("memory search failures", () => {
  it("wraps unclassified provider failures in MemoryIndexingError", async () => {
    const providerFailure = new Error("provider exploded");

    const failure = await searchFailure(providerFailure);

    expect(failure).toBeInstanceOf(MemoryIndexingError);
    expect(failure).toMatchObject({
      cause: providerFailure,
      memoryId: ids.organization,
      message: "Memory search failed.",
    });
  });

  it("passes classified failures through without wrapping", async () => {
    const tagged = new MemoryIndexingError({
      cause: "unready",
      memoryId: ids.organization,
      message: "Memory search provider is not ready.",
    });
    const providerTimeout = new AwsNativeMemoryError({
      cause: new DOMException("The operation timed out.", "TimeoutError"),
      message: "AWS-native memory query-vector failed.",
      operation: "query-vector",
    });
    const platformFailure = new MemoryPlatformError(503, "memory_search_not_serving", "Down.");
    const deadline = new DOMException("The operation timed out.", "TimeoutError");
    const databaseFailure = new DatabaseError({
      cause: new Error("throttled"),
      message: "DynamoDB get failed for table control.",
      operation: "get",
      reason: "unknown",
      table: "control",
    });

    expect(await searchFailure(tagged)).toBe(tagged);
    expect(await searchFailure(providerTimeout)).toBe(providerTimeout);
    expect(await searchFailure(platformFailure)).toBe(platformFailure);
    expect(await searchFailure(deadline)).toBe(deadline);
    expect(await searchFailure(databaseFailure, "repository")).toBe(databaseFailure);
  });
});
