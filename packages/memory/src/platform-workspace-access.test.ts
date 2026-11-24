import { describe, expect, it } from "bun:test";
import type {
  DynamoDatabaseService,
  PlatformRecord,
  QueryRecordsResult,
  TransactionOperation,
  Ulid,
} from "@deployments-ai/db";
import { withCanonicalRecordKeys } from "@deployments-ai/db";
import { ids, optionalExpressionString } from "./test-fixtures.ts";
import { makeMemoryPlatform, type MemoryPlatformScope } from "./platform.ts";
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

const grantedFlushDeploymentId = indexedUlid(12_000);

async function grantedFlushRun(
  platform: ReturnType<typeof makeMemoryPlatform>,
  put: ReturnType<typeof memoryDatabase>["put"],
  scope: MemoryPlatformScope,
  memorySpaceId: Ulid,
  runId: Ulid = ids.run,
) {
  const deploymentId = grantedFlushDeploymentId;
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
      createdAt: fixedNow.toISOString(),
      environmentId: scope.environmentId,
      executor: "test",
      id: runId,
      idempotencyKey: `run:${runId}`,
      organizationId: scope.organizationId,
      priority: 0,
      projectId: scope.projectId,
      status: "completed" as const,
      threadId: ids.thread,
      trigger: "test",
      updatedAt: fixedNow.toISOString(),
      version: 0,
      ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
    },
    itemType: "run" as const,
  }) as Extract<PlatformRecord, { readonly itemType: "run" }>;
  put("execution", run);
  put(
    "control",
    withCanonicalRecordKeys({
      data: {
        createdAt: fixedNow.toISOString(),
        environmentId: scope.environmentId,
        id: runId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        runPk: run.pk,
        runSk: run.sk,
        ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
      },
      itemType: "run-locator" as const,
    }) as PlatformRecord,
  );
  return run;
}

