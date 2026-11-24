import type {
  DynamoDatabaseService,
  PlatformRecord,
  QueryRecordsResult,
  TransactionOperation,
  Ulid,
} from "@deployments-ai/db";
import { withCanonicalRecordKeys } from "@deployments-ai/db";
import { describe, expect, it } from "bun:test";
import { makeMemoryPlatform, type MemoryPlatformScope } from "./platform.ts";
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

async function grantedFlushRun(
  platform: ReturnType<typeof makeMemoryPlatform>,
  put: ReturnType<typeof memoryDatabase>["put"],
  scope: MemoryPlatformScope,
  memorySpaceId: Ulid,
  runId: Ulid = ids.run,
) {
  const deploymentId = indexedUlid(12_000);
  put(
    "control",
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId: ids.agent,
        agentReleaseId: ids.memory2,
        createdAt: fixedNow.toISOString(),
        currentState: "ready" as const,
        desiredState: "running" as const,
        environmentId: scope.environmentId,
        id: deploymentId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        updatedAt: fixedNow.toISOString(),
        version: 0,
      },
      itemType: "agent-deployment" as const,
    }) as PlatformRecord,
  );
  await platform.grantMemorySpace(scope, {
    agentDefinitionId: ids.agent,
    memorySpaceId,
    permission: "read-write",
  });
  const run = withCanonicalRecordKeys({
    data: {
      agentDeploymentId: deploymentId,
      agentReleaseId: ids.memory2,
      attempt: 0,
      captureMode: "metadata-only" as const,
      createdAt: fixedNow.toISOString(),
      environmentId: scope.environmentId,
      executor: "test",
      id: runId,
      idempotencyKey: `run:${runId}`,
      organizationId: scope.organizationId,
      priority: 0,
      projectId: scope.projectId,
      redactionPolicyVersion: 1 as const,
      schemaVersion: 1 as const,
      spanId: "0123456789abcdef" as const,
      status: "completed" as const,
      threadId: ids.thread,
      traceId: "0123456789abcdef0123456789abcdef" as const,
      trigger: "test",
      updatedAt: fixedNow.toISOString(),
      version: 0,
      ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
    },
    itemType: "run" as const,
  }) as Extract<PlatformRecord, { readonly itemType: "run" }>;
  put("execution", run);
  return run;
}

describe("memory platform", () => {
  it("routes mixed-scope flush candidates to compatible granted spaces", async () => {
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
      name: "Organization candidate destination",
    });
    const predecessorSpace = await platform.createMemorySpace(tenantScope, {
      name: "Organization predecessor source",
    });
    const workspaceSpace = await platform.createMemorySpace(workspaceScope, {
      name: "Workspace candidate destination",
    });
    const run = await grantedFlushRun(platform, put, workspaceScope, organizationSpace.data.id);
    await platform.grantMemorySpace(workspaceScope, {
      agentDefinitionId: ids.agent,
      memorySpaceId: predecessorSpace.data.id,
      permission: "read-write",
    });
    await platform.grantMemorySpace(workspaceScope, {
      agentDefinitionId: ids.agent,
      memorySpaceId: workspaceSpace.data.id,
      permission: "read-write",
    });
    const predecessor = await platform.importMemories(tenantScope, {
      items: [
        {
          content: "Organization-wide deployment standard v1.",
          scope: "organization",
          source: "tool",
        },
      ],
      memorySpaceId: predecessorSpace.data.id,
    });
    const predecessorReview = (
      await platform.listReviewItems(tenantScope, { status: "open" })
    ).find((item) => item.data.memoryId === predecessor.imported[0]!.data.id);
    await platform.resolveReview(tenantScope, {
      decision: "approve",
      memoryId: predecessor.imported[0]!.data.id,
      reviewId: predecessorReview!.data.id,
    });

    const result = await platform.importFlushCandidates(workspaceScope, {
      candidates: [
        {
          content: "Organization-wide deployment standard v2.",
          scope: "organization",
          supersedesMemoryId: predecessor.imported[0]!.data.id,
        },
        { content: "Continue this thread next Tuesday.", scope: "thread" },
      ],
      flushId: indexedUlid(15_002),
      memoryMode: "organization",
      memorySpaceId: organizationSpace.data.id,
      run,
    });

    expect(result.rejected).toEqual([]);
    expect(result.imported.map((memory) => memory.data.memorySpaceId)).toEqual(
      expect.arrayContaining([organizationSpace.data.id, workspaceSpace.data.id]),
    );
    const successor = result.imported.find(
      (memory) => memory.data.supersedesMemoryId === predecessor.imported[0]!.data.id,
    );
    expect(successor).toMatchObject({
      data: {
        memorySpaceId: organizationSpace.data.id,
        reviewStatus: "pending",
        supersedesMemoryId: predecessor.imported[0]!.data.id,
      },
    });
    const review = (await platform.listReviewItems(workspaceScope, { status: "open" })).find(
      (item) => item.data.memoryId === successor?.data.id,
    );
    await platform.resolveReview(workspaceScope, {
      decision: "approve",
      memoryId: successor!.data.id,
      reviewId: review!.data.id,
    });
    expect(
      platform.requiredMemory(tenantScope, predecessor.imported[0]!.data.id),
    ).resolves.toMatchObject({
      data: {
        status: "archived",
        supersededByMemoryId: successor?.data.id,
      },
    });
  });

  it("revalidates the primary flush grant before importing candidates", async () => {
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
    const space = await platform.createMemorySpace(scope, { name: "Revoked flush grant" });
    const run = await grantedFlushRun(platform, put, scope, space.data.id);
    const grant = (
      await platform.listMemorySpaceGrants(scope, { agentDefinitionId: ids.agent })
    )[0]!;
    await platform.revokeMemorySpaceGrant(scope, grant.data.id);

    expect(
      platform.importFlushCandidates(scope, {
        candidates: [{ content: "Do not write after revocation.", scope: "thread" }],
        flushId: indexedUlid(15_003),
        memoryMode: "workspace",
        memorySpaceId: space.data.id,
        run,
      }),
    ).rejects.toMatchObject({ code: "memory_space_write_forbidden", statusCode: 403 });
  });
});
