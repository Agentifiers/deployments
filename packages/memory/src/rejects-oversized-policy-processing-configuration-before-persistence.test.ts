import type {
  DynamoDatabaseService,
  PlatformRecord,
  QueryRecordsResult,
  TransactionOperation,
  Ulid,
} from "@deployments-ai/db";
import {
  makeUniqueClaimRecord,
  uniqueClaimRequirements,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { describe, expect, it } from "bun:test";
import { makeMemoryPlatform } from "./platform.ts";
import { ids, optionalExpressionString } from "./test-fixtures.ts";
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
  it("rejects oversized policy processing configuration before persistence", async () => {
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

    expect(
      platform.upsertPolicy(scope, {
        processingConfig: { payload: "x".repeat(70_000) },
        scope: "environment",
      }),
    ).rejects.toMatchObject({ code: "invalid_processing_config", statusCode: 400 });
  });

  it("returns not found for an explicit missing policy id", async () => {
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
    await platform.upsertPolicy(scope, { scope: "environment" });

    expect(
      platform.upsertPolicy(scope, {
        id: indexedUlid(13_050),
        retentionDays: 30,
        scope: "environment",
      }),
    ).rejects.toMatchObject({ code: "memory_policy_not_found", statusCode: 404 });
  });

  it("returns and idempotently records the winner of a concurrent policy claim", async () => {
    const state = memoryDatabase();
    const winnerId = indexedUlid(13_051);
    let injectWinner = true;
    const database: DynamoDatabaseService = {
      ...state.database,
      transactWrite: (operations, clientRequestToken) => {
        const candidate = operations.find(
          (operation) => operation.kind === "put" && operation.record.itemType === "memory-policy",
        );
        if (injectWinner && candidate?.kind === "put") {
          injectWinner = false;
          const winner = withCanonicalRecordKeys({
            ...candidate.record,
            data: { ...candidate.record.data, id: winnerId },
          }) as Extract<PlatformRecord, { readonly itemType: "memory-policy" }>;
          const [requirement] = uniqueClaimRequirements(winner);
          if (!requirement) throw new Error("Expected a memory policy unique claim.");
          state.put("control", winner);
          state.put(
            "control",
            makeUniqueClaimRecord(requirement, winner.data.createdAt) as PlatformRecord,
          );
          return Promise.reject(new Error("concurrent policy claim"));
        }
        return state.database.transactWrite(operations, clientRequestToken);
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

    const created = await platform.upsertPolicy(scope, {
      idempotencyKey: "concurrent-policy",
      scope: "environment",
      sensitivityMode: "strict",
    });
    const replayed = await platform.upsertPolicy(scope, {
      idempotencyKey: "concurrent-policy",
      scope: "environment",
      sensitivityMode: "strict",
    });

    expect(created.data.id).toBe(winnerId);
    expect(replayed.data.id).toBe(winnerId);
    expect(created.data).toMatchObject({ sensitivityMode: "strict", version: 1 });
  });

  it("reuses the latest policy for a scope when upsert omits an id", async () => {
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
    const policyRecord = (id: Ulid, updatedAt: string) =>
      withCanonicalRecordKeys({
        data: {
          activeRecallEnabled: true,
          activeRecallRolloutPercent: 100,
          createdAt: "2026-07-20T00:00:00.000Z",
          environmentId: ids.environment,
          id,
          organizationId: ids.organization,
          projectId: ids.project,
          scope: "environment" as const,
          sensitivityMode: "standard" as const,
          updatedAt,
          version: 0,
        },
        itemType: "memory-policy" as const,
      }) as Extract<PlatformRecord, { readonly itemType: "memory-policy" }>;
    const stale = policyRecord(indexedUlid(13_025), "2026-07-20T00:00:00.000Z");
    const recent = policyRecord(indexedUlid(13_026), "2026-07-21T00:00:00.000Z");
    put("control", stale);
    put("control", recent);
    const latest = await platform.upsertPolicy(scope, { activeRecallEnabled: false });
    const updated = await platform.upsertPolicy(scope, { sensitivityMode: "strict" });

    expect(latest.data.id).toBe(recent.data.id);
    expect(updated.data.id).toBe(latest.data.id);
    expect(updated.data.version).toBe(latest.data.version + 1);
    expect(platform.effectivePolicy(scope)).resolves.toMatchObject({
      data: { activeRecallEnabled: false, id: latest.data.id, sensitivityMode: "strict" },
    });
    expect(
      platform.upsertPolicy(scope, {
        id: updated.data.id,
        scope: "workspace",
        workspaceId: ids.workspace,
      }),
    ).rejects.toMatchObject({ code: "memory_policy_scope_immutable", statusCode: 409 });
  });

  it("rejects create-only policy writes without changing the existing policy", async () => {
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
    const existing = await platform.upsertPolicy(scope, {
      activeRecallEnabled: false,
      retentionDays: 90,
      sensitivityMode: "strict",
    });

    expect(
      platform.upsertPolicy(scope, {
        activeRecallEnabled: true,
        createOnly: true,
        retentionDays: 1,
        sensitivityMode: "standard",
      }),
    ).rejects.toMatchObject({ code: "memory_policy_exists", statusCode: 409 });
    expect(platform.effectivePolicy(scope)).resolves.toMatchObject({
      data: {
        activeRecallEnabled: false,
        id: existing.data.id,
        retentionDays: 90,
        sensitivityMode: "strict",
        version: existing.data.version,
      },
    });
  });

  it("replays a completed create-only policy write", async () => {
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
    const input = {
      activeRecallEnabled: true,
      createOnly: true,
      idempotencyKey: "create-only-policy",
      retentionDays: 30,
      scope: "environment" as const,
    };

    const created = await platform.upsertPolicy(scope, input);
    const replayed = await platform.upsertPolicy(scope, input);

    expect(replayed.data.id).toBe(created.data.id);
    expect(replayed.data.version).toBe(created.data.version);
  });

  it("does not bind environment policies to the caller workspace", async () => {
    const { database } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const workspaceScope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
      workspaceId: ids.workspace,
    };
    const policy = await platform.upsertPolicy(workspaceScope, {
      retentionDays: 30,
      scope: "environment",
      sensitivityMode: "strict",
    });

    expect(policy.data.workspaceId).toBeUndefined();
    expect(
      platform.effectivePolicy({ ...workspaceScope, workspaceId: indexedUlid(13_050) }),
    ).resolves.toMatchObject({ data: { id: policy.data.id, sensitivityMode: "strict" } });
  });

  it("keeps organization imports outside the caller workspace policy", async () => {
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
    const { workspaceId: _workspaceId, ...tenantScope } = scope;
    const space = await platform.createMemorySpace(tenantScope, { name: "Organization policy" });
    await platform.upsertPolicy(scope, { retentionDays: 30, scope: "environment" });
    await platform.upsertPolicy(scope, { retentionDays: 1, scope: "workspace" });

    const imported = await platform.importMemories(scope, {
      items: [{ content: "Organization-wide durable fact.", scope: "organization" }],
      memorySpaceId: space.data.id,
    });

    expect(imported.imported[0]?.data.workspaceId).toBeUndefined();
    expect(imported.imported[0]?.data.retentionExpiresAt).toBe("2026-08-20T18:00:00.000Z");
    const [review] = await platform.listReviewItems(scope, { status: "open" });
    expect(review?.data.workspaceId).toBeUndefined();
    expect(
      platform.resolveReview(scope, {
        decision: "approve",
        memoryId: imported.imported[0]!.data.id,
        reviewId: review!.data.id,
      }),
    ).resolves.toMatchObject({ memory: { data: { reviewStatus: "approved" } } });
  });

  it("persists typed fields and atomically supersedes an approved memory", async () => {
    const { database, transactions } = memoryDatabase();
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
      name: "Typed supersession",
    });
    const first = await platform.importMemories(scope, {
      items: [
        {
          content: "Production deploys run on Monday.",
          entityKeys: ["Deployment:Production"],
          importance: 0.8,
          memoryType: "procedure",
          scope: "thread",
          source: "tool",
          sourceQuality: 0.9,
          threadId: ids.thread,
          validFrom: "2026-07-01T00:00:00Z",
          workspaceId: ids.workspace,
        },
      ],
      memorySpaceId: space.data.id,
    });
    const predecessor = first.imported[0]!;
    expect(predecessor.data).toMatchObject({
      entityKeys: ["deployment:production"],
      importance: 0.8,
      memoryType: "procedure",
      reviewStatus: "approved",
      sourceQuality: 0.9,
      validFrom: "2026-07-01T00:00:00.000Z",
    });

    const second = await platform.importMemories(scope, {
      items: [
        {
          content: "Production deploys run on Tuesday.",
          memoryType: "procedure",
          scope: "thread",
          source: "tool",
          supersedesMemoryId: predecessor.data.id,
          threadId: ids.thread,
          workspaceId: ids.workspace,
        },
      ],
      memorySpaceId: space.data.id,
    });
    const current = second.imported[0]!;
    expect(current.data.supersedesMemoryId).toBe(predecessor.data.id);
    expect(platform.requiredMemory(scope, predecessor.data.id)).resolves.toMatchObject({
      data: { status: "archived", supersededByMemoryId: current.data.id },
    });
    expect(platform.restoreMemory(scope, predecessor.data.id)).rejects.toMatchObject({
      code: "memory_superseded",
      statusCode: 409,
    });

    await platform.archiveMemory(scope, current.data.id);
    expect(platform.restoreMemory(scope, current.data.id)).resolves.toMatchObject({
      data: { status: "active", supersedesMemoryId: predecessor.data.id },
    });
    expect(transactions.at(-1)).toContainEqual(
      expect.objectContaining({
        expressionAttributeValues: expect.objectContaining({
          ":itemType": "memory",
          ":version": expect.any(Number),
        }),
        key: { pk: predecessor.pk, sk: predecessor.sk },
        kind: "condition-check",
        table: "control",
      }),
    );
    await platform.archiveMemory(scope, current.data.id);
    const restoredPredecessor = await platform.restoreMemory(scope, predecessor.data.id);
    expect(restoredPredecessor.data.status).toBe("active");
    expect(restoredPredecessor.data.supersededByMemoryId).toBeUndefined();
    expect(platform.restoreMemory(scope, current.data.id)).resolves.toMatchObject({
      data: { status: "active", supersedesMemoryId: predecessor.data.id },
    });
    expect(platform.requiredMemory(scope, predecessor.data.id)).resolves.toMatchObject({
      data: { status: "archived", supersededByMemoryId: current.data.id },
    });
  });

  it("does not archive a predecessor for a future-valid direct supersession", async () => {
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
      name: "Future supersession",
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

    const result = await platform.importMemories(scope, {
      items: [
        {
          content: "Production deploys run on Tuesday next month.",
          scope: "thread",
          source: "tool",
          supersedesMemoryId: predecessor.data.id,
          threadId: ids.thread,
          validFrom: "2026-08-01T00:00:00.000Z",
          workspaceId: ids.workspace,
        },
      ],
      memorySpaceId: space.data.id,
    });
    expect(result.imported).toEqual([]);
    expect(result.rejected).toEqual([
      {
        index: 0,
        reason: "A superseding memory must be active and currently valid before approval.",
      },
    ]);
    expect(platform.requiredMemory(scope, predecessor.data.id)).resolves.toMatchObject({
      data: { status: "active" },
    });
  });

  it("rejects successor restoration after its predecessor was permanently deleted", async () => {
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
      name: "Deleted supersession predecessor",
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
          source: "tool",
          supersedesMemoryId: predecessor.data.id,
          threadId: ids.thread,
          workspaceId: ids.workspace,
        },
      ],
      memorySpaceId: space.data.id,
    });
    const successor = second.imported[0]!;

    await platform.deleteMemory(scope, predecessor.data.id);
    await platform.archiveMemory(scope, successor.data.id);

    expect(platform.restoreMemory(scope, successor.data.id)).rejects.toMatchObject({
      code: "supersession_predecessor_deleted",
      statusCode: 409,
    });
  });
});
