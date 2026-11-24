import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { memoryIndexStateRecord } from "./repository.ts";
import { ids, memoryFixture } from "./test-fixtures.ts";
describe("memory repository records", () => {
  it("tracks canonical content and memory versions in the organization memory aggregate", async () => {
    const record = await Effect.runPromise(
      memoryIndexStateRecord({
        attemptId: "attempt-1",
        memory: memoryFixture(),
        namespace: "deployments-ai-test-memory-org",
        provider: "aws-native",
        status: "ready",
        synchronizationGeneration: 7,
        updatedAt: new Date("2026-07-21T13:00:00.000Z"),
      }),
    );

    expect(record).toMatchObject({
      data: {
        attemptId: "attempt-1",
        contentHash: memoryFixture().data.contentHash,
        environmentId: ids.environment,
        indexedAt: "2026-07-21T13:00:00.000Z",
        memoryId: ids.memory,
        organizationId: ids.organization,
        projectId: ids.project,
        provider: "aws-native",
        status: "ready",
        synchronizationGeneration: 7,
        synchronizedVersion: 3,
        version: 0,
      },
      itemType: "memory-index-state",
      pk: `ORG#${ids.organization}#MEMORY#${ids.memory}`,
      sk: `MEMORY-INDEX-STATE#${ids.memory}`,
    });
  });

  it("rejects out-of-order index state regression", async () => {
    const memory = memoryFixture();
    const previous = await Effect.runPromise(
      memoryIndexStateRecord({
        attemptId: "attempt-2",
        memory: memoryFixture({ version: 4 }),
        namespace: "deployments-ai-test-memory-org",
        provider: "aws-native",
        status: "ready",
        synchronizationGeneration: 7,
        updatedAt: new Date("2026-07-21T13:00:00.000Z"),
      }),
    );

    expect(
      Effect.runPromise(
        memoryIndexStateRecord(
          {
            attemptId: "attempt-3",
            memory,
            namespace: "deployments-ai-test-memory-org",
            provider: "aws-native",
            status: "ready",
            synchronizationGeneration: 8,
            updatedAt: new Date("2026-07-21T13:01:00.000Z"),
          },
          previous,
        ),
      ),
    ).rejects.toThrow("cannot regress its synchronization ordering");
  });

  it("rejects an out-of-order generation for the same canonical version", async () => {
    const previous = await Effect.runPromise(
      memoryIndexStateRecord({
        attemptId: "attempt-newer",
        memory: memoryFixture(),
        namespace: "deployments-ai-test-memory-org",
        provider: "aws-native",
        status: "ready",
        synchronizationGeneration: 9,
      }),
    );

    expect(
      Effect.runPromise(
        memoryIndexStateRecord(
          {
            attemptId: "attempt-older",
            memory: memoryFixture(),
            namespace: "deployments-ai-test-memory-org",
            provider: "aws-native",
            status: "pending",
            synchronizationGeneration: 8,
          },
          previous,
        ),
      ),
    ).rejects.toThrow("cannot regress its synchronization ordering");
  });

  it("requires finalization to own the current pending attempt", async () => {
    const pending = await Effect.runPromise(
      memoryIndexStateRecord({
        attemptId: "attempt-current",
        memory: memoryFixture(),
        namespace: "deployments-ai-test-memory-org",
        provider: "aws-native",
        status: "pending",
        synchronizationGeneration: 7,
      }),
    );

    expect(
      Effect.runPromise(
        memoryIndexStateRecord(
          {
            attemptId: "attempt-stale",
            expectedAttemptId: "attempt-stale",
            memory: memoryFixture(),
            namespace: "deployments-ai-test-memory-org",
            provider: "aws-native",
            status: "failed",
            synchronizationGeneration: 7,
          },
          pending,
        ),
      ),
    ).rejects.toThrow("no longer owned by this synchronization attempt");
  });
});
