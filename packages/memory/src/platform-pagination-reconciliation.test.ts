import { describe, expect, it } from "bun:test";
import type { DynamoDatabaseService, PlatformRecord, QueryRecordsResult } from "@deployments-ai/db";
import { withCanonicalRecordKeys } from "@deployments-ai/db";
import { ids, memoryFixture } from "./test-fixtures.ts";
import { makeMemoryPlatform } from "./platform.ts";
import { staticMemorySearchPlacementResolver } from "./provider.ts";
import { localPageCursorCodec, queryEnvironmentRecordPage } from "./platform-shared.ts";
import type { MemorySpace } from "./platform-types.ts";
import {
  fixedNow,
  indexedUlid,
  memoryDatabase,
} from "./platform-pagination-reconciliation-fixtures.ts";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";

describe("memory platform", () => {
  it("scopes idempotency keys to project and environment", async () => {
    const { database } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({
        embedding: [0.1, 0.2, 0.3],
        model: "test",
        provider: "test",
      }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const firstScope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const secondScope = {
      environmentId: ids.memory2,
      organizationId: ids.organization,
      projectId: ids.project,
    };

    const first = await platform.createMemorySpace(firstScope, {
      idempotencyKey: "shared-environment-key",
      name: "First environment",
    });
    const second = await platform.createMemorySpace(secondScope, {
      idempotencyKey: "shared-environment-key",
      name: "Second environment",
    });

    expect(second.data.id).not.toBe(first.data.id);
  });

  it("rejects idempotency keys that exceed the encoded DynamoDB key limit", async () => {
    const { database } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({
        embedding: [0.1, 0.2, 0.3],
        model: "test",
        provider: "test",
      }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };

    expect(
      platform.createMemorySpace(scope, {
        idempotencyKey: "/".repeat(400),
        name: "Oversized idempotency",
      }),
    ).rejects.toMatchObject({
      code: "invalid_idempotency_key",
      statusCode: 400,
    });
  });

  it("applies workspace policy during indexing and keeps reconciliation stable", async () => {
    const { database, tables } = memoryDatabase();
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
    const workspaceScope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
      workspaceId: ids.workspace,
    };
    const space = await platform.createMemorySpace(workspaceScope, {
      kind: "workspace",
      name: "Strict workspace",
    });
    const imported = await platform.importMemories(workspaceScope, {
      items: [
        {
          content: "Contact owner@example.com for the durable deployment process.",
          scope: "workspace",
          workspaceId: ids.workspace,
        },
      ],
      memorySpaceId: space.data.id,
    });
    const review = (await platform.listReviewItems(workspaceScope, { status: "open" }))[0]!;
    const approved = await platform.resolveReview(workspaceScope, {
      decision: "approve",
      memoryId: imported.imported[0]!.data.id,
      reviewId: review.data.id,
    });
    const policy = await platform.upsertPolicy(workspaceScope, {
      activeRecallEnabled: false,
      scope: "workspace",
      sensitivityMode: "strict",
    });
    expect(policy.data.sensitivityMode).toBe("strict");
    expect(platform.reconcile(workspaceScope)).resolves.toEqual({
      inspected: 1,
      queued: 0,
    });
    const pending = [...(tables.get("execution")?.values() ?? [])].find(
      (record) =>
        record.itemType === "memory-index-job" &&
        record.data.status === "queued" &&
        record.data.expectedMemoryVersion === approved.memory.data.version,
    );
    if (pending?.itemType !== "memory-index-job") throw new Error("Expected a pending index job.");
    await platform.processIndexJob(workspaceScope, {
      idempotencyKey: pending.data.idempotencyKey,
      memoryId: approved.memory.data.id,
    });

    expect(embeddingCalls).toBe(0);
    expect(platform.reconcile(workspaceScope)).resolves.toEqual({
      inspected: 1,
      queued: 0,
    });
  });

  it("periodically resynchronizes unchanged canonical memory to repair provider drift", async () => {
    const { database, put } = memoryDatabase();
    let currentTime = fixedNow;
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({
        embedding: [0.1, 0.2, 0.3],
        model: "test",
        provider: "test",
      }),
      now: () => currentTime,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
      workspaceId: ids.workspace,
    };
    const space = await platform.createMemorySpace(scope, {
      name: "Provider drift repair",
    });
    const memory = memoryFixture({ memorySpaceId: space.data.id });
    put("control", memory);
    const job = await platform.enqueueIndexJob({
      memory,
      scope,
      synchronizationGeneration: 51,
    });
    await platform.processIndexJob(scope, {
      idempotencyKey: job.data.idempotencyKey,
      memoryId: memory.data.id,
    });
    currentTime = new Date(fixedNow.getTime() + 25 * 60 * 60_000);

    expect(await platform.reconcile(scope)).toEqual({ inspected: 1, queued: 0 });
    expect(await platform.verifyIndexStates(scope, { limit: 50 })).toEqual({ queued: 1 });
  });

  it("paginates before filtering a requested memory space", async () => {
    const { database, put } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({
        embedding: [0.1, 0.2, 0.3],
        model: "test",
        provider: "test",
      }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    for (let index = 0; index < 220; index += 1) {
      put(
        "control",
        memoryFixture({
          id: indexedUlid(index),
          memorySpaceId: index < 217 ? ids.memory2 : ids.space,
          version: index,
        }),
      );
    }
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
      workspaceId: ids.workspace,
    };

    const page = await platform.listMemories(scope, {
      limit: 2,
      memorySpaceId: ids.space,
    });
    const exported = await platform.listMemories(scope, {
      all: true,
      memorySpaceId: ids.space,
    });
    expect(page).toHaveLength(2);
    expect(exported).toHaveLength(3);
    const firstPage = await platform.listMemoriesPage(scope, {
      limit: 2,
      memorySpaceId: ids.space,
    });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).toBeString();
    const secondPage = await platform.listMemoriesPage(scope, {
      cursor: firstPage.nextCursor!,
      limit: 2,
      memorySpaceId: ids.space,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeUndefined();
  });

  it("paginates tenant-filtered spaces, policies, and review items", async () => {
    const { database, put } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({
        embedding: [0.1, 0.2, 0.3],
        model: "test",
        provider: "test",
      }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const foreignOrganizationId = indexedUlid(4_000);
    const foreignProjectId = indexedUlid(4_001);
    for (let index = 0; index < 220; index += 1) {
      const target = index >= 217;
      const organizationId = target ? ids.organization : foreignOrganizationId;
      const projectId = target ? ids.project : foreignProjectId;
      put(
        "control",
        withCanonicalRecordKeys({
          data: {
            activeRecallEnabled: false,
            activeRecallRolloutPercent: 100,
            createdAt: fixedNow.toISOString(),
            environmentId: ids.environment,
            id: indexedUlid(5_000 + index),
            organizationId,
            projectId,
            scope: "environment" as const,
            sensitivityMode: "standard" as const,
            updatedAt: fixedNow.toISOString(),
            version: 0,
          },
          itemType: "memory-policy" as const,
        }) as PlatformRecord,
      );
      put(
        "control",
        withCanonicalRecordKeys({
          data: {
            createdAt: fixedNow.toISOString(),
            environmentId: ids.environment,
            id: indexedUlid(6_000 + index),
            kind: "organization" as const,
            name: `Space ${index}`,
            organizationId,
            projectId,
            status: "active" as const,
            updatedAt: fixedNow.toISOString(),
            version: 0,
          },
          itemType: "memory-space" as const,
        }) as PlatformRecord,
      );
      put(
        "execution",
        withCanonicalRecordKeys({
          data: {
            createdAt: fixedNow.toISOString(),
            environmentId: ids.environment,
            id: indexedUlid(7_000 + index),
            kind: "sampled-import",
            memoryId: indexedUlid(8_000 + index),
            organizationId,
            projectId,
            status: "open" as const,
            updatedAt: fixedNow.toISOString(),
            version: 0,
          },
          itemType: "memory-review-item" as const,
        }) as PlatformRecord,
      );
    }
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };

    expect(await platform.listMemorySpaces(scope, { limit: 2 })).toHaveLength(2);
    expect(await platform.listPolicies(scope)).toHaveLength(3);
    expect(await platform.listReviewItems(scope, { limit: 2, status: "open" })).toHaveLength(2);
    const spaces = await platform.listMemorySpacesPage(scope, { limit: 2 });
    expect(spaces.items).toHaveLength(2);
    expect(spaces.nextCursor).toBeString();
    expect(platform.listPoliciesPage(scope, { cursor: spaces.nextCursor! })).rejects.toMatchObject({
      code: "invalid_cursor",
      statusCode: 400,
    });
    const malformedCursor = Buffer.from(
      JSON.stringify({ itemType: "memory-space", key: {}, version: 1 }),
    ).toString("base64url");
    expect(platform.listMemorySpacesPage(scope, { cursor: malformedCursor })).rejects.toMatchObject(
      { code: "invalid_cursor", statusCode: 400 },
    );
    const reviews = await platform.listReviewItemsPage(scope, {
      limit: 2,
      status: "open",
    });
    expect(reviews.items).toHaveLength(2);
    expect(reviews.nextCursor).toBeString();
  });

  it("builds page cursors from the last authorized record", async () => {
    const authorized = withCanonicalRecordKeys({
      data: {
        createdAt: fixedNow.toISOString(),
        environmentId: ids.environment,
        id: indexedUlid(16_000),
        kind: "workspace" as const,
        name: "Authorized space",
        organizationId: ids.organization,
        projectId: ids.project,
        status: "active" as const,
        updatedAt: fixedNow.toISOString(),
        version: 0,
        workspaceId: ids.workspace,
      },
      itemType: "memory-space" as const,
    }) as MemorySpace;
    const unauthorized = withCanonicalRecordKeys({
      data: {
        ...authorized.data,
        id: indexedUlid(16_001),
        name: "Foreign space",
        workspaceId: indexedUlid(16_002),
      },
      itemType: "memory-space" as const,
    }) as MemorySpace;
    const nextAuthorized = withCanonicalRecordKeys({
      data: {
        ...authorized.data,
        id: indexedUlid(16_003),
        name: "Next authorized space",
      },
      itemType: "memory-space" as const,
    }) as MemorySpace;
    const queryInputs: Record<string, unknown>[] = [];
    const database: DynamoDatabaseService = {
      ...memoryDatabase().database,
      queryRecords: async (_table, input) => {
        queryInputs.push(input as Record<string, unknown>);
        return queryInputs.length === 1
          ? {
              items: [authorized, unauthorized],
              lastEvaluatedKey: {
                gsi2pk: unauthorized.gsi2pk,
                gsi2sk: unauthorized.gsi2sk,
                pk: unauthorized.pk,
                sk: unauthorized.sk,
              },
            }
          : { items: [nextAuthorized] };
      },
    };
    const pageInput = {
      cursorCodec: localPageCursorCodec,
      database,
      environmentId: ids.environment,
      filter: (record: MemorySpace) => record.data.workspaceId === ids.workspace,
      itemType: "memory-space" as const,
      limit: 1,
      table: "control" as const,
    };

    const first = await queryEnvironmentRecordPage(pageInput);
    expect(first.nextCursor).toBeString();
    const cursor = first.nextCursor!;
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      key: Record<string, unknown>;
    };
    expect(decoded.key).toEqual({
      gsi2pk: authorized.gsi2pk,
      gsi2sk: authorized.gsi2sk,
      pk: authorized.pk,
      sk: authorized.sk,
    });
    expect(JSON.stringify(decoded)).not.toContain(unauthorized.data.id);

    const second = await queryEnvironmentRecordPage({ ...pageInput, cursor });
    expect(queryInputs[1]?.ExclusiveStartKey).toEqual(decoded.key);
    expect(second.items.map((record) => record.data.id)).toEqual([nextAuthorized.data.id]);
  });

  it("strongly revalidates stale review page projections", async () => {
    const state = memoryDatabase();
    const stale = withCanonicalRecordKeys({
      data: {
        createdAt: fixedNow.toISOString(),
        environmentId: ids.environment,
        id: indexedUlid(16_050),
        kind: "sampled-import",
        memoryId: ids.memory,
        organizationId: ids.organization,
        projectId: ids.project,
        proposedContent: "Scrubbed review content.",
        status: "open" as const,
        updatedAt: fixedNow.toISOString(),
        version: 0,
      },
      itemType: "memory-review-item" as const,
    }) as Extract<PlatformRecord, { readonly itemType: "memory-review-item" }>;
    const { proposedContent: _proposedContent, ...data } = stale.data;
    state.put("execution", {
      ...stale,
      data: { ...data, status: "resolved", version: 1 },
    } as PlatformRecord);
    const database: DynamoDatabaseService = {
      ...state.database,
      queryRecords: (table, input) =>
        table === "execution" && input.IndexName === "gsi2"
          ? Promise.resolve({ items: [stale] } satisfies QueryRecordsResult)
          : state.database.queryRecords(table, input),
    };
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({
        embedding: [0.1, 0.2, 0.3],
        model: "test",
        provider: "test",
      }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };

    expect(platform.listReviewItemsPage(scope, { status: "open" })).resolves.toMatchObject({
      items: [],
    });
  });

  it("keeps recall persistence within DynamoDB transaction limits", async () => {
    const { database, put, transactionSizes } = memoryDatabase();
    const search = fakeMemorySearchProvider();
    const active = await staticMemorySearchPlacementResolver(search.provider)(ids.organization);
    const candidate = {
      ...active.read,
      target: { ...active.read.target, targetId: ids.memory2 },
    };
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({
        embedding: [0.1, 0.2, 0.3],
        embeddingProfileId: active.read.target.embeddingProfileId,
        model: "test",
        provider: "test",
      }),
      now: () => fixedNow,
      searchPlacementResolver: async () => ({
        ...active,
        placementPhase: "shadow",
        writes: [active.read, candidate],
      }),
      searchProvider: search.provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
      workspaceId: ids.workspace,
    };
    const space = await platform.createMemorySpace(scope, {
      kind: "workspace",
      name: "Large recall",
    });
    for (let index = 0; index < 100; index += 1) {
      const memory = memoryFixture({
        id: indexedUlid(9_000 + index),
        memorySpaceId: space.data.id,
        version: index,
      });
      put("control", memory);
      search.rows.set(memory.data.id, {
        contentHash: memory.data.contentHash,
        id: memory.data.id,
        memorySpaceId: memory.data.memorySpaceId,
        memoryVersion: memory.data.version,
        reviewStatus: "approved",
        scopeKey: `workspace:${ids.workspace}`,
        searchKey: memory.data.searchKey,
        sensitivity: "internal",
        status: "active",
      });
    }

    const recall = await platform.search(scope, {
      memorySpaceIds: [space.data.id],
      query: "deployment context",
      topK: 45,
    });

    expect(recall.results).toHaveLength(45);
    expect(recall.retrievals).toHaveLength(45);
    expect(Math.max(...transactionSizes)).toBeLessThanOrEqual(49);
    expect(
      platform.search(scope, {
        memorySpaceIds: [space.data.id],
        query: "deployment context",
        topK: 46,
      }),
    ).rejects.toMatchObject({ code: "invalid_top_k", statusCode: 400 });
  });

  it("sums model token usage for one run before flush extraction", async () => {
    const { database, put } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({
        embedding: [0.1, 0.2, 0.3],
        model: "test",
        provider: "test",
      }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    for (const [index, quantity] of [7_000, 9_500].entries()) {
      put(
        "usage",
        withCanonicalRecordKeys({
          data: {
            dimensions: { modelId: "openai/gpt-5.2", provider: "bifrost" },
            environmentId: ids.environment,
            id: indexedUlid(15_000 + index),
            idempotencyKey: `${ids.run}:model_tokens:bifrost:call-${index}`,
            metric: "model_tokens",
            occurredAt: fixedNow.toISOString(),
            organizationId: ids.organization,
            projectId: ids.project,
            quantity,
            runId: ids.run,
            source: "bifrost",
            unit: "tokens",
          },
          itemType: "meter-event" as const,
        }) as PlatformRecord,
      );
    }
    put(
      "usage",
      withCanonicalRecordKeys({
        data: {
          dimensions: { modelId: "openai/gpt-5.2", provider: "bifrost" },
          environmentId: ids.environment,
          id: indexedUlid(15_100),
          idempotencyKey: `${ids.memory2}:model_tokens:bifrost:other-run`,
          metric: "model_tokens",
          occurredAt: fixedNow.toISOString(),
          organizationId: ids.organization,
          projectId: ids.project,
          quantity: 100_000,
          runId: ids.memory2,
          source: "bifrost",
          unit: "tokens",
        },
        itemType: "meter-event" as const,
      }) as PlatformRecord,
    );

    expect(platform.modelTokenQuantityForRun(scope, ids.run)).resolves.toBe(16_500);
  });
});
