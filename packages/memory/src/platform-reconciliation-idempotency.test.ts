import { describe, expect, it } from "bun:test";
import type {
  DynamoDatabaseService,
  PlatformRecord,
  QueryRecordsResult,
  TransactionOperation,
  Ulid,
} from "@deployments-ai/db";
import { withCanonicalRecordKeys } from "@deployments-ai/db";
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
  it("keeps workspace reconciliation from processing broader memories", async () => {
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
    const workspaceScope = { ...scope, workspaceId: ids.workspace };
    const space = await platform.createMemorySpace(scope, { name: "Broader retention" });
    await platform.upsertPolicy(scope, { retentionDays: 90, scope: "environment" });
    await platform.upsertPolicy(workspaceScope, {
      retentionDays: 1,
      scope: "workspace",
    });
    const workspaceMemory = memoryFixture({ memorySpaceId: space.data.id });
    const {
      retentionExpiresAt: _retentionExpiresAt,
      workspaceId: _workspaceId,
      ...memoryData
    } = workspaceMemory.data;
    const memory = withCanonicalRecordKeys({
      data: {
        ...memoryData,
        scope: "organization" as const,
        searchKey: `organization:${ids.organization}`,
      },
      itemType: "memory" as const,
    }) as ReturnType<typeof memoryFixture>;
    put("control", memory);

    expect(platform.reconcile(workspaceScope)).resolves.toEqual({ inspected: 0, queued: 0 });

    const untouched = await platform.requiredMemory(scope, memory.data.id);
    expect(untouched.data.retentionExpiresAt).toBeUndefined();

    await platform.reconcile(scope);

    const updated = await platform.requiredMemory(scope, memory.data.id);
    expect(updated.data.retentionExpiresAt).toBe("2026-10-19T12:00:00.000Z");
  });

  it("applies broader policy reconciliation to inherited workspace memories", async () => {
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
    const workspaceScope = { ...scope, workspaceId: ids.workspace };
    const space = await platform.createMemorySpace(workspaceScope, {
      name: "Inherited workspace retention",
    });
    const memory = memoryFixture({
      createdAt: "2026-07-20T12:00:00.000Z",
      memorySpaceId: space.data.id,
      retentionExpiresAt: undefined,
    });
    put("control", memory);
    await platform.upsertPolicy(scope, { retentionDays: 7, scope: "environment" });

    expect(platform.reconcile(scope)).resolves.toMatchObject({ inspected: 1, queued: 1 });

    const updated = await platform.requiredMemory(workspaceScope, memory.data.id);
    expect(updated.data.retentionExpiresAt).toBe("2026-07-27T12:00:00.000Z");
  });

  it("rejects idempotency-key reuse for different import content", async () => {
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
    const space = await platform.createMemorySpace(scope, { name: "Evidence" });
    await platform.importMemories(scope, {
      items: [
        { content: "First durable fact.", idempotencyKey: "same-key", scope: "organization" },
      ],
      memorySpaceId: space.data.id,
    });

    expect(
      platform.importMemories(scope, {
        items: [
          { content: "Different durable fact.", idempotencyKey: "same-key", scope: "organization" },
        ],
        memorySpaceId: space.data.id,
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict", statusCode: 409 });
  });

  it("canonicalizes structured import metadata for idempotent retries", async () => {
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
    const space = await platform.createMemorySpace(scope, { name: "Canonical metadata" });
    const first = await platform.importMemories(scope, {
      items: [
        {
          content: "Canonical idempotent metadata.",
          idempotencyKey: "canonical-metadata",
          metadata: { alpha: 1, nested: { one: 1, two: 2 } },
          scope: "organization",
        },
      ],
      memorySpaceId: space.data.id,
    });
    const replayed = await platform.importMemories(scope, {
      items: [
        {
          content: "Canonical idempotent metadata.",
          idempotencyKey: "canonical-metadata",
          metadata: { nested: { two: 2, one: 1 }, alpha: 1 },
          scope: "organization",
        },
      ],
      memorySpaceId: space.data.id,
    });

    expect(replayed.replayed[0]?.data.id).toBe(first.imported[0]?.data.id);
  });

  it("derives fallback import idempotency from all semantic attributes", async () => {
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
    const space = await platform.createMemorySpace(scope, { name: "Fallback identity" });

    const result = await platform.importMemories(scope, {
      items: [
        { content: "Shared thread fact.", scope: "thread", threadId: ids.thread },
        { content: "Shared thread fact.", scope: "thread", threadId: indexedUlid(17_000) },
      ],
      memorySpaceId: space.data.id,
    });

    expect(result.imported).toHaveLength(2);
    expect(result.imported[0]?.data.idempotencyKey).not.toBe(
      result.imported[1]?.data.idempotencyKey,
    );
  });

  it("repairs a missing index job when an import is replayed", async () => {
    const { database, tables } = memoryDatabase();
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
    const space = await platform.createMemorySpace(scope, { name: "Replay repair" });
    const input = {
      items: [
        {
          content: "Repair this import index job.",
          idempotencyKey: "repair-import",
          scope: "organization" as const,
        },
      ],
      memorySpaceId: space.data.id,
    };
    await platform.importMemories(scope, input);
    const execution = tables.get("execution")!;
    for (const [recordKey, value] of execution) {
      if (value.itemType === "memory-index-job") execution.delete(recordKey);
    }
    expect(
      [...execution.values()].filter((value) => value.itemType === "memory-index-job"),
    ).toHaveLength(0);

    const replay = await platform.importMemories(scope, input);

    expect(replay.replayed).toHaveLength(1);
    expect(
      [...execution.values()].filter((value) => value.itemType === "memory-index-job"),
    ).toHaveLength(1);
  });

  it("completes empty flush extraction without creating an invalid import", async () => {
    const { database } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });

    expect(
      platform.importFlushCandidates(
        {
          environmentId: ids.environment,
          organizationId: ids.organization,
          projectId: ids.project,
        },
        {
          candidates: [],
          flushId: ids.memory2,
          memoryMode: "workspace",
          memorySpaceId: ids.space,
          run: { data: { id: ids.run, threadId: ids.thread } } as never,
        },
      ),
    ).resolves.toEqual({ candidateKeys: [], imported: [], rejected: [], replayed: [] });
  });

  it("requires archive before permanent deletion", async () => {
    const { database, put, transactions } = memoryDatabase();
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
    const space = await platform.createMemorySpace(scope, { name: "Lifecycle" });
    const imported = await platform.importMemories(scope, {
      items: [
        {
          content: "Durable lifecycle fact.",
          metadata: { privateContext: "remove on delete" },
          scope: "organization",
        },
      ],
      memorySpaceId: space.data.id,
    });
    const memoryId = imported.imported[0]!.data.id;
    const review = (await platform.listReviewItems(scope, { status: "open" }))[0]!;
    put("execution", {
      ...review,
      data: { ...review.data, proposedContent: "Durable lifecycle fact." },
    });

    expect(platform.deleteMemory(scope, memoryId)).rejects.toMatchObject({
      code: "invalid_lifecycle",
      statusCode: 409,
    });
    await platform.archiveMemory(scope, memoryId);
    const deleted = await platform.deleteMemory(scope, memoryId);
    expect(deleted.data.status).toBe("deleted");
    expect(deleted.data.body).toBeUndefined();
    expect(deleted.data.bodyRef).toBeUndefined();
    expect(deleted.data.metadata).toBeUndefined();
    expect(await platform.listReviewItems(scope, { status: "open" })).toEqual([]);
    const resolvedReviews = await platform.listReviewItems(scope, { status: "resolved" });
    expect(resolvedReviews).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          decision: "delete",
          id: review.data.id,
          resolutionReason: "Memory was permanently deleted.",
          status: "resolved",
        }),
      }),
    );
    expect(resolvedReviews[0]?.data.proposedContent).toBeUndefined();
    expect(
      transactions.some((operations) =>
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "semantic-event" &&
            operation.record.data.eventType === "memory.review-content-cleanup.requested",
        ),
      ),
    ).toBe(true);
    expect(
      transactions.some(
        (operations) =>
          operations.some(
            (operation) =>
              operation.kind === "put" &&
              operation.record.itemType === "memory" &&
              operation.record.data.status === "deleted",
          ) &&
          operations.some(
            (operation) =>
              operation.kind === "put" && operation.record.itemType === "memory-index-job",
          ),
      ),
    ).toBe(true);
  });

  it("does not scrub review content before permanent deletion commits", async () => {
    const fixture = memoryDatabase();
    const database: DynamoDatabaseService = {
      ...fixture.database,
      transactWrite: (operations, token) =>
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "memory" &&
            operation.record.data.status === "deleted",
        )
          ? Promise.reject(new Error("delete transaction failed"))
          : fixture.database.transactWrite(operations, token),
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
    const space = await platform.createMemorySpace(scope, { name: "Failed deletion" });
    const imported = await platform.importMemories(scope, {
      items: [{ content: "Retain until deletion commits.", scope: "organization" }],
      memorySpaceId: space.data.id,
    });
    const memoryId = imported.imported[0]!.data.id;
    const review = (await platform.listReviewItems(scope, { status: "open" }))[0]!;
    fixture.put("execution", {
      ...review,
      data: { ...review.data, proposedContent: "Retain until deletion commits." },
    });
    await platform.archiveMemory(scope, memoryId);

    expect(platform.deleteMemory(scope, memoryId)).rejects.toThrow("delete transaction failed");

    expect((await platform.listReviewItems(scope))[0]?.data.proposedContent).toBe(
      "Retain until deletion commits.",
    );
  });

  it("deletes referenced blob versions before permanent deletion", async () => {
    const { database, put, tables } = memoryDatabase();
    const deleted: unknown[] = [];
    const platform = makeMemoryPlatform({
      database,
      deleteBlob: async (reference) => {
        deleted.push(reference);
      },
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
    const bodyRef = {
      bucket: "platform-artifacts",
      byteSize: 12,
      contentType: "text/plain; charset=utf-8",
      key: "memory/deleted-body.txt",
      sha256: memoryContentHash("deleted body"),
      versionId: "version-1",
    };
    const memory = memoryFixture({
      archivedAt: fixedNow.toISOString(),
      body: undefined,
      bodyRef,
      status: "archived",
    });
    put("control", memory);

    const result = await platform.deleteMemory(scope, memory.data.id);

    expect(result.data.status).toBe("deleted");
    expect(result.data.bodyRef).toBeUndefined();
    expect(deleted).toEqual([]);
    expect(
      [...(tables.get("events")?.values() ?? [])].some(
        (value) =>
          value.itemType === "semantic-event" &&
          value.data.eventType === "memory.blob-cleanup.requested" &&
          value.data.payload.blobVersionId === "version-1",
      ),
    ).toBe(true);
    await platform.cleanupMemoryBlob(bodyRef);
    expect(deleted).toEqual([bodyRef]);
  });
});
