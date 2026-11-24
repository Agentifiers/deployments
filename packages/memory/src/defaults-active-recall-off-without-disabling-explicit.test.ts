import type {
  DynamoDatabaseService,
  PlatformRecord,
  QueryRecordsResult,
  TransactionOperation,
  Ulid,
} from "@deployments-ai/db";
import { describe, expect, it } from "bun:test";
import { makeMemoryPlatform } from "./platform.ts";
import { MemoryRerankUsagePersistenceError } from "./retrieval.ts";
import { ids, memoryFixture, optionalExpressionString } from "./test-fixtures.ts";
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
    putRecord: async (record, conditionExpression) => {
      const name = record.itemType === "semantic-event" ? "events" : tableName(record);
      const recordKey = `${record.pk}\u0000${record.sk}`;
      if (conditionExpression?.includes("attribute_not_exists") && table(name).has(recordKey)) {
        throw new Error("conditional write failed");
      }
      put(name, record);
    },
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
    record.itemType === "memory-review-item" ||
    record.itemType === "memory-shadow-job"
  ) {
    return "execution";
  }
  return "control";
}

describe("memory platform", () => {
  it("defaults active recall off without disabling explicit search", async () => {
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

    const recall = await platform.search(scope, {
      memorySpaceIds: [],
      purpose: "active-recall",
      query: "deployment context",
      runId: ids.run,
      threadId: ids.thread,
    });

    expect(recall.attempt.data.status).toBe("skipped");
    expect(recall.attempt.data.skipReason).toBe("active-recall-disabled");
    expect(recall.attempt.data).toMatchObject({ runId: ids.run, threadId: ids.thread });
    expect(embeddingCalls).toBe(0);
  });

  it("skips active recall without grants before requesting an embedding", async () => {
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
    await platform.upsertPolicy(scope, { activeRecallEnabled: true });

    const result = await platform.search(scope, {
      allowedScopeKeys: [],
      memorySpaceIds: [],
      purpose: "active-recall",
      query: "deployment context",
      runId: ids.run,
      threadId: ids.thread,
      searchKeys: [],
    });

    expect(result.attempt.data.skipReason).toBe("no-memory-access");
    expect(embeddingCalls).toBe(0);
  });

  it("keeps custom search keys separate from canonical scope authorization", async () => {
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
    };
    const space = await platform.createMemorySpace(scope, { name: "Custom search key" });
    const memory = memoryFixture({
      memorySpaceId: space.data.id,
      scope: "organization",
      searchKey: "custom:operations",
      workspaceId: undefined,
    });
    put("control", memory);
    search.rows.set(memory.data.id, {
      contentHash: memory.data.contentHash,
      id: memory.data.id,
      memorySpaceId: memory.data.memorySpaceId,
      memoryVersion: memory.data.version,
      reviewStatus: "approved",
      scopeKey: `organization:${ids.organization}`,
      searchKey: memory.data.searchKey,
      sensitivity: "internal",
      status: "active",
    });

    const recall = await platform.search(scope, {
      memorySpaceIds: [space.data.id],
      query: "operations",
      searchKeys: ["custom:operations"],
    });

    expect(recall.results).toHaveLength(1);
  });

  it("uses workspace policy when an environment caller searches a workspace space", async () => {
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
    };
    const workspaceScope = { ...scope, workspaceId: ids.workspace };
    await platform.upsertPolicy(scope, { scope: "environment", sensitivityMode: "strict" });
    await platform.upsertPolicy(workspaceScope, {
      scope: "workspace",
      sensitivityMode: "restricted",
    });
    const space = await platform.createMemorySpace(workspaceScope, {
      kind: "workspace",
      name: "Workspace policy search",
    });
    const memory = memoryFixture({
      memorySpaceId: space.data.id,
      sensitivity: "confidential",
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
      sensitivity: memory.data.sensitivity,
      status: "active",
    });

    const recall = await platform.search(scope, {
      memorySpaceIds: [space.data.id],
      query: "production change window",
    });

    expect(recall.results.map((result) => result.memory.data.id)).toEqual([memory.data.id]);
  });

  it("fuses mixed sensitivity policies in one globally ranked query", async () => {
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
    };
    const workspaceScope = { ...scope, workspaceId: ids.workspace };
    await platform.upsertPolicy(scope, { scope: "environment", sensitivityMode: "strict" });
    await platform.upsertPolicy(workspaceScope, {
      scope: "workspace",
      sensitivityMode: "restricted",
    });
    const environmentSpace = await platform.createMemorySpace(scope, {
      kind: "organization",
      name: "Strict space",
    });
    const workspaceSpace = await platform.createMemorySpace(workspaceScope, {
      kind: "workspace",
      name: "Restricted space",
    });
    const environmentMemory = memoryFixture({
      id: indexedUlid(13_400),
      memorySpaceId: environmentSpace.data.id,
      scope: "organization",
      searchKey: `organization:${ids.organization}`,
      workspaceId: undefined,
    });
    const workspaceMemory = memoryFixture({
      id: indexedUlid(13_401),
      memorySpaceId: workspaceSpace.data.id,
      sensitivity: "confidential",
    });
    for (const memory of [environmentMemory, workspaceMemory]) {
      put("control", memory);
      search.rows.set(memory.data.id, {
        contentHash: memory.data.contentHash,
        id: memory.data.id,
        memorySpaceId: memory.data.memorySpaceId,
        memoryVersion: memory.data.version,
        reviewStatus: "approved",
        scopeKey:
          memory.data.scope === "organization"
            ? `organization:${ids.organization}`
            : `workspace:${ids.workspace}`,
        searchKey: memory.data.searchKey,
        sensitivity: memory.data.sensitivity,
        status: "active",
      });
    }

    const recall = await platform.search(scope, {
      memorySpaceIds: [environmentSpace.data.id, workspaceSpace.data.id],
      query: "production change window",
    });

    expect(search.queries).toHaveLength(1);
    expect(recall.results.map((result) => result.memory.data.id).sort()).toEqual(
      [environmentMemory.data.id, workspaceMemory.data.id].sort(),
    );
  });

  it("rejects sensitive custom search keys before persistence or search", async () => {
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
    const space = await platform.createMemorySpace(scope, { name: "Safe search keys" });
    const imported = await platform.importMemories(scope, {
      items: [
        {
          content: "Durable deployment guidance.",
          scope: "organization",
          searchKey: "custom:owner@example.com",
        },
      ],
      memorySpaceId: space.data.id,
    });
    expect(imported.rejected[0]?.reason).toContain("personal data");
    expect(
      platform.search(scope, {
        memorySpaceIds: [space.data.id],
        query: "deployment",
        searchKeys: ["custom:sk-example-secret-value-123456"],
      }),
    ).rejects.toMatchObject({ code: "invalid_search_key", statusCode: 400 });
    expect(
      platform.search(scope, {
        memorySpaceIds: [space.data.id],
        query: "deployment",
        searchKeys: Array.from({ length: 51 }, (_, index) => `custom:key-${index}`),
      }),
    ).rejects.toMatchObject({ code: "invalid_search_key", statusCode: 400 });
    expect(embeddingCalls).toBe(0);
  });

  it("rejects exact dense control before embedding on an unsupported provider", async () => {
    const { database } = memoryDatabase();
    let embeddingCalls = 0;
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => {
        embeddingCalls += 1;
        return { embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" };
      },
      now: () => fixedNow,
      searchProvider: {
        ...fakeMemorySearchProvider().provider,
        delete: async () => ({ status: "synchronized" }),
        readiness: async () => ({
          denseReady: true,
          lexicalReady: true,
          reference: "test",
          ready: true,
          schemaReady: true,
        }),
        query: async () => [],
        queryExact: async () => [],
        queryLexical: async () => [],
        synchronizeLifecycle: async () => ({ status: "synchronized" }),
        write: async () => ({ status: "written" }),
      },
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(scope, { name: "Exact control" });

    expect(
      platform.search(scope, {
        denseExactControl: true,
        memorySpaceIds: [space.data.id],
        query: "deployment marker",
        strategyOverride: "dense-v1",
      }),
    ).rejects.toMatchObject({
      code: "memory_search_strategy_unsupported",
      statusCode: 400,
    });
    expect(embeddingCalls).toBe(0);
  });

  it("forces governed queries onto dense retrieval", async () => {
    const { database } = memoryDatabase();
    let denseQueries = 0;
    let lexicalQueries = 0;
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: {
        ...fakeMemorySearchProvider().provider,
        delete: async () => ({ status: "synchronized" }),
        readiness: async () => ({
          denseReady: true,
          lexicalReady: true,
          reference: "test",
          ready: true,
          schemaReady: true,
        }),
        query: async () => {
          denseQueries += 1;
          return [];
        },
        queryExact: async () => [],
        queryLexical: async () => {
          lexicalQueries += 1;
          return [];
        },
        synchronizeLifecycle: async () => ({ status: "synchronized" }),
        write: async () => ({ status: "written" }),
      },
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(scope, { name: "Governed hybrid" });
    await platform.upsertPolicy(scope, {
      processingConfig: { memoryRetrieval: { strategy: "hybrid-rerank-v1" } },
    });

    const result = await platform.search(scope, {
      memorySpaceIds: [space.data.id],
      query: "api_key=secret-value-123456789",
    });

    expect(result.attempt.data.strategy).toBe("dense-v1");
    expect(denseQueries).toBe(1);
    expect(lexicalQueries).toBe(0);
  });

  it("does not hide a reranker usage durability failure", async () => {
    const { database, put } = memoryDatabase();
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const failure = new MemoryRerankUsagePersistenceError(new Error("usage unavailable"));
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      rerank: async () => Promise.reject(failure),
      searchProvider: {
        ...fakeMemorySearchProvider().provider,
        delete: async () => ({ status: "synchronized" }),
        readiness: async () => ({
          denseReady: true,
          lexicalReady: true,
          reference: "test",
          ready: true,
          schemaReady: true,
        }),
        query: async () => rows,
        queryExact: async () => [],
        queryLexical: async () => rows,
        synchronizeLifecycle: async () => ({ status: "synchronized" }),
        write: async () => ({ status: "written" }),
      },
    });
    const space = await platform.createMemorySpace(scope, { name: "Rerank durability" });
    const memories = [
      memoryFixture({
        id: indexedUlid(13_450),
        memorySpaceId: space.data.id,
        scope: "organization",
        searchKey: `organization:${ids.organization}`,
        workspaceId: undefined,
      }),
      memoryFixture({
        id: indexedUlid(13_451),
        memorySpaceId: space.data.id,
        scope: "organization",
        searchKey: `organization:${ids.organization}`,
        workspaceId: undefined,
      }),
    ];
    for (const memory of memories) put("control", memory);
    const rows = memories.map((memory, index) => ({
      contentHash: memory.data.contentHash,
      dist: 0.1 + index / 10,
      id: memory.data.id,
      memorySpaceId: memory.data.memorySpaceId,
      memoryVersion: memory.data.version,
      scopeKey: `organization:${ids.organization}`,
      searchKey: memory.data.searchKey,
    }));
    await platform.upsertPolicy(scope, {
      processingConfig: { memoryRetrieval: { strategy: "hybrid-rerank-v1" } },
    });

    expect(
      platform.search(scope, {
        memorySpaceIds: [space.data.id],
        query: "production change window",
      }),
    ).rejects.toBe(failure);
  });
});