describe("memory platform", () => {
  it("keeps review listings within the authenticated workspace", async () => {
    const { database } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const firstScope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
      workspaceId: ids.workspace,
    };
    const secondScope = { ...firstScope, workspaceId: indexedUlid(13_075) };
    const firstSpace = await platform.createMemorySpace(firstScope, { name: "First reviews" });
    const secondSpace = await platform.createMemorySpace(secondScope, { name: "Second reviews" });
    await platform.importMemories(firstScope, {
      items: [{ content: "First workspace guidance.", scope: "workspace" }],
      memorySpaceId: firstSpace.data.id,
    });
    await platform.importMemories(secondScope, {
      items: [{ content: "Second workspace guidance.", scope: "workspace" }],
      memorySpaceId: secondSpace.data.id,
    });

    const firstReviews = await platform.listReviewItems(firstScope, { status: "open" });
    const secondReviews = await platform.listReviewItemsPage(secondScope, { status: "open" });

    expect(firstReviews).toHaveLength(1);
    expect(firstReviews[0]?.data.workspaceId).toBe(firstScope.workspaceId);
    expect(secondReviews.items).toHaveLength(1);
    expect(secondReviews.items[0]?.data.workspaceId).toBe(secondScope.workspaceId);
  });

  it("rejects workspace mutation inputs that conflict with the authenticated workspace", async () => {
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
    const otherWorkspaceId = indexedUlid(13_100);

    expect(
      platform.createMemorySpace(scope, {
        name: "Wrong workspace",
        workspaceId: otherWorkspaceId,
      }),
    ).rejects.toMatchObject({ code: "workspace_scope_conflict", statusCode: 403 });
    expect(
      platform.upsertPolicy(scope, {
        scope: "workspace",
        workspaceId: otherWorkspaceId,
      }),
    ).rejects.toMatchObject({ code: "workspace_scope_conflict", statusCode: 403 });
    const space = await platform.createMemorySpace(scope, { name: "Owned workspace" });
    const imported = await platform.importMemories(scope, {
      items: [
        {
          content: "Cross-workspace import.",
          scope: "workspace",
          workspaceId: otherWorkspaceId,
        },
      ],
      memorySpaceId: space.data.id,
    });
    expect(imported.rejected[0]?.reason).toContain("authenticated workspace");
  });

  it("requires workspace identity to match the memory-space kind", async () => {
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

    expect(
      platform.createMemorySpace(tenantScope, { kind: "workspace", name: "Missing workspace" }),
    ).rejects.toMatchObject({ code: "workspace_required", statusCode: 400 });
    expect(
      platform.createMemorySpace(
        { ...tenantScope, workspaceId: ids.workspace },
        { kind: "organization", name: "Mismatched organization" },
      ),
    ).rejects.toMatchObject({ code: "invalid_scope", statusCode: 400 });
  });

  it("replays idempotent space, policy, and grant mutations", async () => {
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
    const firstSpace = await platform.createMemorySpace(scope, {
      idempotencyKey: "space-idempotency",
      name: "Idempotent space",
    });
    const replayedSpace = await platform.createMemorySpace(scope, {
      idempotencyKey: "space-idempotency",
      name: "Idempotent space",
    });
    expect(replayedSpace.data.id).toBe(firstSpace.data.id);
    const otherWorkspaceSpace = await platform.createMemorySpace(
      { ...scope, workspaceId: indexedUlid(13_100) },
      { idempotencyKey: "space-idempotency", name: "Idempotent space" },
    );
    expect(otherWorkspaceSpace.data.id).not.toBe(firstSpace.data.id);
    expect(
      platform.createMemorySpace(scope, {
        idempotencyKey: "space-idempotency",
        name: "Different space",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const archivedSpace = await platform.archiveMemorySpace(scope, firstSpace.data.id, {
      idempotencyKey: "space-archive-idempotency",
    });
    const replayedArchive = await platform.archiveMemorySpace(scope, firstSpace.data.id, {
      idempotencyKey: "space-archive-idempotency",
    });
    expect(replayedArchive.data).toMatchObject({
      id: archivedSpace.data.id,
      status: "archived",
      version: archivedSpace.data.version,
    });
    const secondSpace = await platform.createMemorySpace(scope, { name: "Second space" });
    expect(
      platform.archiveMemorySpace(scope, secondSpace.data.id, {
        idempotencyKey: "space-archive-idempotency",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const grantSpace = await platform.createMemorySpace(scope, { name: "Grant replay space" });

    const firstPolicy = await platform.upsertPolicy(scope, {
      activeRecallEnabled: true,
      idempotencyKey: "policy-idempotency",
    });
    const replayedPolicy = await platform.upsertPolicy(scope, {
      activeRecallEnabled: true,
      idempotencyKey: "policy-idempotency",
    });
    expect(replayedPolicy.data.id).toBe(firstPolicy.data.id);
    expect(replayedPolicy.data.version).toBe(firstPolicy.data.version);

    const firstGrant = await platform.grantMemorySpace(scope, {
      agentDefinitionId: ids.agent,
      idempotencyKey: "grant-idempotency",
      memorySpaceId: grantSpace.data.id,
      permission: "read-write",
    });
    const grantTransaction = transactions.find((operations) =>
      operations.some(
        (operation) =>
          operation.kind !== "condition-check" &&
          operation.record.itemType === "memory-space-grant",
      ),
    );
    expect(
      grantTransaction?.some(
        (operation) =>
          operation.kind !== "condition-check" && operation.record.itemType === "unique-claim",
      ),
    ).toBe(true);
    const replayedGrant = await platform.grantMemorySpace(scope, {
      agentDefinitionId: ids.agent,
      idempotencyKey: "grant-idempotency",
      memorySpaceId: grantSpace.data.id,
      permission: "read-write",
    });
    expect(replayedGrant.data.id).toBe(firstGrant.data.id);
    const changedGrant = await platform.updateMemorySpaceGrant(scope, firstGrant.data.id, {
      idempotencyKey: "grant-changed-after-create",
      permission: "read",
    });
    const delayedCreateRetry = await platform.grantMemorySpace(scope, {
      agentDefinitionId: ids.agent,
      idempotencyKey: "grant-idempotency",
      memorySpaceId: grantSpace.data.id,
      permission: "read-write",
    });
    expect(delayedCreateRetry.data.permission).toBe(changedGrant.data.permission);
    expect(
      platform.grantMemorySpace(scope, {
        agentDefinitionId: ids.agent,
        idempotencyKey: "grant-idempotency",
        memorySpaceId: grantSpace.data.id,
        permission: "read",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("allows expired idempotency keys to be replaced atomically", async () => {
    const { database, transactions } = memoryDatabase();
    let currentTime = fixedNow;
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => currentTime,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
    };
    const first = await platform.createMemorySpace(scope, {
      idempotencyKey: "expiring-space-request",
      name: "First space",
    });
    currentTime = new Date(fixedNow.getTime() + 25 * 60 * 60_000);

    const replacement = await platform.createMemorySpace(scope, {
      idempotencyKey: "expiring-space-request",
      name: "Replacement space",
    });

    expect(replacement.data.id).not.toBe(first.data.id);
    const idempotencyPut = transactions
      .at(-1)
      ?.find(
        (operation) => operation.kind === "put" && operation.record.itemType === "idempotency",
      );
    expect(idempotencyPut?.conditionExpression).toContain(
      "#idempotencyData.#idempotencyExpiresAt <= :idempotencyNow",
    );
    expect(idempotencyPut?.expressionAttributeValues?.[":idempotencyNow"]).toBe(
      currentTime.toISOString(),
    );
  });

  it("derives run memory grants from the canonical run workspace", async () => {
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
    const runScope = { ...tenantScope, workspaceId: ids.workspace };
    const otherWorkspaceId = indexedUlid(13_200);
    const otherScope = { ...tenantScope, workspaceId: otherWorkspaceId };
    const tenantSpace = await platform.createMemorySpace(tenantScope, { name: "Tenant grant" });
    const runSpace = await platform.createMemorySpace(runScope, { name: "Run workspace" });
    const otherSpace = await platform.createMemorySpace(otherScope, { name: "Other workspace" });
    const run = await grantedFlushRun(platform, put, runScope, runSpace.data.id);
    await platform.grantMemorySpace(tenantScope, {
      agentDefinitionId: ids.agent,
      memorySpaceId: tenantSpace.data.id,
      permission: "read-write",
    });
    await platform.grantMemorySpace(otherScope, {
      agentDefinitionId: ids.agent,
      memorySpaceId: otherSpace.data.id,
      permission: "read-write",
    });
    const access = await platform.memoryAccessForRun(tenantScope, run.data.id);
    expect(access.readMemorySpaceIds).toHaveLength(2);
    expect(access.readMemorySpaceIds).toEqual(
      expect.arrayContaining([tenantSpace.data.id, runSpace.data.id]),
    );
    expect(access.writeMemorySpaceIds).toHaveLength(2);
    expect(access.writeMemorySpaceIds).toEqual(
      expect.arrayContaining([tenantSpace.data.id, runSpace.data.id]),
    );
  });

  it("adds only validated continuation ancestors to run memory access", async () => {
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
    const space = await platform.createMemorySpace(scope, { name: "Continuation access" });
    const run = await grantedFlushRun(platform, put, scope, space.data.id);
    const predecessorThreadId = indexedUlid(13_210);
    const predecessorDeploymentId = indexedUlid(13_211);
    const threadRecord = (threadId: Ulid, agentDeploymentId: Ulid, continuedFromThreadId?: Ulid) =>
      withCanonicalRecordKeys({
        data: {
          agentDeploymentId,
          archived: false,
          channel: "api",
          ...(continuedFromThreadId ? { continuedFromThreadId } : {}),
          createdAt: fixedNow.toISOString(),
          createdBy: { id: ids.agent, type: "service-account" as const },
          environmentId: scope.environmentId,
          id: threadId,
          organizationId: scope.organizationId,
          pinned: false,
          projectId: scope.projectId,
          streamId: indexedUlid(13_212),
          title: "Conversation",
          updatedAt: fixedNow.toISOString(),
          version: 0,
        },
        itemType: "thread" as const,
      }) as PlatformRecord;
    put(
      "execution",
      threadRecord(run.data.threadId, grantedFlushDeploymentId, predecessorThreadId),
    );
    put("execution", threadRecord(predecessorThreadId, predecessorDeploymentId));
    put(
      "control",
      withCanonicalRecordKeys({
        data: {
          agentDefinitionId: ids.agent,
          agentReleaseId: ids.memory2,
          createdAt: fixedNow.toISOString(),
          currentState: "stopped" as const,
          desiredState: "stopped" as const,
          environmentId: scope.environmentId,
          id: predecessorDeploymentId,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          updatedAt: fixedNow.toISOString(),
          version: 1,
        },
        itemType: "agent-deployment" as const,
      }) as PlatformRecord,
    );

    expect(
      platform.memoryAccessForRun(scope, run.data.id, { includeThreadContinuity: true }),
    ).resolves.toMatchObject({
      searchKeys: expect.arrayContaining([
        `thread:${run.data.threadId}`,
        `thread:${predecessorThreadId}`,
      ]),
    });
  });

  it("keeps workspace grants out of workspace-less runs", async () => {
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
    const tenantSpace = await platform.createMemorySpace(tenantScope, { name: "Tenant run" });
    const workspaceSpace = await platform.createMemorySpace(workspaceScope, {
      name: "Workspace-only grant",
    });
    const run = await grantedFlushRun(platform, put, tenantScope, tenantSpace.data.id);
    await platform.grantMemorySpace(workspaceScope, {
      agentDefinitionId: ids.agent,
      memorySpaceId: workspaceSpace.data.id,
      permission: "read-write",
    });

    expect(platform.memoryAccessForRun(tenantScope, run.data.id)).resolves.toMatchObject({
      readMemorySpaceIds: [tenantSpace.data.id],
      writeMemorySpaceIds: [tenantSpace.data.id],
    });
  });

  it("globally ranks active recall across more than twenty granted spaces", async () => {
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
    const memorySpaceIds = [];
    for (let index = 0; index < 21; index += 1) {
      const space = await platform.createMemorySpace(scope, { name: `Search batch ${index}` });
      memorySpaceIds.push(space.data.id);
    }
    await platform.upsertPolicy(scope, { activeRecallEnabled: true });

    expect(
      platform.search(scope, {
        memorySpaceIds,
        purpose: "active-recall",
        query: "search every authorized memory space",
        runId: ids.run,
        threadId: ids.thread,
      }),
    ).resolves.toMatchObject({ results: [] });
    expect(search.queries).toHaveLength(1);
    const query = JSON.stringify(search.queries[0]);
    for (const memorySpaceId of memorySpaceIds) expect(query).toContain(memorySpaceId);
  });
});
