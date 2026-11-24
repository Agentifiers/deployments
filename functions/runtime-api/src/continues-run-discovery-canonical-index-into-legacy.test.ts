import {
  AgentDeploymentRecord,
  ApprovalRecord,
  RunLocatorRecord,
  RunRecord,
  RuntimeLeaseRecord,
  ThreadRecord,
  ToolCallRecord,
  WorkspaceRecord,
  key,
  prepareDynamoTransactionOperations,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { cancelRunThreadEvents } from "./runtime-handler.ts";
import { archiveThread, cancelRun, createThread, listRuns } from "./runtime-operations.ts";
import type { RuntimeApiDependencies, RuntimeApiPrincipal } from "./runtime-support.ts";

const ids = Array.from(
  { length: 32 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5${String(index).padStart(3, "0")}`,
) as Ulid[];
const [organizationId, projectId, environmentId, serviceAccountId, deploymentId] = ids as [
  Ulid,
  Ulid,
  Ulid,
  Ulid,
  Ulid,
];
const now = new Date("2026-07-25T12:00:00.000Z");
const sessionTokenSecret = "runtime-api-test-secret".repeat(2);

function memoryDatabase(seed: readonly PlatformRecord[] = []) {
  const records = new Map<string, PlatformRecord>();
  const queries: Parameters<DynamoDatabaseService["queryRecords"]>[1][] = [];
  const transactions: Array<readonly TransactionOperation[]> = [];
  const recordKey = (record: Pick<PlatformRecord, "pk" | "sk">) => `${record.pk}\n${record.sk}`;
  for (const record of seed) records.set(recordKey(record), record);
  const database = {
    getRecord: (
      _table: Parameters<DynamoDatabaseService["getRecord"]>[0],
      requested: Parameters<DynamoDatabaseService["getRecord"]>[1],
    ) => {
      const record = records.get(`${requested.pk}\n${requested.sk}`);
      return Promise.resolve(record);
    },
    queryRecords: (
      _table: Parameters<DynamoDatabaseService["queryRecords"]>[0],
      input: Parameters<DynamoDatabaseService["queryRecords"]>[1],
    ) => {
      queries.push(input);
      const values = input.ExpressionAttributeValues ?? {};
      const partition = values[":pk"];
      const prefix = values[":prefix"];
      const items = [...records.values()].filter((record) => {
        const recordPartition = input.IndexName === "gsi2" ? record.gsi2pk : record.pk;
        const recordSort = input.IndexName === "gsi2" ? record.gsi2sk : record.sk;
        return (
          recordPartition === partition &&
          (typeof prefix !== "string" || recordSort?.startsWith(prefix))
        );
      });
      return Promise.resolve({ items });
    },
    transactWrite: (operations: Parameters<DynamoDatabaseService["transactWrite"]>[0]) => {
      transactions.push(operations);
      for (const operation of operations) {
        if (
          operation.kind === "put" &&
          operation.conditionExpression?.includes("attribute_not_exists") &&
          records.has(recordKey(operation.record))
        ) {
          const conflict = new Error("conditional write failed");
          conflict.name = "ConditionalCheckFailedException";
          return Promise.reject(conflict as never);
        }
      }
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        const table = tableForItemType(operation.record.itemType);
        if (!["control", "events", "execution"].includes(table)) continue;
        if (operation.kind === "delete") records.delete(recordKey(operation.record));
        else records.set(recordKey(operation.record), operation.record);
      }
      return Promise.resolve(undefined);
    },
  } as unknown as DynamoDatabaseService;
  return { database, queries, records, transactions };
}

function principal(): RuntimeApiPrincipal {
  return {
    credential: { data: { scopes: ["platform:*"] } },
    scope: { environmentId, organizationId, projectId },
    serviceAccount: {
      data: { id: serviceAccountId, scopes: ["platform:*"] },
    },
  } as unknown as RuntimeApiPrincipal;
}

function deployment() {
  return Schema.decodeUnknownSync(AgentDeploymentRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId: ids[5]!,
        agentReleaseId: ids[6]!,
        createdAt: now.toISOString(),
        currentState: "ready" as const,
        desiredState: "running" as const,
        environmentId,
        id: deploymentId,
        organizationId,
        projectId,
        updatedAt: now.toISOString(),
        version: 0,
      },
      itemType: "agent-deployment" as const,
    }),
  );
}

function runRecord(
  status: "completed" | "failed" | "queued" | "running",
  runId = ids[7]!,
  idempotencyKey = `run-${status}`,
) {
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: deploymentId,
        agentReleaseId: ids[6]!,
        attempt: status === "failed" ? 3 : 0,
        captureMode: "metadata-only" as const,
        createdAt: now.toISOString(),
        ...(status === "completed" || status === "failed"
          ? { completedAt: now.toISOString() }
          : {}),
        environmentId,
        executor: "hosted",
        id: runId,
        idempotencyKey,
        organizationId,
        priority: 50,
        projectId,
        redactionPolicyVersion: 1 as const,
        schemaVersion: 1 as const,
        spanId: "0123456789abcdef",
        status,
        threadId: ids[8]!,
        trigger: "api",
        traceId: "0123456789abcdef0123456789abcdef",
        updatedAt: now.toISOString(),
        userMessageId: ids[14]!,
        userMessageSequence: 0,
        version: 1,
      },
      itemType: "run" as const,
    }),
  );
}

function runLocator(run: ReturnType<typeof runRecord>) {
  return Schema.decodeUnknownSync(RunLocatorRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: run.data.createdAt,
        environmentId,
        id: run.data.id,
        organizationId,
        projectId,
        runPk: run.pk,
        runSk: run.sk,
      },
      itemType: "run-locator" as const,
    }),
  );
}

function threadRecord(run: ReturnType<typeof runRecord>) {
  return Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: run.data.agentDeploymentId,
        archived: false,
        channel: "api",
        createdAt: now.toISOString(),
        createdBy: {
          id: serviceAccountId,
          type: "service-account" as const,
        },
        environmentId,
        id: run.data.threadId,
        organizationId,
        pinned: false,
        projectId,
        streamId: ids[18]!,
        title: "Replay source",
        updatedAt: now.toISOString(),
        version: 0,
      },
      itemType: "thread" as const,
    }),
  );
}

function threadExecutionLease(run: ReturnType<typeof runRecord>) {
  return Schema.decodeUnknownSync(RuntimeLeaseRecord)(
    withCanonicalRecordKeys({
      data: {
        acquiredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
        id: run.data.threadId,
        leaseKey: `agent-run-thread/${run.data.threadId}`,
        owner: `worker:${ids[19]}`,
        runId: run.data.id,
        threadId: run.data.threadId,
        version: 2,
      },
      itemType: "runtime-lease" as const,
    }),
  );
}

function approvalRecord(
  status: "approved" | "expired" | "pending" | "rejected",
  approvalId: Ulid,
  toolCallId?: Ulid,
) {
  return Schema.decodeUnknownSync(ApprovalRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: now.toISOString(),
        environmentId,
        escalationCount: 0,
        id: approvalId,
        organizationId,
        projectId,
        request: { toolName: "deploy" },
        requestedByAgentDeploymentId: deploymentId,
        runId: ids[7]!,
        status,
        threadId: ids[8]!,
        ...(toolCallId ? { toolCallId } : {}),
        updatedAt: now.toISOString(),
        version: 0,
      },
      itemType: "approval" as const,
    }),
  );
}

function waitingToolCall(toolCallId: Ulid, approvalId: Ulid) {
  return Schema.decodeUnknownSync(ToolCallRecord)(
    withCanonicalRecordKeys({
      data: {
        approvalId,
        createdAt: now.toISOString(),
        effect: "write" as const,
        environmentId,
        id: toolCallId,
        inputSummary: "Deploy release",
        organizationId,
        policyAction: "require-approval" as const,
        projectId,
        requiredScopes: ["deployments:write"],
        runId: ids[7]!,
        status: "waiting" as const,
        threadId: ids[8]!,
        toolName: "deploy",
        updatedAt: now.toISOString(),
        version: 0,
      },
      itemType: "tool-call" as const,
    }),
  );
}

describe("runtime discovery and lifecycle operations", () => {
  test("continues run discovery from the canonical index into the legacy index", async () => {
    const canonical = runRecord("completed", ids[10]!, "canonical-run");
    const legacy = runRecord("failed", ids[11]!, "legacy-run");
    const database = {
      queryRecords: (
        _table: string,
        input: { readonly ExpressionAttributeValues?: Readonly<Record<string, unknown>> },
      ) => {
        const partition = input.ExpressionAttributeValues?.[":pk"];
        return Promise.resolve({
          items:
            partition === key("ENV", environmentId, "AGENT-DEPLOYMENT", deploymentId)
              ? [canonical]
              : partition === key("ENV", environmentId)
                ? [legacy]
                : [],
        });
      },
    } as unknown as DynamoDatabaseService;

    const first = await listRuns(
      {
        database,
        sessionTokenSecret,
      } as unknown as RuntimeApiDependencies,
      principal(),
      { limit: "1" },
      { agentDeploymentId: deploymentId },
    );
    const second = await listRuns(
      {
        database,
        sessionTokenSecret,
      } as unknown as RuntimeApiDependencies,
      principal(),
      { cursor: first.nextCursor, limit: "1" },
      { agentDeploymentId: deploymentId },
    );

    expect(first.runs.map((run) => run.id)).toEqual([canonical.data.id]);
    expect(first.nextCursor).toStartWith("rac2.");
    expect(second.runs.map((run) => run.id)).toEqual([legacy.data.id]);
    expect(second.nextCursor).toBeUndefined();
  });

  test("creates an independent thread and records its semantic lifecycle event", async () => {
    const workspace = Schema.decodeUnknownSync(WorkspaceRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: now.toISOString(),
          environmentId,
          id: ids[10]!,
          name: "Runtime workspace",
          organizationId,
          projectId,
          slug: "runtime-workspace",
          status: "active" as const,
          updatedAt: now.toISOString(),
          version: 0,
        },
        itemType: "workspace" as const,
      }),
    );
    const memory = memoryDatabase([deployment(), workspace]);
    const generated = [ids[7]!, ids[8]!, ids[9]!];
    const dependencies = {
      database: memory.database,
      generateId: async () => generated.shift()!,
      now: () => now,
    } as unknown as RuntimeApiDependencies;

    const result = await createThread(dependencies, principal(), {
      agentDeploymentId: deploymentId,
      title: "Operations",
      workspaceId: workspace.data.id,
    });

    expect(result).toMatchObject({
      archived: false,
      id: ids[7],
      object: "thread",
      title: "Operations",
      workspaceId: workspace.data.id,
    });
    expect(
      memory.transactions[0]?.filter((operation) => operation.kind === "condition-check"),
    ).toEqual([
      expect.objectContaining({
        expressionAttributeValues: expect.objectContaining({
          ":ready": "ready",
          ":running": "running",
          ":version": 0,
        }),
        key: { pk: deployment().pk, sk: deployment().sk },
        table: "control",
      }),
      expect.objectContaining({
        expressionAttributeValues: expect.objectContaining({
          ":active": "active",
          ":version": workspace.data.version,
        }),
        key: { pk: workspace.pk, sk: workspace.sk },
        table: "control",
      }),
    ]);
    expect(
      [...memory.records.values()].some(
        (record) =>
          record.itemType === "semantic-event" && record.data.eventType === "thread.created",
      ),
    ).toBe(true);
  });

  test("rejects thread archival while the thread has an active run", async () => {
    const run = runRecord("queued");
    const thread = threadRecord(run);
    const memory = memoryDatabase([thread, run]);

    expect(
      archiveThread(
        {
          database: memory.database,
          generateId: async () => ids[9]!,
          now: () => now,
        } as unknown as RuntimeApiDependencies,
        principal(),
        thread.data.id,
      ),
    ).rejects.toMatchObject({ code: "thread_active", status: 409 });
    expect(memory.transactions).toHaveLength(0);
  });

  test("cancels active runs and persists a discoverable lifecycle event", async () => {
    const run = runRecord("running");
    const lease = threadExecutionLease(run);
    const memory = memoryDatabase([run, runLocator(run), lease]);
    const dependencies = {
      database: memory.database,
      generateId: async () => ids[9]!,
      now: () => now,
    } as unknown as RuntimeApiDependencies;

    const result = await cancelRun(dependencies, principal(), run.data.id);
    const canceled = memory.records.get(`${run.pk}\n${run.sk}`) as Extract<
      PlatformRecord,
      { readonly itemType: "run" }
    >;
    const advanced = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...canceled,
        data: {
          ...canceled.data,
          updatedAt: new Date(now.getTime() + 1_000).toISOString(),
          version: canceled.data.version + 1,
        },
      }),
    );
    memory.records.set(`${advanced.pk}\n${advanced.sk}`, advanced);
    const recovered = await cancelRun(dependencies, principal(), run.data.id);

    expect(result.run).toMatchObject({ id: run.data.id, status: "canceled" });
    expect(recovered.run).toEqual(result.run);
    expect(cancelRunThreadEvents(principal(), recovered)).toEqual(
      cancelRunThreadEvents(principal(), result),
    );
    expect(memory.records.has(`${lease.pk}\n${lease.sk}`)).toBe(false);
    expect(
      [...memory.records.values()].some(
        (record) =>
          record.itemType === "semantic-event" && record.data.eventType === "run.canceled",
      ),
    ).toBe(true);
  });

  test("releases the organization execution slot of a canceled running run", async () => {
    const active = runRecord("running");
    const run = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...active,
        data: { ...active.data, executionSlot: 0 },
        itemType: "run" as const,
      }),
    );
    const memory = memoryDatabase([run, runLocator(run), threadExecutionLease(run)]);

    await cancelRun(
      {
        database: memory.database,
        generateId: async () => ids[9]!,
        now: () => now,
      } as unknown as RuntimeApiDependencies,
      principal(),
      run.data.id,
    );
    const prepared = await prepareDynamoTransactionOperations(memory.transactions.at(-1)!);

    expect(
      prepared.flatMap((operation) =>
        operation.kind === "delete" && operation.record.itemType === "unique-claim"
          ? [
              [
                operation.record.data.namespace,
                operation.record.data.value,
                operation.record.data.ownerId,
              ],
            ]
          : [],
      ),
    ).toEqual([[`organization:${organizationId}:run-execution-slot`, "0", run.data.id]]);
  });

  test("cancels a non-chat run without requiring terminal dispatch", async () => {
    const active = runRecord("running");
    const { userMessageId: _userMessageId, userMessageSequence: _sequence, ...data } = active.data;
    const run = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({ ...active, data, itemType: "run" as const }),
    );
    const memory = memoryDatabase([run, runLocator(run)]);

    const result = await cancelRun(
      {
        database: memory.database,
        generateId: async () => ids[9]!,
        now: () => now,
      } as unknown as RuntimeApiDependencies,
      principal(),
      run.data.id,
    );

    expect(result.run.status).toBe("canceled");
    expect(
      [...memory.records.values()].some(
        (record) =>
          record.itemType === "semantic-event" && record.data.eventType === "run.requested",
      ),
    ).toBe(false);
  });

  test("retries cancellation after a transient worker write conflict", async () => {
    const run = runRecord("running");
    const lease = threadExecutionLease(run);
    const memory = memoryDatabase([run, runLocator(run), lease]);
    let transactionAttempts = 0;
    const database = {
      ...memory.database,
      transactWrite: (operations: readonly TransactionOperation[]) => {
        transactionAttempts += 1;
        if (transactionAttempts === 1) {
          return Promise.reject({ name: "TransactionConflictException" } as never);
        }
        return memory.database.transactWrite(operations);
      },
    } as DynamoDatabaseService;

    const result = await cancelRun(
      {
        database,
        generateId: async () => ids[9]!,
        now: () => now,
      } as unknown as RuntimeApiDependencies,
      principal(),
      run.data.id,
    );

    expect(result.run).toMatchObject({ id: run.data.id, status: "canceled" });
    expect(transactionAttempts).toBe(2);
  });

  test("terminalizes a pending approval and waiting tool when canceling a paused run", async () => {
    const active = runRecord("running");
    const run = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...active,
        data: {
          ...active.data,
          status: "waiting-for-approval" as const,
        },
      }),
    );
    const approvalId = ids[9]!;
    const toolCallId = ids[10]!;
    const approval = approvalRecord("pending", approvalId, toolCallId);
    const toolCall = waitingToolCall(toolCallId, approvalId);
    const memory = memoryDatabase([run, runLocator(run), approval, toolCall]);
    const generated = [ids[11]!, ids[12]!, ids[13]!, ids[14]!];
    const dependencies = {
      database: memory.database,
      generateId: async () => generated.shift()!,
      now: () => now,
    } as unknown as RuntimeApiDependencies;

    const result = await cancelRun(dependencies, principal(), run.data.id);
    const recovered = await cancelRun(dependencies, principal(), run.data.id);

    expect(memory.records.get(`${approval.pk}\n${approval.sk}`)).toMatchObject({
      data: { status: "rejected" },
    });
    expect(memory.records.get(`${toolCall.pk}\n${toolCall.sk}`)).toMatchObject({
      data: { status: "failed" },
    });
    expect(cancelRunThreadEvents(principal(), result).map((event) => event.eventType)).toEqual([
      "approval.resolved",
      "tool.failed",
      "run.canceled",
    ]);
    expect(cancelRunThreadEvents(principal(), recovered)).toEqual(
      cancelRunThreadEvents(principal(), result),
    );
    expect(
      [...memory.records.values()].some(
        (record) =>
          record.itemType === "semantic-event" && record.data.eventType === "run.requested",
      ),
    ).toBe(true);
  });
});
