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
  it("uses effective policy retention for imports and reapplies retention changes", async () => {
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
    const space = await platform.createMemorySpace(scope, {
      name: "Retention precedence",
      retentionDays: 90,
    });
    const policy = await platform.upsertPolicy(scope, { retentionDays: 10 });
    const imported = await platform.importMemories(scope, {
      items: [{ content: "Durable retention fact.", scope: "organization" }],
      memorySpaceId: space.data.id,
    });
    expect(imported.imported[0]?.data.retentionExpiresAt).toBe("2026-07-31T18:00:00.000Z");

    await platform.upsertPolicy(scope, { id: policy.data.id, retentionDays: 5 });
    const beforeReconciliation = await platform.requiredMemory(
      scope,
      imported.imported[0]!.data.id,
    );
    expect(beforeReconciliation.data.retentionExpiresAt).toBe("2026-07-31T18:00:00.000Z");
    await platform.reconcile(scope);
    const updated = await platform.requiredMemory(scope, imported.imported[0]!.data.id);
    expect(updated.data.retentionExpiresAt).toBe("2026-07-26T18:00:00.000Z");
    expect(updated.data.version).toBe(imported.imported[0]!.data.version + 1);
  });

  it("purges retention-expired content and leaves a deletion tombstone", async () => {
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
    const space = await platform.createMemorySpace(scope, {
      name: "Short retention",
      retentionDays: 1,
    });
    const content = "Expired deployment guidance.";
    const contentHash = memoryContentHash(content);
    const memory = memoryFixture({
      body: undefined,
      bodyRef: {
        bucket: "platform-artifacts",
        byteSize: Buffer.byteLength(content),
        contentType: "text/plain; charset=utf-8",
        key: "memory/expired.txt",
        sha256: contentHash,
        versionId: "version-1",
      },
      contentHash,
      createdAt: "2026-07-19T12:00:00.000Z",
      memorySpaceId: space.data.id,
      metadata: { source: "expired-test" },
      retentionExpiresAt: "2026-07-20T12:00:00.000Z",
    });
    put("control", memory);

    expect(platform.reconcile(scope)).resolves.toMatchObject({ inspected: 1, queued: 1 });

    const tombstone = await platform.requiredMemory(scope, memory.data.id);
    expect(tombstone.data).toMatchObject({
      deletedAt: fixedNow.toISOString(),
      status: "deleted",
    });
    expect(tombstone.data.body).toBeUndefined();
    expect(tombstone.data.bodyRef).toBeUndefined();
    expect(tombstone.data.metadata).toBeUndefined();
    expect(platform.exportMemoriesPage(scope)).resolves.toMatchObject({
      items: [{ data: { id: memory.data.id, status: "deleted" } }],
    });
    const eventTypes = [...(tables.get("events")?.values() ?? [])]
      .filter((value) => value.itemType === "semantic-event")
      .map((value) => value.data.eventType);
    expect(eventTypes).toContain("memory.expired");
    expect(eventTypes).toContain("memory.blob-cleanup.requested");
    expect(eventTypes).toContain("memory.review-content-cleanup.requested");
  });
});
