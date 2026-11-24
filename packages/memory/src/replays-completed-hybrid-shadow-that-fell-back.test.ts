import type {
  DynamoDatabaseService,
  PlatformRecord,
  QueryRecordsResult,
  TransactionOperation,
  Ulid,
} from "@deployments-ai/db";
import { withCanonicalRecordKeys } from "@deployments-ai/db";
import { describe, expect, it } from "bun:test";
import { makeMemoryPlatform } from "./platform.ts";
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
  it("retries a failed hybrid shadow without falling back to dense", async () => {
    const { database, tables } = memoryDatabase();
    let embeddingCalls = 0;
    let lexicalQueries = 0;
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
          lexicalReady: false,
          reference: "test",
          ready: false,
          schemaReady: true,
        }),
        query: async () => [],
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
    const space = await platform.createMemorySpace(scope, { name: "Dense fallback shadow" });
    const input = {
      memorySpaceIds: [space.data.id],
      query: "deployment marker",
      shadow: true,
      shadowAttemptId: indexedUlid(13_520),
      shadowOfAttemptId: indexedUlid(13_521),
      strategyOverride: "hybrid-rrf-v1",
    } as const;

    expect(platform.search(scope, input)).rejects.toMatchObject({
      _tag: "MemoryIndexingError",
    });
    expect(platform.search(scope, input)).rejects.toMatchObject({
      _tag: "MemoryIndexingError",
    });
    const attempt = [...(tables.get("execution")?.values() ?? [])].find(
      (record) =>
        record.itemType === "memory-recall-attempt" && record.data.id === input.shadowAttemptId,
    );
    expect(attempt?.data).toMatchObject({
      requestedStrategy: "hybrid-rrf-v1",
      status: "failed",
      strategy: "hybrid-rrf-v1",
      version: 3,
    });
    expect(embeddingCalls).toBe(2);
    expect(lexicalQueries).toBe(2);
  });

  it("preserves shadow attribution when a queued search fails", async () => {
    const { database, tables } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => {
        throw new Error("embedding unavailable");
      },
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(scope, { name: "Failed shadow" });
    const shadowAttemptId = indexedUlid(13_510);
    const shadowOfAttemptId = indexedUlid(13_511);

    expect(
      platform.search(scope, {
        memorySpaceIds: [space.data.id],
        query: "deployment marker",
        shadow: true,
        shadowAttemptId,
        shadowOfAttemptId,
        strategyOverride: "dense-v1",
      }),
    ).rejects.toThrow("embedding unavailable");

    const failed = [...(tables.get("execution")?.values() ?? [])].find(
      (record) => record.itemType === "memory-recall-attempt" && record.data.id === shadowAttemptId,
    );
    expect(failed).toMatchObject({
      data: {
        shadow: true,
        shadowOfAttemptId,
        status: "failed",
      },
    });
  });

  it("bounds usefulness aggregation reads", async () => {
    const fixture = memoryDatabase();
    const originalQuery = fixture.database.queryRecords;
    const metrics = { active: 0, maximum: 0, reads: 0 };
    const database: DynamoDatabaseService = {
      ...fixture.database,
      queryRecords: (tableName, input, signal) => {
        const values = input.ExpressionAttributeValues as Record<string, unknown> | undefined;
        const usefulnessLookup =
          tableName === "execution" &&
          typeof values?.[":prefix"] === "string" &&
          String(values[":prefix"]).startsWith("MEMORY-RETRIEVAL#");
        if (!usefulnessLookup) return originalQuery(tableName, input, signal);
        return (async () => {
          metrics.active += 1;
          metrics.maximum = Math.max(metrics.maximum, metrics.active);
          metrics.reads += 1;
          try {
            await Bun.sleep(5);
            return await originalQuery(tableName, input, signal);
          } finally {
            metrics.active -= 1;
          }
        })();
      },
    };
    const rows: Record<string, unknown>[] = [];
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
        query: async () => rows as never,
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
    const space = await platform.createMemorySpace(scope, { name: "Usefulness aggregation" });
    for (let index = 0; index < 20; index += 1) {
      const memory = memoryFixture({
        id: indexedUlid(13_600 + index),
        memorySpaceId: space.data.id,
        scope: "organization",
        searchKey: `organization:${ids.organization}`,
        workspaceId: undefined,
      });
      fixture.put("control", memory);
      rows.push({
        contentHash: memory.data.contentHash,
        dist: index / 100,
        id: memory.data.id,
        memorySpaceId: memory.data.memorySpaceId,
        memoryVersion: memory.data.version,
        scopeKey: `organization:${ids.organization}`,
        searchKey: memory.data.searchKey,
      });
    }

    await platform.search(scope, {
      memorySpaceIds: [space.data.id],
      query: "deployment marker",
      topK: 10,
    });

    expect(metrics.reads).toBe(0);
    await platform.upsertPolicy(scope, {
      processingConfig: {
        memoryRetrieval: { rolloutPercent: 100, strategy: "hybrid-rrf-v1" },
      },
    });
    await platform.search(scope, {
      memorySpaceIds: [space.data.id],
      query: "deployment marker",
      strategyOverride: "hybrid-rrf-v1",
      topK: 10,
    });

    expect(metrics.reads).toBe(20);
    expect(metrics.maximum).toBeGreaterThan(1);
    expect(metrics.maximum).toBeLessThanOrEqual(8);
  });

  it("persists failed recall attempts for quality reporting", async () => {
    const { database } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => {
        throw new Error("embedding unavailable");
      },
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const space = await platform.createMemorySpace(scope, { name: "Failed recall" });

    expect(
      platform.search(scope, {
        memorySpaceIds: [space.data.id],
        query: "deployment context",
      }),
    ).rejects.toThrow("embedding unavailable");
    expect(platform.quality(scope)).resolves.toMatchObject({ attempts: 1, failed: 1 });
  });

  it("classifies shadow retrievals without depending on the attempt sample", async () => {
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
    put(
      "execution",
      withCanonicalRecordKeys({
        data: {
          candidateCount: 0,
          createdAt: new Date(fixedNow.getTime() + 1).toISOString(),
          environmentId: ids.environment,
          id: indexedUlid(13_699),
          injectedCount: 0,
          organizationId: ids.organization,
          projectId: ids.project,
          purpose: "search",
          retrievedCount: 0,
          shadow: true,
          status: "completed" as const,
          strategy: "hybrid-rrf-v1" as const,
          version: 0,
        },
        itemType: "memory-recall-attempt" as const,
      }) as PlatformRecord,
    );
    put(
      "execution",
      withCanonicalRecordKeys({
        data: {
          candidateCount: 0,
          createdAt: fixedNow.toISOString(),
          environmentId: ids.environment,
          id: indexedUlid(13_700),
          injectedCount: 0,
          organizationId: ids.organization,
          projectId: ids.project,
          purpose: "search",
          retrievedCount: 0,
          status: "completed" as const,
          strategy: "dense-v1" as const,
          version: 0,
        },
        itemType: "memory-recall-attempt" as const,
      }) as PlatformRecord,
    );
    put(
      "execution",
      withCanonicalRecordKeys({
        data: {
          createdAt: fixedNow.toISOString(),
          environmentId: ids.environment,
          id: indexedUlid(13_701),
          injected: false,
          memoryId: ids.memory,
          organizationId: ids.organization,
          projectId: ids.project,
          provider: "aws-native" as const,
          purpose: "search",
          rank: 1,
          recallAttemptId: indexedUlid(13_702),
          reviewStatus: "approved",
          score: 0.9,
          searchKey: `organization:${ids.organization}`,
          sensitivity: "internal",
          shadow: true,
          version: 0,
        },
        itemType: "memory-retrieval" as const,
      }) as PlatformRecord,
    );

    expect(platform.quality(scope, { limit: 1 })).resolves.toMatchObject({
      attempts: 1,
      retrievals: 0,
      shadow: { attempts: 1, retrievals: 1 },
    });
  });

  it("rejects invalid memory quality timestamps", async () => {
    const { database } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });

    expect(
      platform.quality(
        {
          environmentId: ids.environment,
          organizationId: ids.organization,
          projectId: ids.project,
        },
        { since: "not-a-timestamp" },
      ),
    ).rejects.toMatchObject({ code: "invalid_since", statusCode: 400 });
  });

  it("does not let delayed feedback retries overwrite newer feedback", async () => {
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
    const retrievalId = indexedUlid(12_500);
    put(
      "execution",
      withCanonicalRecordKeys({
        data: {
          createdAt: fixedNow.toISOString(),
          environmentId: ids.environment,
          id: retrievalId,
          injected: false,
          memoryId: ids.memory,
          organizationId: ids.organization,
          projectId: ids.project,
          provider: "aws-native" as const,
          purpose: "search",
          rank: 1,
          recallAttemptId: ids.memory2,
          reviewStatus: "approved",
          score: 0.9,
          searchKey: `workspace:${ids.workspace}`,
          sensitivity: "internal",
          version: 0,
          workspaceId: ids.workspace,
        },
        itemType: "memory-retrieval" as const,
      }) as PlatformRecord,
    );

    await platform.recordRetrievalFeedback(
      scope,
      retrievalId,
      ids.memory,
      "useful",
      "Original feedback",
      { idempotencyKey: "feedback-original" },
    );
    const newer = await platform.recordRetrievalFeedback(
      scope,
      retrievalId,
      ids.memory,
      "harmful",
      "Newer feedback",
      { idempotencyKey: "feedback-newer" },
    );
    const replayed = await platform.recordRetrievalFeedback(
      scope,
      retrievalId,
      ids.memory,
      "useful",
      "Original feedback",
      { idempotencyKey: "feedback-original" },
    );

    expect(replayed.data.usefulness).toBe(newer.data.usefulness);
    expect(replayed.data.feedback).toBe("Newer feedback");
  });

  it("keeps recall quality telemetry within the originating workspace", async () => {
    const { database } = memoryDatabase();
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
    const firstScope = { ...tenantScope, workspaceId: ids.workspace };
    const secondScope = { ...tenantScope, workspaceId: indexedUlid(13_300) };
    const firstSpace = await platform.createMemorySpace(firstScope, { name: "First telemetry" });
    const secondSpace = await platform.createMemorySpace(secondScope, { name: "Second telemetry" });
    const tenantSpace = await platform.createMemorySpace(tenantScope, { name: "Tenant telemetry" });

    await platform.search(firstScope, {
      memorySpaceIds: [firstSpace.data.id],
      query: "first workspace",
    });
    await platform.search(secondScope, {
      memorySpaceIds: [secondSpace.data.id],
      query: "second workspace",
    });
    await platform.search(tenantScope, {
      memorySpaceIds: [tenantSpace.data.id],
      query: "environment telemetry",
    });

    expect(platform.quality(firstScope)).resolves.toMatchObject({ attempts: 1 });
    expect(platform.quality(secondScope)).resolves.toMatchObject({ attempts: 1 });
    expect(platform.quality(tenantScope)).resolves.toMatchObject({ attempts: 3 });
  });
});
