import type { PlatformRecord } from "@deployments-ai/db";
import { MessageRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { memoryContentHash } from "./governance.ts";
import {
  fixedNow,
  grantedFlushRun,
  indexedUlid,
  memoryDatabase,
} from "./memory-flush-test-fixtures.ts";
import { makeMemoryPlatform } from "./platform.ts";
import { ids } from "./test-fixtures.ts";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";

describe("memory platform", () => {
  it("loads only messages attributed to the flushed run", async () => {
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
    for (let index = 0; index < 205; index += 1) {
      const body = `Later-run message ${index}`;
      put(
        "execution",
        withCanonicalRecordKeys({
          data: {
            body,
            contentHash: memoryContentHash(body),
            createdAt: fixedNow.toISOString(),
            environmentId: ids.environment,
            id: indexedUlid(15_200 + index),
            organizationId: ids.organization,
            projectId: ids.project,
            role: "assistant" as const,
            runId: ids.memory2,
            sequence: index + 2,
            threadId: ids.thread,
          },
          itemType: "message" as const,
        }) as PlatformRecord,
      );
    }
    const userBody = "I love hiking in Sedona.";
    put(
      "execution",
      Schema.decodeUnknownSync(MessageRecord)(
        withCanonicalRecordKeys({
          data: {
            body: userBody,
            contentHash: memoryContentHash(userBody),
            createdAt: "2026-07-20T00:00:00.000Z",
            environmentId: ids.environment,
            id: indexedUlid(15_500),
            organizationId: ids.organization,
            projectId: ids.project,
            role: "user" as const,
            runId: ids.run,
            sequence: 1,
            threadId: ids.thread,
          },
          itemType: "message" as const,
        }),
      ),
    );
    const assistantBody = "noted babe";
    put(
      "execution",
      Schema.decodeUnknownSync(MessageRecord)(
        withCanonicalRecordKeys({
          data: {
            body: assistantBody,
            contentHash: memoryContentHash(assistantBody),
            createdAt: "2026-07-20T00:00:01.000Z",
            environmentId: ids.environment,
            id: indexedUlid(15_501),
            organizationId: ids.organization,
            projectId: ids.project,
            role: "assistant" as const,
            runId: ids.run,
            sequence: 2,
            threadId: ids.thread,
          },
          itemType: "message" as const,
        }),
      ),
    );

    const messages = await platform.messagesForThread(scope, ids.thread, 2, ids.run);
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.data.runId)).toEqual([ids.run, ids.run]);
    expect(messages.map((message) => message.data.role)).toEqual(["user", "assistant"]);
  });

  it("keeps flush model configuration pinned to the run release and tenant", async () => {
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
    const space = await platform.createMemorySpace(scope, { name: "Pinned model" });
    const run = await grantedFlushRun(platform, put, scope, space.data.id);
    const replacementId = indexedUlid(16_000);
    for (const [id, modelId] of [
      [run.data.agentReleaseId, "openrouter/example/pinned"],
      [replacementId, "openrouter/example/replacement"],
    ] as const) {
      put(
        "control",
        withCanonicalRecordKeys({
          itemType: "agent-release" as const,
          data: {
            ...scope,
            agentDefinitionId: ids.agent,
            contentHash: "test-release-hash",
            createdAt: fixedNow.toISOString(),
            createdByPrincipalId: indexedUlid(16_002),
            id,
            manifest: {
              apiVersion: "agents.deployments.ai/v1",
              kind: "Agent",
              metadata: { key: "example.checkpoint", name: "Checkpoint", version: "1.0.0" },
              spec: {
                capabilities: { tools: [] },
                instructions: "Preserve conversation continuity.",
                memory: { mode: "off" },
                model: { id: modelId },
                sandbox: { mode: "none" },
                skills: [],
                triggers: ["api"],
              },
            },
            releaseNumber: id === run.data.agentReleaseId ? 1 : 2,
            status: "active",
            updatedAt: fixedNow.toISOString(),
            version: 0,
          },
        }) as PlatformRecord,
      );
    }
    put(
      "control",
      withCanonicalRecordKeys({
        itemType: "agent-deployment" as const,
        data: {
          ...scope,
          agentDefinitionId: ids.agent,
          agentReleaseId: replacementId,
          createdAt: fixedNow.toISOString(),
          currentState: "ready" as const,
          desiredState: "running" as const,
          id: run.data.agentDeploymentId,
          updatedAt: fixedNow.toISOString(),
          version: 1,
        },
      }) as PlatformRecord,
    );

    const release = await platform.agentReleaseForRun(scope, run);
    expect(release.data.manifest.spec.model.id).toBe("openrouter/example/pinned");
    expect(
      platform.agentReleaseForRun({ ...scope, projectId: indexedUlid(16_001) }, run),
    ).rejects.toMatchObject({ code: "agent_release_not_found", statusCode: 404 });
  });

  it("attaches the run agent definition to agent-scoped flush candidates", async () => {
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
    const space = await platform.createMemorySpace(scope, { name: "Agent flush" });
    const run = await grantedFlushRun(platform, put, scope, space.data.id);
    const result = await platform.importFlushCandidates(scope, {
      candidates: [{ content: "Remember the durable agent preference.", scope: "agent" }],
      flushId: indexedUlid(15_001),
      memoryMode: "agent",
      memorySpaceId: space.data.id,
      run,
    });

    expect(result.imported[0]?.data.agentDefinitionId).toBe(ids.agent);
  });

  it("replays candidate imports with the same flush identity", async () => {
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
    const space = await platform.createMemorySpace(scope, { name: "Retryable flush" });
    const run = await grantedFlushRun(platform, put, scope, space.data.id);
    const input = {
      candidates: [
        { content: "Remember the durable retry behavior.", scope: "thread" as const },
        { content: "Keep the release checklist current.", scope: "workspace" as const },
        { content: "Do not widen this workspace flush.", scope: "organization" as const },
      ],
      flushId: indexedUlid(15_004),
      memoryMode: "workspace" as const,
      memorySpaceId: space.data.id,
      run,
    };

    const first = await platform.importFlushCandidates(scope, input);
    const retry = await platform.importFlushCandidates(scope, {
      ...input,
      candidates: [...input.candidates].reverse(),
    });

    expect(first.imported).toHaveLength(2);
    expect(first.rejected).toEqual([
      { index: 2, reason: "Candidate scope is broader than the flush memory mode." },
    ]);
    expect(retry.imported).toHaveLength(0);
    expect(retry.rejected[0]?.index).toBe(0);
    expect(retry.replayed.map((memory) => memory.data.id).sort()).toEqual(
      first.imported.map((memory) => memory.data.id).sort(),
    );
  });

  it("purges review-deleted content and metadata", async () => {
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
    const space = await platform.createMemorySpace(scope, { name: "Review deletion" });
    const imported = await platform.importMemories(scope, {
      items: [
        {
          content: "Delete this durable fact after review.",
          metadata: { privateContext: "remove" },
          scope: "organization",
        },
      ],
      memorySpaceId: space.data.id,
    });
    const review = (await platform.listReviewItems(scope, { status: "open" }))[0]!;
    put("execution", {
      ...review,
      data: { ...review.data, proposedContent: "Delete this durable fact after review." },
    });

    const deleted = await platform.resolveReview(scope, {
      decision: "delete",
      memoryId: imported.imported[0]!.data.id,
      reason: "Operator confirmed this memory is obsolete.",
      reviewId: review.data.id,
    });

    expect(deleted.memory.data.status).toBe("deleted");
    expect(deleted.memory.data.body).toBeUndefined();
    expect(deleted.memory.data.bodyRef).toBeUndefined();
    expect(deleted.memory.data.metadata).toBeUndefined();
    expect(deleted.review.data.proposedContent).toBeUndefined();
    expect(deleted.review.data.resolutionReason).toBe(
      "Operator confirmed this memory is obsolete.",
    );
  });

  it("rejects stale review edits after permanent deletion", async () => {
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
    const space = await platform.createMemorySpace(scope, { name: "Stale reviews" });
    const imported = await platform.importMemories(scope, {
      items: [{ content: "Delete before stale review.", scope: "organization" }],
      memorySpaceId: space.data.id,
    });
    const memoryId = imported.imported[0]!.data.id;
    const review = (await platform.listReviewItems(scope, { status: "open" }))[0]!;
    await platform.archiveMemory(scope, memoryId);
    await platform.deleteMemory(scope, memoryId);

    expect(
      platform.resolveReview(scope, {
        content: "Do not resurrect this memory.",
        decision: "edit",
        memoryId,
        reviewId: review.data.id,
      }),
    ).rejects.toMatchObject({ code: "review_memory_deleted", statusCode: 409 });
  });

  it("does not reclaim active index or flush leases", async () => {
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
    const space = await platform.createMemorySpace(scope, { name: "Lease tests" });
    const imported = await platform.importMemories(scope, {
      items: [{ agentDefinitionId: ids.agent, content: "Lease fact.", scope: "agent" }],
      memorySpaceId: space.data.id,
    });
    const job = await platform.enqueueIndexJob({
      memory: imported.imported[0]!,
      scope,
      synchronizationGeneration: 42,
    });
    await platform.claimIndexJob(scope, job.data.memoryId, job.data.idempotencyKey, "worker-1");
    expect(
      platform.claimIndexJob(scope, job.data.memoryId, job.data.idempotencyKey, "worker-2"),
    ).rejects.toMatchObject({ code: "index_job_lease_active", statusCode: 409 });

    const run = await grantedFlushRun(platform, put, scope, space.data.id);
    const flush = await platform.enqueueFlush(scope, run, { memorySpaceId: space.data.id });
    expect(flush.data.observability).toEqual({
      captureMode: "metadata-only",
      runSpanId: run.data.spanId,
      sessionId: run.data.threadId,
      traceId: run.data.traceId,
    });
    await platform.claimFlush(scope, ids.run, flush.data.idempotencyKey, "worker-1");
    expect(
      platform.claimFlush(scope, ids.run, flush.data.idempotencyKey, "worker-2"),
    ).rejects.toMatchObject({ code: "flush_lease_active", statusCode: 409 });
  });

  it("rejects nonexistent and archived explicit flush spaces before queueing", async () => {
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
    const run = {
      data: {
        environmentId: ids.environment,
        id: ids.run,
        organizationId: ids.organization,
        projectId: ids.project,
        status: "completed",
        threadId: ids.thread,
      },
    } as never;

    expect(
      platform.enqueueFlush(
        scope,
        {
          data: {
            environmentId: ids.environment,
            id: ids.memory2,
            organizationId: ids.organization,
            projectId: ids.project,
            status: "running",
            threadId: ids.thread,
          },
        } as never,
        { memorySpaceId: ids.space },
      ),
    ).rejects.toMatchObject({ code: "run_not_terminal", statusCode: 409 });

    expect(
      platform.enqueueFlush(scope, run, {
        memoryMode: "workspace",
        memorySpaceId: ids.space,
      }),
    ).rejects.toMatchObject({ code: "workspace_required", statusCode: 409 });

    expect(platform.enqueueFlush(scope, run, { memorySpaceId: ids.space })).rejects.toMatchObject({
      code: "memory_space_not_found",
      statusCode: 404,
    });
    const archived = await platform.createMemorySpace(scope, { name: "Archived flush" });
    const unauthorizedRun = await grantedFlushRun(
      platform,
      put,
      scope,
      archived.data.id,
      ids.memory2,
    );
    await platform.archiveMemorySpace(scope, archived.data.id);
    expect(
      platform.enqueueFlush(scope, run, { memorySpaceId: archived.data.id }),
    ).rejects.toMatchObject({ code: "memory_space_archived", statusCode: 409 });
    const active = await platform.createMemorySpace(scope, { name: "Unauthorized flush" });
    expect(
      platform.enqueueFlush(scope, unauthorizedRun, { memorySpaceId: active.data.id }),
    ).rejects.toMatchObject({ code: "memory_space_write_forbidden", statusCode: 403 });
  });

  it("selects and validates flush spaces against the requested memory mode", async () => {
    const { database, put } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const tenantScope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const workspaceScope = { ...tenantScope, workspaceId: ids.workspace };
    const organizationSpace = await platform.createMemorySpace(tenantScope, {
      name: "Organization flush",
    });
    const workspaceSpace = await platform.createMemorySpace(workspaceScope, {
      name: "Workspace flush",
    });
    const workspaceRun = await grantedFlushRun(
      platform,
      put,
      workspaceScope,
      organizationSpace.data.id,
    );
    await platform.grantMemorySpace(workspaceScope, {
      agentDefinitionId: ids.agent,
      memorySpaceId: workspaceSpace.data.id,
      permission: "read-write",
    });

    expect(
      platform.enqueueFlush(workspaceScope, workspaceRun, { memoryMode: "workspace" }),
    ).resolves.toMatchObject({ data: { memorySpaceId: workspaceSpace.data.id } });

    const secondRun = await grantedFlushRun(
      platform,
      put,
      workspaceScope,
      organizationSpace.data.id,
      indexedUlid(15_401),
    );
    expect(
      platform.enqueueFlush(workspaceScope, secondRun, {
        memoryMode: "workspace",
        memorySpaceId: organizationSpace.data.id,
      }),
    ).rejects.toMatchObject({ code: "memory_space_scope_mismatch", statusCode: 409 });

    const thirdRun = await grantedFlushRun(
      platform,
      put,
      workspaceScope,
      organizationSpace.data.id,
      indexedUlid(15_402),
    );
    expect(
      platform.enqueueFlush(workspaceScope, thirdRun, { memoryMode: "organization" }),
    ).resolves.toMatchObject({ data: { memorySpaceId: organizationSpace.data.id } });
  });

  it("strongly resolves a missing scope-compatible grant despite another indexed writable grant", async () => {
    const { database, put, queries } = memoryDatabase(
      (record) => record.itemType !== "memory-space-grant" || record.data.workspaceId === undefined,
    );
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const tenantScope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const workspaceScope = { ...tenantScope, workspaceId: ids.workspace };
    const organizationSpace = await platform.createMemorySpace(tenantScope, {
      name: "Indexed organization grant",
    });
    const workspaceSpace = await platform.createMemorySpace(workspaceScope, {
      name: "Delayed workspace grant",
    });
    const run = await grantedFlushRun(
      platform,
      put,
      workspaceScope,
      organizationSpace.data.id,
      indexedUlid(15_403),
    );
    await platform.grantMemorySpace(workspaceScope, {
      agentDefinitionId: ids.agent,
      memorySpaceId: workspaceSpace.data.id,
      permission: "read-write",
    });

    expect(
      platform.enqueueFlush(workspaceScope, run, { memoryMode: "workspace" }),
    ).resolves.toMatchObject({ data: { memorySpaceId: workspaceSpace.data.id } });
    expect(
      queries.some(({ input }) => input.ConsistentRead === true && input.IndexName === undefined),
    ).toBe(true);
  });
});
