import type {
  DynamoDatabaseService,
  PlatformRecord,
  QueryRecordsResult,
  TransactionOperation,
  Ulid,
} from "@deployments-ai/db";
import { describe, expect, it } from "bun:test";
import { memoryContentHash } from "./governance.ts";
import { makeMemoryPlatform } from "./platform.ts";
import { ids, memoryFixture, optionalExpressionString } from "./test-fixtures.ts";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";
const fixedNow = new Date("2026-07-21T18:00:00.000Z");
const ulidAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function _indexedUlid(index: number) {
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
  it("links archived and pending predecessors without changing their lifecycle state", async () => {
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
      workspaceId: ids.workspace,
    };
    const space = await platform.createMemorySpace(scope, {
      kind: "workspace",
      name: "Supersession state links",
    });
    const archivedImport = await platform.importMemories(scope, {
      items: [
        {
          content: "Archived predecessor",
          scope: "thread",
          source: "tool",
          threadId: ids.thread,
          workspaceId: ids.workspace,
        },
      ],
      memorySpaceId: space.data.id,
    });
    const archivedPredecessor = archivedImport.imported[0]!;
    await platform.archiveMemory(scope, archivedPredecessor.data.id);
    const archivedSuccessor = await platform.importMemories(scope, {
      items: [
        {
          content: "Approved replacement for archived predecessor",
          scope: "thread",
          source: "tool",
          supersedesMemoryId: archivedPredecessor.data.id,
          threadId: ids.thread,
          workspaceId: ids.workspace,
        },
      ],
      memorySpaceId: space.data.id,
    });
    expect(platform.requiredMemory(scope, archivedPredecessor.data.id)).resolves.toMatchObject({
      data: {
        status: "archived",
        supersededByMemoryId: archivedSuccessor.imported[0]!.data.id,
      },
    });

    const pendingImport = await platform.importMemories(scope, {
      items: [
        {
          content: "Pending predecessor",
          scope: "thread",
          source: "api",
          threadId: ids.thread,
          workspaceId: ids.workspace,
        },
      ],
      memorySpaceId: space.data.id,
    });
    const pendingPredecessor = pendingImport.imported[0]!;
    expect(pendingPredecessor.data.reviewStatus).toBe("pending");
    const pendingSuccessor = await platform.importMemories(scope, {
      items: [
        {
          content: "Approved replacement for pending predecessor",
          scope: "thread",
          source: "tool",
          supersedesMemoryId: pendingPredecessor.data.id,
          threadId: ids.thread,
          workspaceId: ids.workspace,
        },
      ],
      memorySpaceId: space.data.id,
    });
    expect(platform.requiredMemory(scope, pendingPredecessor.data.id)).resolves.toMatchObject({
      data: {
        reviewStatus: "pending",
        status: "active",
        supersededByMemoryId: pendingSuccessor.imported[0]!.data.id,
      },
    });
    const pendingReview = (await platform.listReviewItems(scope, { status: "open" })).find(
      (review) => review.data.memoryId === pendingPredecessor.data.id,
    );
    expect(
      platform.resolveReview(scope, {
        decision: "approve",
        memoryId: pendingPredecessor.data.id,
        reviewId: pendingReview!.data.id,
      }),
    ).rejects.toMatchObject({ code: "memory_superseded", statusCode: 409 });
  });

  it("rejects deleted predecessors and links archived predecessors during reviewed supersession", async () => {
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
      workspaceId: ids.workspace,
    };
    const space = await platform.createMemorySpace(scope, {
      kind: "workspace",
      name: "Reviewed supersession states",
    });
    const first = await platform.importMemories(scope, {
      items: [
        {
          content: "Reviewed archived predecessor",
          scope: "thread",
          source: "tool",
          threadId: ids.thread,
          workspaceId: ids.workspace,
        },
      ],
      memorySpaceId: space.data.id,
    });
    const archivedPredecessor = first.imported[0]!;
    await platform.archiveMemory(scope, archivedPredecessor.data.id);
    const generated = await platform.importMemories(scope, {
      items: [
        {
          content: "Reviewed replacement",
          scope: "thread",
          source: "flush",
          sourceRunId: ids.run,
          supersedesMemoryId: archivedPredecessor.data.id,
          threadId: ids.thread,
          workspaceId: ids.workspace,
        },
      ],
      memorySpaceId: space.data.id,
    });
    const generatedMemory = generated.imported[0]!;
    const generatedReview = (await platform.listReviewItems(scope, { status: "open" })).find(
      (review) => review.data.memoryId === generatedMemory.data.id,
    );
    await platform.resolveReview(scope, {
      decision: "approve",
      memoryId: generatedMemory.data.id,
      reviewId: generatedReview!.data.id,
    });
    expect(platform.requiredMemory(scope, archivedPredecessor.data.id)).resolves.toMatchObject({
      data: { status: "archived", supersededByMemoryId: generatedMemory.data.id },
    });

    const deletedImport = await platform.importMemories(scope, {
      items: [
        {
          content: "Deleted predecessor",
          scope: "thread",
          source: "tool",
          threadId: ids.thread,
          workspaceId: ids.workspace,
        },
      ],
      memorySpaceId: space.data.id,
    });
    const deletedPredecessor = deletedImport.imported[0]!;
    await platform.archiveMemory(scope, deletedPredecessor.data.id);
    await platform.deleteMemory(scope, deletedPredecessor.data.id);
    const rejected = await platform.importMemories(scope, {
      items: [
        {
          content: "Invalid replacement for deleted predecessor",
          scope: "thread",
          source: "tool",
          supersedesMemoryId: deletedPredecessor.data.id,
          threadId: ids.thread,
          workspaceId: ids.workspace,
        },
      ],
      memorySpaceId: space.data.id,
    });
    expect(rejected.imported).toEqual([]);
    expect(rejected.rejected).toEqual([
      { index: 0, reason: "Permanently deleted memory cannot be superseded." },
    ]);
  });

  it("requires review before model-generated supersession", async () => {
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
      workspaceId: ids.workspace,
    };
    const space = await platform.createMemorySpace(scope, {
      kind: "workspace",
      name: "Reviewed supersession",
    });
    const first = await platform.importMemories(scope, {
      items: [
        {
          content: "Production deploys run on Monday.",
          scope: "thread",
          source: "tool",
          threadId: ids.thread,
          workspaceId: ids.workspace,
        },
      ],
      memorySpaceId: space.data.id,
    });
    const predecessor = first.imported[0]!;
    const generated = await platform.importMemories(scope, {
      items: [
        {
          content: "Production deploys run on Tuesday.",
          scope: "thread",
          source: "flush",
          sourceRunId: ids.run,
          supersedesMemoryId: predecessor.data.id,
          threadId: ids.thread,
          workspaceId: ids.workspace,
        },
      ],
      memorySpaceId: space.data.id,
    });
    expect(generated.imported[0]?.data.reviewStatus).toBe("pending");
    const [review] = await platform.listReviewItems(scope, { status: "open" });
    expect(review?.data).toMatchObject({
      kind: "supersession",
      supersedesMemoryId: predecessor.data.id,
    });
    expect(review?.data.reason).toContain("will archive predecessor memory");
    await platform.archiveMemory(scope, generated.imported[0]!.data.id);
    expect(
      platform.resolveReview(scope, {
        decision: "approve",
        memoryId: generated.imported[0]!.data.id,
        reviewId: review!.data.id,
      }),
    ).rejects.toMatchObject({ code: "supersession_successor_inactive", statusCode: 409 });
    expect(platform.requiredMemory(scope, predecessor.data.id)).resolves.toMatchObject({
      data: { status: "active" },
    });

    await platform.restoreMemory(scope, generated.imported[0]!.data.id);
    const approved = await platform.resolveReview(scope, {
      decision: "approve",
      memoryId: generated.imported[0]!.data.id,
      reviewId: review!.data.id,
    });
    expect(platform.requiredMemory(scope, predecessor.data.id)).resolves.toMatchObject({
      data: { status: "archived", supersededByMemoryId: approved.memory.data.id },
    });
  });

  it("discloses predecessor archival on API supersession reviews", async () => {
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
      workspaceId: ids.workspace,
    };
    const space = await platform.createMemorySpace(scope, {
      kind: "workspace",
      name: "API supersession review",
    });
    const first = await platform.importMemories(scope, {
      items: [
        {
          content: "Production deploys run on Monday.",
          scope: "thread",
          source: "tool",
          threadId: ids.thread,
          workspaceId: ids.workspace,
        },
      ],
      memorySpaceId: space.data.id,
    });
    const predecessor = first.imported[0]!;
    const second = await platform.importMemories(scope, {
      items: [
        {
          content: "Production deploys run on Tuesday.",
          scope: "thread",
          source: "api",
          supersedesMemoryId: predecessor.data.id,
          threadId: ids.thread,
          workspaceId: ids.workspace,
        },
      ],
      memorySpaceId: space.data.id,
    });
    const successor = second.imported[0]!;
    const review = (await platform.listReviewItems(scope, { status: "open" })).find(
      (item) => item.data.memoryId === successor.data.id,
    );

    expect(review).toMatchObject({
      data: {
        kind: "supersession",
        reason: `Approving this memory will archive predecessor memory ${predecessor.data.id}.`,
        supersedesMemoryId: predecessor.data.id,
      },
    });
  });

  it("rejects content that cannot fit the embedding context", async () => {
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
    const space = await platform.createMemorySpace(scope, { name: "Embedding boundary" });

    const result = await platform.importMemories(scope, {
      items: [{ content: "x".repeat(8_001), scope: "organization" }],
      memorySpaceId: space.data.id,
    });
    expect(result.imported).toEqual([]);
    expect(result.rejected).toEqual([
      { index: 0, reason: "Memory content must not exceed 8000 UTF-8 bytes." },
    ]);
    expect(embeddingCalls).toBe(0);
  });

  it("conditions imports on the memory space remaining active", async () => {
    const fixture = memoryDatabase();
    let sawActiveSpaceCondition = false;
    const database: DynamoDatabaseService = {
      ...fixture.database,
      transactWrite: (operations, token) => {
        if (
          operations.some(
            (operation) =>
              operation.kind === "condition-check" &&
              operation.expressionAttributeValues?.[":itemType"] === "memory-space" &&
              operation.expressionAttributeValues?.[":status"] === "active",
          )
        ) {
          sawActiveSpaceCondition = true;
          return Promise.reject(new Error("memory space archived concurrently"));
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
    const space = await platform.createMemorySpace(scope, { name: "Import race" });

    expect(
      platform.importMemories(scope, {
        items: [{ content: "Do not commit after archival.", scope: "organization" }],
        memorySpaceId: space.data.id,
      }),
    ).rejects.toThrow("memory space archived concurrently");
    expect(sawActiveSpaceCondition).toBe(true);
  });

  it("suppresses oversized historical content without embedding it", async () => {
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
    const space = await platform.createMemorySpace(scope, { name: "Historical size boundary" });
    const content = "x".repeat(8_001);
    const memory = memoryFixture({
      body: content,
      contentHash: memoryContentHash(content),
      memorySpaceId: space.data.id,
    });
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
      }),
    ).resolves.toMatchObject({ data: { skipReason: "embedding-content-too-large" } });
    expect(embeddingCalls).toBe(0);
  });
});
