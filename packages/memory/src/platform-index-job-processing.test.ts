import { describe, expect, it } from "bun:test";
import type { PlatformRecord } from "@deployments-ai/db";
import { withCanonicalRecordKeys } from "@deployments-ai/db";
import { memoryContentHash } from "./governance.ts";
import type { MemorySearchTarget } from "./provider.ts";
import { ids, memoryFixture } from "./test-fixtures.ts";
import { makeMemoryPlatform } from "./platform.ts";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";
import { fixedNow, memoryDatabase } from "./platform-indexing-test-fixtures.ts";

describe("memory platform", () => {
  it("atomically re-admits a failed target job once its retry backoff elapses", async () => {
    const { database, put } = memoryDatabase();
    const target = {
      componentIds: [ids.space],
      embeddingProfileId: ids.agent,
      location: { region: "aws-us-east-2" },
      providerId: "aws-native" as const,
      schemaGeneration: 1,
      targetId: ids.toolCall,
    };
    let currentTime = fixedNow;
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => currentTime,
      searchRoutingResolver: async () => ({
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
    const memory = memoryFixture();
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
      workspaceId: ids.workspace,
    };
    put("control", memory);
    const queued = await platform.enqueueIndexJob({
      memory,
      scope,
      synchronizationGeneration: 7,
    });
    const running = await platform.claimIndexJob(
      scope,
      memory.data.id,
      queued.data.idempotencyKey,
      "worker-1",
      target.targetId,
    );
    const failed = await platform.failIndexJob(running, new Error("provider unavailable"));
    expect(failed.data).toMatchObject({
      nextDueAt: "2026-07-21T18:00:05.000Z",
      retryAt: "2026-07-21T18:00:05.000Z",
    });
    expect(
      platform.claimIndexJob(
        scope,
        memory.data.id,
        queued.data.idempotencyKey,
        "worker-early",
        target.targetId,
      ),
    ).resolves.toEqual(failed);

    currentTime = new Date("2026-07-21T18:00:05.000Z");
    expect(
      platform.claimIndexJob(
        scope,
        memory.data.id,
        queued.data.idempotencyKey,
        "worker-2",
        target.targetId,
      ),
    ).resolves.toMatchObject({ data: { attempt: 2, status: "running" } });
  });

  it("terminalizes work for a retired search target before embedding or provider access", async () => {
    const { database, put } = memoryDatabase();
    const retiredTarget: MemorySearchTarget = {
      componentIds: [ids.space],
      embeddingProfileId: ids.agent,
      location: { region: "aws-us-east-2" },
      providerId: "aws-native" as const,
      schemaGeneration: 1,
      targetId: ids.toolCall,
    };
    const activeTarget: MemorySearchTarget = {
      ...retiredTarget,
      location: { region: "us-east-2" },
      targetId: ids.run,
    };
    let routingTarget: MemorySearchTarget = retiredTarget;
    let embeddingCalls = 0;
    let providerResolutions = 0;
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => {
        embeddingCalls += 1;
        return { embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" };
      },
      now: () => fixedNow,
      searchPlacementResolver: async () => {
        providerResolutions += 1;
        throw new Error("Retired providers must not be resolved.");
      },
      searchRoutingResolver: async () => ({
        fenceEpoch: 7,
        fenceVersion: 3,
        placementGeneration: 5,
        placementPhase: "active",
        placementVersion: 4,
        read: { providerId: routingTarget.providerId, target: routingTarget },
        writes: [{ providerId: routingTarget.providerId, target: routingTarget }],
      }),
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const memory = memoryFixture();
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
      workspaceId: ids.workspace,
    };
    put("control", memory);
    const queued = await platform.enqueueIndexJob({
      memory,
      scope,
      synchronizationGeneration: 7,
    });

    routingTarget = activeTarget;
    const completed = await platform.processIndexJob(scope, {
      idempotencyKey: queued.data.idempotencyKey,
      memoryId: memory.data.id,
      targetId: retiredTarget.targetId,
    });

    expect(completed.data).toMatchObject({
      skipReason: "retired-search-target",
      status: "succeeded",
    });
    expect(completed.data).not.toHaveProperty("nextDueAt");
    expect(embeddingCalls).toBe(0);
    expect(providerResolutions).toBe(0);
  });

  it("loads and verifies referenced memory bodies before indexing", async () => {
    const { database, put, tables } = memoryDatabase();
    const search = fakeMemorySearchProvider();
    const content = "Referenced durable deployment guidance.";
    const bytes = new TextEncoder().encode(content);
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      loadBlob: async () => bytes,
      now: () => fixedNow,
      searchProvider: search.provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
      workspaceId: ids.workspace,
    };
    const space = await platform.createMemorySpace(scope, { name: "Referenced indexing" });
    const contentHash = memoryContentHash(content);
    const memory = memoryFixture({
      body: undefined,
      bodyRef: {
        bucket: "platform-artifacts",
        byteSize: bytes.byteLength,
        contentType: "text/plain; charset=utf-8",
        key: "memory/body.txt",
        sha256: contentHash,
        versionId: "version-1",
      },
      contentHash,
      memorySpaceId: space.data.id,
    });
    put("control", memory);
    const job = await platform.enqueueIndexJob({
      memory,
      scope,
      synchronizationGeneration: 42,
    });

    await platform.processIndexJob(scope, {
      idempotencyKey: job.data.idempotencyKey,
      memoryId: memory.data.id,
    });

    expect(search.rows.get(memory.data.id)).toMatchObject({ content });
    const persisted = [...(tables.get("execution")?.values() ?? [])].find(
      (record) => record.itemType === "memory-index-job",
    );
    expect(persisted).toMatchObject({
      data: { acknowledgement: expect.any(String), status: "succeeded" },
    });
    expect(persisted?.data).not.toHaveProperty("nextDueAt");
  });

  it("rejects a mismatched queue target before claiming the index job", async () => {
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
    const job = await platform.enqueueIndexJob({
      memory,
      scope,
      synchronizationGeneration: 42,
    });

    expect(
      platform.processIndexJob(scope, {
        idempotencyKey: job.data.idempotencyKey,
        memoryId: memory.data.id,
        targetId: ids.run,
      }),
    ).rejects.toMatchObject({ code: "index_job_target_mismatch" });

    const persisted = [...(tables.get("execution")?.values() ?? [])].find(
      (record) => record.itemType === "memory-index-job",
    );
    expect(persisted).toMatchObject({
      data: {
        attempt: 0,
        nextDueAt: "2026-07-21T18:05:00.000Z",
        status: "queued",
      },
    });
    expect(persisted?.gsi1sk).toContain("2026-07-21T18%3A05%3A00.000Z");
  });

  it("consumes superseded index jobs without retrying them", async () => {
    const { database, put } = memoryDatabase();
    let embeddingCalls = 0;
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => {
        embeddingCalls += 1;
        return { embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" };
      },
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
      workspaceId: ids.workspace,
    };
    const previous = memoryFixture();
    put("control", previous);
    const job = await platform.enqueueIndexJob({
      memory: previous,
      scope,
      synchronizationGeneration: 43,
    });
    put(
      "control",
      memoryFixture({
        version: previous.data.version + 1,
      }),
    );

    const consumed = await platform.processIndexJob(scope, {
      idempotencyKey: job.data.idempotencyKey,
      memoryId: previous.data.id,
    });

    expect(consumed.data.status).toBe("succeeded");
    expect(consumed.data.skipReason).toBe("stale-memory-version");
    expect(embeddingCalls).toBe(0);

    const current = memoryFixture({ id: ids.memory2 });
    put("control", current);
    const olderGeneration = await platform.enqueueIndexJob({
      memory: current,
      scope,
      synchronizationGeneration: 44,
    });
    put(
      "control",
      withCanonicalRecordKeys({
        data: {
          attemptId: "newer-attempt",
          contentHash: current.data.contentHash,
          createdAt: fixedNow.toISOString(),
          environmentId: scope.environmentId,
          indexedAt: fixedNow.toISOString(),
          memoryId: current.data.id,
          namespace: "deployments-ai-test-memory",
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          provider: "aws-native" as const,
          status: "ready" as const,
          synchronizationGeneration: 45,
          synchronizedVersion: current.data.version,
          targetId: olderGeneration.data.targetId,
          updatedAt: fixedNow.toISOString(),
          version: 0,
        },
        itemType: "memory-index-state" as const,
      }) as PlatformRecord,
    );
    const generationConsumed = await platform.processIndexJob(scope, {
      idempotencyKey: olderGeneration.data.idempotencyKey,
      memoryId: current.data.id,
    });
    expect(generationConsumed.data.skipReason).toBe("superseded-index-state");
    expect(embeddingCalls).toBe(0);
  });

  it("fences policy and space eligibility changes against the selected provider", async () => {
    const { database, transactions } = memoryDatabase();
    const target = {
      componentIds: [ids.space],
      embeddingProfileId: ids.agent,
      location: { region: "aws-us-east-2" },
      providerId: "aws-native" as const,
      schemaGeneration: 1,
      targetId: ids.toolCall,
    };
    const searchPlacementResolver = async () => ({
      fenceEpoch: 7,
      fenceVersion: 3,
      placementGeneration: 5,
      placementPhase: "active" as const,
      placementVersion: 4,
      read: { providerId: target.providerId, target } as never,
      writes: [{ providerId: target.providerId, target } as never],
    });
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchPlacementResolver,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(scope, { name: "Eligibility watermark" });

    await platform.upsertPolicy(scope, { sensitivityMode: "strict" });
    expect(
      transactions.at(-1)?.filter((operation) => operation.kind === "condition-check"),
    ).toMatchObject([
      { expressionAttributeValues: { ":generation": 5, ":version": 4 } },
      { expressionAttributeValues: { ":epoch": 7, ":open": "open", ":version": 3 } },
      {
        expressionAttributeValues: {
          ":itemType": "memory-provider-mutation-gate",
          ":open": "open",
        },
      },
    ]);

    await platform.archiveMemorySpace(scope, space.data.id);
    expect(
      transactions.at(-1)?.filter((operation) => operation.kind === "condition-check"),
    ).toMatchObject([
      { expressionAttributeValues: { ":generation": 5, ":version": 4 } },
      { expressionAttributeValues: { ":epoch": 7, ":open": "open", ":version": 3 } },
      {
        expressionAttributeValues: {
          ":itemType": "memory-provider-mutation-gate",
          ":open": "open",
        },
      },
    ]);
  });
});
