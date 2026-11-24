import { describe, expect, it } from "bun:test";
import type {
  DynamoDatabaseService,
  PlatformRecord,
  QueryRecordsResult,
  TransactionOperation,
  Ulid,
} from "@deployments-ai/db";
import { withCanonicalRecordKeys } from "@deployments-ai/db";
import { ids, memoryFixture, optionalExpressionString } from "./test-fixtures.ts";
import { makeMemoryPlatform } from "./platform.ts";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";
const fixedNow = new Date("2026-07-21T18:00:00.000Z");

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
    putRecord: async (record) =>
      put(record.itemType === "semantic-event" ? "events" : tableName(record), record),
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
    record.itemType === "memory-review-item"
  ) {
    return "execution";
  }
  return "control";
}

describe("memory platform", () => {
  it("names the operator access grant on the events of an administrator's writes", async () => {
    const { database, tables } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const grantId = "01ARZ3NDEKTSV4RRFFQ69G5FAG" as Ulid;
    const principalId = "01ARZ3NDEKTSV4RRFFQ69G5FAH" as Ulid;
    await platform.createMemorySpace(
      {
        environmentId: ids.environment,
        operatorAccessGrantId: grantId,
        organizationId: ids.organization,
        principalId,
        projectId: ids.project,
      },
      { name: "Support" },
    );

    const actors = [...(tables.get("events")?.values() ?? [])].flatMap((record) =>
      record.itemType === "semantic-event" ? [record.data.actor] : [],
    );
    expect(actors.length).toBeGreaterThan(0);
    expect(actors).toEqual(
      actors.map(() => ({ id: principalId, operatorAccessGrantId: grantId, type: "principal" })),
    );
  });

  it("keeps edited sensitive memory pending with a replacement review", async () => {
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
    const space = await platform.createMemorySpace(scope, { name: "Reviews" });
    const imported = await platform.importMemories(scope, {
      items: [{ content: "Original durable fact.", scope: "organization" }],
      memorySpaceId: space.data.id,
    });
    const original = imported.imported[0]!;
    const originalBody = original.data.body ?? "";
    const { body: _originalBody, ...referencedData } = original.data;
    put(
      "control",
      withCanonicalRecordKeys({
        data: {
          ...referencedData,
          bodyRef: {
            bucket: "platform-artifacts",
            byteSize: new TextEncoder().encode(originalBody).byteLength,
            contentType: "text/plain; charset=utf-8",
            key: "memory/original-review-body.txt",
            sha256: original.data.contentHash,
          },
        },
        itemType: "memory" as const,
      }) as PlatformRecord,
    );
    const firstReview = (await platform.listReviewItems(scope, { status: "open" }))[0]!;
    const resolved = await platform.resolveReview(scope, {
      content: "Contact owner@example.com for the durable process.",
      decision: "edit",
      idempotencyKey: "review-edit",
      memoryId: imported.imported[0]!.data.id,
      reviewId: firstReview.data.id,
    });
    expect(resolved.memory.data.reviewStatus).toBe("pending");
    expect(resolved.memory.data.body).toContain("[redacted email]");
    expect(resolved.memory.data.bodyRef).toBeUndefined();
    expect(resolved.memory.data.sensitivity).toBe("restricted");
    expect(resolved.review.data.proposedContent).toBeUndefined();
    const openReviews = await platform.listReviewItems(scope, { status: "open" });
    expect(openReviews).toHaveLength(1);
    expect(openReviews[0]?.data.id).not.toBe(firstReview.data.id);
    await platform.archiveMemory(scope, resolved.memory.data.id);
    const replayed = await platform.resolveReview(scope, {
      content: "Contact owner@example.com for the durable process.",
      decision: "edit",
      idempotencyKey: "review-edit",
      memoryId: resolved.memory.data.id,
      reviewId: firstReview.data.id,
    });
    expect(replayed.memory.data.status).toBe("archived");
    expect(
      platform.resolveReview(scope, {
        content: "A genuinely different replacement.",
        decision: "edit",
        memoryId: resolved.memory.data.id,
        reviewId: firstReview.data.id,
      }),
    ).rejects.toMatchObject({ code: "review_decision_conflict", statusCode: 409 });
    expect(
      platform.resolveReview(scope, {
        decision: "approve",
        memoryId: resolved.memory.data.id,
        reviewId: firstReview.data.id,
      }),
    ).rejects.toMatchObject({ code: "review_decision_conflict", statusCode: 409 });
    expect(
      platform.resolveReview(scope, {
        decision: "approve",
        idempotencyKey: "review-edit",
        memoryId: resolved.memory.data.id,
        reviewId: firstReview.data.id,
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("does not let a delayed lifecycle retry undo a later mutation", async () => {
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
    const space = await platform.createMemorySpace(scope, { name: "Lifecycle retries" });
    const imported = await platform.importMemories(scope, {
      items: [{ content: "Durable lifecycle retry fact.", scope: "organization" }],
      memorySpaceId: space.data.id,
    });
    const memoryId = imported.imported[0]!.data.id;

    await platform.archiveMemory(scope, memoryId, { idempotencyKey: "archive-request" });
    const restored = await platform.restoreMemory(scope, memoryId, {
      idempotencyKey: "restore-request",
    });
    const replayed = await platform.archiveMemory(scope, memoryId, {
      idempotencyKey: "archive-request",
    });

    expect(restored.data.status).toBe("active");
    expect(replayed.data.status).toBe("active");
    expect(replayed.data.version).toBe(restored.data.version);
    expect((await platform.requiredMemory(scope, memoryId)).data.status).toBe("active");
  });

  it("does not fail a committed delete replay when review cleanup is unavailable", async () => {
    const state = memoryDatabase();
    let failReviewCleanup = false;
    const database: DynamoDatabaseService = {
      ...state.database,
      queryRecords: (table, input) =>
        failReviewCleanup &&
        table === "execution" &&
        String(
          (input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[":prefix"],
        ).startsWith("MEMORY-REVIEW-ITEM#")
          ? Promise.reject(new Error("review cleanup unavailable"))
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
    };
    const space = await platform.createMemorySpace(scope, { name: "Delete replay cleanup" });
    const imported = await platform.importMemories(scope, {
      items: [{ content: "Delete replay durable fact.", scope: "organization" }],
      memorySpaceId: space.data.id,
    });
    const memoryId = imported.imported[0]!.data.id;
    await platform.archiveMemory(scope, memoryId);
    await platform.deleteMemory(scope, memoryId, { idempotencyKey: "delete-replay" });
    expect(
      state.queries.some(
        ({ input }) => input.ConsistentRead === true && input.KeyConditionExpression !== undefined,
      ),
    ).toBe(true);
    failReviewCleanup = true;

    expect(
      platform.deleteMemory(scope, memoryId, { idempotencyKey: "delete-replay" }),
    ).resolves.toMatchObject({ data: { id: memoryId, status: "deleted" } });
  });

  it("preserves archived lifecycle state when a review edit is resolved", async () => {
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
    const space = await platform.createMemorySpace(scope, { name: "Archived review" });
    const imported = await platform.importMemories(scope, {
      items: [{ content: "Original archived fact.", scope: "organization" }],
      memorySpaceId: space.data.id,
    });
    const memoryId = imported.imported[0]!.data.id;
    const review = (await platform.listReviewItems(scope, { status: "open" }))[0]!;
    await platform.archiveMemory(scope, memoryId);

    const resolved = await platform.resolveReview(scope, {
      content: "Edited archived fact.",
      decision: "edit",
      memoryId,
      reviewId: review.data.id,
    });

    expect(resolved.memory.data.status).toBe("archived");
    expect(resolved.memory.data.body).toBe("Edited archived fact.");
  });

  it("records archive review decisions without relabeling them as rejects", async () => {
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
    const space = await platform.createMemorySpace(scope, { name: "Archive review" });
    const imported = await platform.importMemories(scope, {
      items: [{ content: "Archive this reviewed fact.", scope: "organization" }],
      memorySpaceId: space.data.id,
    });
    const review = (await platform.listReviewItems(scope, { status: "open" }))[0]!;

    const resolved = await platform.resolveReview(scope, {
      decision: "archive",
      memoryId: imported.imported[0]!.data.id,
      reviewId: review.data.id,
    });

    expect(resolved.memory.data.status).toBe("archived");
    expect(resolved.memory.data.reviewStatus).toBe("pending");
    expect(resolved.review.data.decision).toBe("archive");
    const replacement = (await platform.listReviewItems(scope, { status: "open" }))[0]!;
    const restored = await platform.restoreMemory(scope, resolved.memory.data.id);
    expect(restored.data.reviewStatus).toBe("pending");
    const approved = await platform.resolveReview(scope, {
      decision: "approve",
      memoryId: restored.data.id,
      reviewId: replacement.data.id,
    });
    expect(approved.memory.data).toMatchObject({ reviewStatus: "approved", status: "active" });
  });

  it("rejects archived-space search before embedding leaves the runtime", async () => {
    const { database } = memoryDatabase();
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
    };
    const space = await platform.createMemorySpace(scope, { name: "Archived" });
    await platform.archiveMemorySpace(scope, space.data.id);

    expect(
      platform.search(scope, { memorySpaceIds: [space.data.id], query: "durable fact" }),
    ).rejects.toMatchObject({ code: "memory_space_archived", statusCode: 409 });
    expect(embeddingCalls).toBe(0);
  });

  it("suppresses indexed memories when their space is archived", async () => {
    const { database, put } = memoryDatabase();
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
    const space = await platform.createMemorySpace(scope, { name: "Archived index" });
    const memory = memoryFixture({ memorySpaceId: space.data.id });
    put("control", memory);
    const initialJob = await platform.enqueueIndexJob({
      memory,
      scope,
      synchronizationGeneration: 41,
    });
    await platform.processIndexJob(scope, {
      idempotencyKey: initialJob.data.idempotencyKey,
      memoryId: memory.data.id,
    });
    expect(search.rows.has(memory.data.id)).toBe(true);

    await platform.archiveMemorySpace(scope, space.data.id);
    await platform.reconcile(scope);
    const generation = fixedNow.getTime() * 1_000 + 999;
    await platform.processIndexJob(scope, {
      idempotencyKey: `${memory.data.id}:${memory.data.version}:${generation}:update`,
      memoryId: memory.data.id,
    });

    expect(search.rows.get(memory.data.id)).toMatchObject({
      content: "",
      status: "deleted",
    });
  });

  it("retries archived-space synchronization through reconciliation", async () => {
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
    const space = await platform.createMemorySpace(scope, { name: "Retry archive" });
    const memory = memoryFixture({ memorySpaceId: space.data.id });
    put("control", memory);
    const archived = await platform.archiveMemorySpace(scope, space.data.id);
    expect(
      [...(tables.get("execution")?.values() ?? [])].filter(
        (value) => value.itemType === "memory-index-job",
      ),
    ).toHaveLength(0);
    await platform.reconcile(scope);
    const execution = tables.get("execution")!;
    for (const [recordKey, value] of execution) {
      if (value.itemType === "memory-index-job") execution.delete(recordKey);
    }

    const retried = await platform.archiveMemorySpace(scope, space.data.id);
    await platform.reconcile(scope);

    expect(retried.data.version).toBe(archived.data.version);
    expect(
      [...execution.values()].filter((value) => value.itemType === "memory-index-job"),
    ).toHaveLength(1);
  });

  it("requeues failed index jobs through the public enqueue path", async () => {
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
    const memory = memoryFixture();
    put("control", memory);
    const queued = await platform.enqueueIndexJob({
      memory,
      scope,
      synchronizationGeneration: 73,
    });
    const running = await platform.claimIndexJob(
      scope,
      memory.data.id,
      queued.data.idempotencyKey,
      "worker-1",
    );
    const failed = await platform.failIndexJob(running, new Error("provider unavailable"));

    const requeued = await platform.enqueueIndexJob({
      memory,
      scope,
      synchronizationGeneration: 73,
    });

    expect(requeued.data.status).toBe("queued");
    expect(requeued.data.version).toBe(failed.data.version + 1);
    expect(requeued.data.error).toBeUndefined();
  });
});
