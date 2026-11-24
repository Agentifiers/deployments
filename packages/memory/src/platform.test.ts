import { describe, expect, it } from "bun:test";
import type {
  DynamoDatabaseService,
  PlatformRecord,
  QueryRecordsResult,
  TransactionOperation,
  Ulid,
} from "@deployments-ai/db";
import { memoryContentHash } from "./governance.ts";
import { ids, memoryFixture, optionalExpressionString } from "./test-fixtures.ts";
import { makeMemoryPlatform } from "./platform.ts";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";
const fixedNow = new Date("2026-07-21T18:00:00.000Z");
const ulidAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function indexedUlid(index: number) {
  let value = index;
  let suffix = "";
  for (let position = 0; position < 6; position += 1) {
    suffix = ulidAlphabet[value % ulidAlphabet.length] + suffix;
    value = Math.floor(value / ulidAlphabet.length);
  }
  return `01ARZ3NDEKTSV4RRFFQ6${suffix}` as Ulid;
}

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
      const startKey = input.ExclusiveStartKey as Record<string, unknown> | undefined;
      const legacyCursor = Number(startKey?.cursor ?? Number.NaN);
      const keyedIndex = startKey
        ? matching.findIndex(
            (value) =>
              value.pk === startKey.pk &&
              value.sk === startKey.sk &&
              value.gsi2pk === startKey.gsi2pk &&
              value.gsi2sk === startKey.gsi2sk,
          )
        : -1;
      const start = Number.isFinite(legacyCursor) ? legacyCursor : Math.max(keyedIndex + 1, 0);
      const end = Math.min(start + (input.Limit ?? 100), matching.length);
      const lastEvaluatedRecord = matching[end - 1];
      return {
        items: matching.slice(start, end),
        ...(end < matching.length && lastEvaluatedRecord
          ? {
              lastEvaluatedKey: {
                gsi2pk: lastEvaluatedRecord.gsi2pk,
                gsi2sk: lastEvaluatedRecord.gsi2sk,
                pk: lastEvaluatedRecord.pk,
                sk: lastEvaluatedRecord.sk,
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
  it("ports import, review, index, recall, feedback, and quality workflows", async () => {
    const { database, tables } = memoryDatabase();
    const search = fakeMemorySearchProvider();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({
        embedding: [0.1, 0.2, 0.3],
        model: "openai/text-embedding-3-small",
        provider: "openai",
      }),
      now: () => fixedNow,
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
      name: "Deployment memory",
      workspaceId: ids.workspace,
    });
    const imported = await platform.importMemories(scope, {
      items: [
        {
          content: "Use the Tuesday production change window.",
          idempotencyKey: "import-1",
          scope: "workspace",
          workspaceId: ids.workspace,
        },
      ],
      memorySpaceId: space.data.id,
    });
    expect(imported.imported).toHaveLength(1);
    expect(imported.imported[0]?.data.reviewStatus).toBe("pending");

    const replay = await platform.importMemories(scope, {
      items: [
        {
          content: "Use the Tuesday production change window.",
          idempotencyKey: "import-1",
          scope: "workspace",
          workspaceId: ids.workspace,
        },
      ],
      memorySpaceId: space.data.id,
    });
    expect(replay.replayed).toHaveLength(1);

    const review = (await platform.listReviewItems(scope, { status: "open" }))[0]!;
    const approved = await platform.resolveReview(scope, {
      decision: "approve",
      memoryId: imported.imported[0]!.data.id,
      reviewId: review.data.id,
    });
    expect(approved.memory.data.reviewStatus).toBe("approved");

    const idempotencyKey = `${approved.memory.data.id}:1:${fixedNow.getTime() * 1_000 + 1}:update`;
    await platform.processIndexJob(scope, {
      idempotencyKey,
      memoryId: approved.memory.data.id,
      workerId: "worker-1",
    });
    expect(search.rows.get(approved.memory.data.id)).toMatchObject({
      content: "Use the Tuesday production change window.",
      status: "active",
    });

    const recall = await platform.search(scope, {
      memorySpaceIds: [space.data.id],
      query: "When can production changes happen?",
      searchKeys: [`workspace:${ids.workspace}`],
    });
    expect(recall.results).toHaveLength(1);
    expect(recall.retrievals).toHaveLength(1);
    const tenantRecall = await platform.search(
      {
        environmentId: ids.environment,
        organizationId: ids.organization,
        projectId: ids.project,
      },
      {
        memorySpaceIds: [space.data.id],
        query: "When can production changes happen?",
      },
    );
    expect(tenantRecall.results).toHaveLength(1);
    await platform.recordRetrievalFeedback(
      scope,
      recall.retrievals[0]!.data.id,
      approved.memory.data.id,
      "useful",
      "Correct window",
    );
    expect(await platform.quality(scope)).toMatchObject({
      attempts: 1,
      retrievals: 1,
      usefulness: { useful: 1 },
    });

    const execution = tables.get("execution")!;
    for (const [recordKey, record] of execution) {
      if (record.itemType === "memory-recall-attempt" || record.itemType === "memory-retrieval") {
        execution.set(recordKey, { ...record, ttl: fixedNow.getTime() / 1_000 });
      }
    }
    expect(await platform.quality(scope)).toMatchObject({ attempts: 0, retrievals: 0 });
    expect(
      await platform
        .recordRetrievalFeedback(
          scope,
          recall.retrievals[0]!.data.id,
          approved.memory.data.id,
          "harmful",
        )
        .catch((cause: unknown) => cause),
    ).toMatchObject({ code: "retrieval_not_found", statusCode: 404 });
  });

  it("rejects secret imports before persistence", async () => {
    const { database } = memoryDatabase();
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
    const space = await platform.createMemorySpace(scope, { name: "Organization memory" });
    const result = await platform.importMemories(scope, {
      items: [
        {
          content: "github_pat_1234567890abcdefghijklmnopqrstuv",
          scope: "organization",
        },
        {
          content: "The deployment category is internal.",
          metadata: { integration: { access_token: "credential-value" } },
          scope: "organization",
        },
      ],
      memorySpaceId: space.data.id,
    });
    expect(result.imported).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain("secret-like");
    expect(result.rejected[1]?.reason).toContain("metadata contains secret-like");
  });

  it("requires review for public agent and thread attribution", async () => {
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
    const space = await platform.createMemorySpace(scope, { name: "Attributed imports" });

    const imported = await platform.importMemories(scope, {
      items: [
        {
          agentDefinitionId: ids.agent,
          content: "Agent-attributed public import.",
          scope: "agent",
          source: "api",
        },
        {
          content: "Thread-attributed public import.",
          scope: "thread",
          source: "api",
          threadId: ids.thread,
        },
      ],
      memorySpaceId: space.data.id,
    });

    expect(imported.imported.map((memory) => memory.data.reviewStatus)).toEqual([
      "pending",
      "pending",
    ]);
    expect(platform.listReviewItems(scope, { status: "open" })).resolves.toHaveLength(2);
  });

  it("rejects oversized metadata without failing earlier import items", async () => {
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
    const space = await platform.createMemorySpace(scope, { name: "Metadata limits" });

    const result = await platform.importMemories(scope, {
      items: [
        { content: "Keep the first valid import.", scope: "organization" },
        {
          content: "Reject only this oversized metadata item.",
          metadata: { payload: "x".repeat(70_000) },
          scope: "organization",
        },
      ],
      memorySpaceId: space.data.id,
    });

    expect(result.imported).toHaveLength(1);
    expect(result.rejected).toEqual([
      { index: 1, reason: expect.stringContaining("must not exceed") },
    ]);
  });

  it("tombstones historical secret content without requesting an embedding", async () => {
    const { database, put } = memoryDatabase();
    const search = fakeMemorySearchProvider();
    let embeddingCalls = 0;
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => {
        embeddingCalls += 1;
        return { embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" };
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
    const space = await platform.createMemorySpace(scope, { name: "Unsafe historical" });
    const content = "Bearer abcdefghijklmnopqrstuvwxyz123456";
    const memory = memoryFixture({
      body: content,
      contentHash: memoryContentHash(content),
      memorySpaceId: space.data.id,
    });
    put("control", memory);
    search.rows.set(memory.data.id, {
      content,
      contentHash: memory.data.contentHash,
      id: memory.data.id,
      memorySpaceId: memory.data.memorySpaceId,
      memoryVersion: memory.data.version,
      reviewStatus: "approved",
      scopeKey: `workspace:${ids.workspace}`,
      searchKey: memory.data.searchKey,
      sensitivity: memory.data.sensitivity,
      status: "active",
    });
    const job = await platform.enqueueIndexJob({
      memory,
      scope,
      synchronizationGeneration: 41,
    });

    const completed = await platform.processIndexJob(scope, {
      idempotencyKey: job.data.idempotencyKey,
      memoryId: memory.data.id,
    });

    expect(completed.data.skipReason).toBe("unsafe-index-content");
    expect(search.rows.get(memory.data.id)).toMatchObject({ content: "", status: "deleted" });
    expect(embeddingCalls).toBe(0);
  });

  it("tombstones memories whose governing space is missing", async () => {
    const { database, put } = memoryDatabase();
    const search = fakeMemorySearchProvider();
    let embeddingCalls = 0;
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => {
        embeddingCalls += 1;
        return { embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" };
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
    const memory = memoryFixture();
    put("control", memory);
    search.rows.set(memory.data.id, {
      content: memory.data.body,
      contentHash: memory.data.contentHash,
      id: memory.data.id,
      memorySpaceId: memory.data.memorySpaceId,
      memoryVersion: memory.data.version,
      reviewStatus: "approved",
      scopeKey: `workspace:${ids.workspace}`,
      searchKey: memory.data.searchKey,
      sensitivity: memory.data.sensitivity,
      status: "active",
    });
    const job = await platform.enqueueIndexJob({
      memory,
      scope,
      synchronizationGeneration: 43,
    });

    await platform.processIndexJob(scope, {
      idempotencyKey: job.data.idempotencyKey,
      memoryId: memory.data.id,
    });

    expect(embeddingCalls).toBe(0);
    expect(search.rows.get(memory.data.id)).toMatchObject({ content: "", status: "deleted" });
  });

  it("repairs legacy deleted rows that still retain content", async () => {
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
    const legacy = memoryFixture({
      body: "Legacy deleted plaintext",
      deletedAt: fixedNow.toISOString(),
      metadata: { legacySecret: "remove" },
      status: "deleted",
    });
    put("control", legacy);

    expect(platform.reconcile(scope)).resolves.toEqual({ inspected: 1, queued: 1 });

    const repaired = [...(tables.get("control")?.values() ?? [])].find(
      (record) => record.itemType === "memory" && record.data.id === legacy.data.id,
    );
    expect(repaired?.data).toMatchObject({ id: legacy.data.id, status: "deleted" });
    expect(repaired?.data).not.toHaveProperty("body");
    expect(repaired?.data).not.toHaveProperty("bodyRef");
    expect(repaired?.data).not.toHaveProperty("metadata");
    expect(
      [...(tables.get("execution")?.values() ?? [])].filter(
        (record) => record.itemType === "memory-index-job",
      ),
    ).toHaveLength(1);
    const repairEvent = [...(tables.get("events")?.values() ?? [])].find(
      (record) =>
        record.itemType === "semantic-event" &&
        record.data.eventType === "memory.tombstone-repaired",
    );
    expect(repairEvent?.data).toMatchObject({
      aggregateType: "memory-tombstone-repair",
      aggregateVersion: 1,
      payload: { memoryId: legacy.data.id, status: "deleted" },
    });
  });

  it("reconciles orphaned memories without aborting later repairs", async () => {
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
    const space = await platform.createMemorySpace(scope, { name: "Valid repair space" });
    put("control", memoryFixture());
    put("control", memoryFixture({ id: ids.memory2, memorySpaceId: space.data.id, version: 4 }));

    expect(platform.reconcile(scope)).resolves.toEqual({ inspected: 2, queued: 2 });
    expect(
      [...(tables.get("execution")?.values() ?? [])].filter(
        (value) => value.itemType === "memory-index-job",
      ),
    ).toHaveLength(2);
  });

  it("reconciles memories in durable pages", async () => {
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
    for (let index = 0; index < 101; index += 1) {
      put("control", memoryFixture({ id: indexedUlid(16_000 + index) }));
    }

    const firstPage = await platform.reconcile(scope);

    expect(firstPage).toMatchObject({ inspected: 100, queued: 100 });
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const nextCursor = firstPage.nextCursor;
    if (!nextCursor) throw new Error("Expected reconciliation continuation cursor.");
    const continuation = [...(tables.get("events")?.values() ?? [])].find(
      (value) =>
        value.itemType === "semantic-event" &&
        value.data.eventType === "memory.reconcile.continuation",
    );
    expect(continuation).toMatchObject({
      data: {
        aggregateType: "memory-reconciliation",
        aggregateVersion: 1,
        payload: { cursor: nextCursor, workspaceId: ids.workspace },
      },
    });

    expect(platform.reconcile(scope, { cursor: nextCursor })).resolves.toEqual({
      inspected: 1,
      queued: 1,
    });
  });
});
