import { expect } from "bun:test";
import {
  AgentDeploymentRecord,
  AgentReleaseRecord,
  MessageRecord,
  RunRecord,
  ThreadRecord,
  capacityClaimRequirements,
  capacityHolding,
  makeOrganizationCapacity,
  makeUniqueClaimRecord,
  prepareDynamoTransactionOperations,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TableName,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { agentManifestContentHash, AgentManifestV1 } from "@deployments-ai/agent-manifest";
import { Schema } from "effect";
import { runLookupRecord } from "./index.ts";
import { assertSimulatedConditionCheck } from "./agent-run-condition-checks.fixture.ts";
import { recordingTenantLimitMetrics, testTenantLimits } from "./tenant-limits.fixture.ts";
import type {
  AgentReleaseRecordValue,
  AgentRunQueueMessage,
  AgentRunWorkerDependencies,
} from "./types.ts";

export const id = (value: number) =>
  `01ARZ3NDEKTSV4RRFFQ69G${String(value).padStart(4, "0")}` as Ulid;

export {
  abandonedRunWithLease,
  additionalRunOnThread,
  customerRunPins,
  fifoQueueRecord,
  manifestWithToolRequests,
  manifestWithTriggers,
  processQueueRecords,
} from "./agent-run-state.fixture.ts";

export function storeKey(table: TableName, pk: string, sk: string): string {
  return `${table}\u0000${pk}\u0000${sk}`;
}

export function inMemoryDatabase(
  initial: readonly PlatformRecord[],
  options: {
    readonly conflictOnceOnThreadCompletion?: boolean;
    readonly conflictThreadAgentDeploymentId?: Ulid;
    readonly conflictThreadUpdatedAt?: string;
    readonly cancelRunBeforeCompletionCommitOnce?: boolean;
    readonly cancelRunBeforeHeartbeatCommitOnce?: boolean;
    readonly cancelRunBeforeModelInvocationCommitOnce?: boolean;
    readonly delayModelInvocationCommitMs?: number;
    readonly failCanceledBeforeCommitOnce?: boolean;
    readonly failClaimBeforeCommitOnce?: boolean;
    readonly failCompletionBeforeCommitOnce?: boolean;
    readonly failCompletionReconciliationReadOnce?: boolean;
    readonly failHeartbeatBeforeCommitOnce?: boolean;
    readonly onHeartbeatFailureBeforeCommit?: () => void;
    readonly onCompletionFailureBeforeCommit?: () => void;
    readonly queryPageSize?: number;
    readonly repinThreadAfterClaimAgentDeploymentId?: Ulid;
    readonly replaceRecordAfterAgentStreamWrite?: PlatformRecord;
    readonly throwAfterClaimCommitOnce?: boolean;
    readonly throwAfterCompletionCommitOnce?: boolean;
    readonly throwAfterHeartbeatCommitOnce?: boolean;
    readonly throwAfterModelInvocationCommitOnce?: boolean;
  } = {},
) {
  const records = new Map<string, PlatformRecord>();
  const queryInputs: unknown[] = [];
  const transactionInputs: TransactionOperation[][] = [];
  const transactionTokens: (string | undefined)[] = [];
  let completionConflictPending = options.conflictOnceOnThreadCompletion ?? false;
  let modelInvocationCancellationPending =
    options.cancelRunBeforeModelInvocationCommitOnce ?? false;
  let completionCancellationPending = options.cancelRunBeforeCompletionCommitOnce ?? false;
  let heartbeatCancellationPending = options.cancelRunBeforeHeartbeatCommitOnce ?? false;
  let completionFailurePending = options.failCompletionBeforeCommitOnce ?? false;
  let canceledFailurePending = options.failCanceledBeforeCommitOnce ?? false;
  let claimFailurePending = options.failClaimBeforeCommitOnce ?? false;
  let completionReconciliationReadPending = false;
  let heartbeatFailurePending = options.failHeartbeatBeforeCommitOnce ?? false;
  let repinAfterClaimPending = options.repinThreadAfterClaimAgentDeploymentId !== undefined;
  let ambiguousClaimPending = options.throwAfterClaimCommitOnce ?? false;
  let ambiguousCompletionPending = options.throwAfterCompletionCommitOnce ?? false;
  let ambiguousHeartbeatPending = options.throwAfterHeartbeatCommitOnce ?? false;
  let ambiguousModelInvocationPending = options.throwAfterModelInvocationCommitOnce ?? false;
  const initialWithRunLookups: PlatformRecord[] = [];
  for (const record of initial) {
    initialWithRunLookups.push(record);
    if (record.itemType === "run") initialWithRunLookups.push(runLookupRecord(record));
  }
  for (const record of initialWithRunLookups) {
    records.set(storeKey(tableForItemType(record.itemType), record.pk, record.sk), record);
    for (const requirement of capacityClaimRequirements(record)) {
      const claim = makeUniqueClaimRecord(
        requirement,
        capacityHolding(record)!.updatedAt,
      ) as PlatformRecord;
      records.set(storeKey(tableForItemType(claim.itemType), claim.pk, claim.sk), claim);
    }
  }

  function replaceAfterAgentStreamWrite(record: PlatformRecord): void {
    if (
      (record.itemType !== "slack-agent-stream" && record.itemType !== "teams-agent-stream") ||
      !options.replaceRecordAfterAgentStreamWrite
    ) {
      return;
    }
    const replacement = options.replaceRecordAfterAgentStreamWrite;
    records.set(
      storeKey(tableForItemType(replacement.itemType), replacement.pk, replacement.sk),
      replacement,
    );
  }

  function write(operation: TransactionOperation): void {
    if (operation.kind === "condition-check") {
      assertSimulatedConditionCheck(
        operation,
        records.get(storeKey(operation.table, operation.key.pk, operation.key.sk)),
      );
      return;
    }
    const record = operation.record;
    const table = tableForItemType(record.itemType);
    const key = storeKey(table, record.pk, record.sk);
    if (operation.kind === "delete") {
      records.delete(key);
      return;
    }
    if (operation.conditionExpression?.includes("attribute_not_exists") && records.has(key)) {
      throw new Error("simulated create-only write conflict");
    }
    if (operation.previousRecord) {
      const existing = records.get(key);
      const existingVersion = existing
        ? (existing.data as Readonly<Record<string, unknown>>).version
        : undefined;
      const previousVersion = (operation.previousRecord.data as Readonly<Record<string, unknown>>)
        .version;
      if (!existing || typeof existingVersion !== "number" || existingVersion !== previousVersion) {
        throw new Error("simulated optimistic write conflict");
      }
    }
    records.set(key, record);
    replaceAfterAgentStreamWrite(record);
  }

  function cancelRunningRun(): void {
    const running = [...records.values()].find(
      (record) => record.itemType === "run" && record.data.status === "running",
    );
    if (running?.itemType !== "run") return;
    const canceled = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...running.data,
          completedAt: "2026-07-22T00:00:01.500Z",
          status: "canceled" as const,
          updatedAt: "2026-07-22T00:00:01.500Z",
          version: running.data.version + 1,
        },
        itemType: "run" as const,
      }),
    );
    records.set(storeKey(tableForItemType(canceled.itemType), canceled.pk, canceled.sk), canceled);
    for (const [recordKey, record] of records) {
      if (record.itemType === "runtime-lease" && record.data.runId === running.data.id) {
        records.delete(recordKey);
      }
    }
  }

  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => {
      records.delete(storeKey(tableForItemType(record.itemType), record.pk, record.sk));
    },
    getRecord: async (table, key) => {
      if (completionReconciliationReadPending && table === "execution") {
        completionReconciliationReadPending = false;
        throw new Error("simulated completion reconciliation read failure");
      }
      const found = records.get(storeKey(table, key.pk, key.sk));
      return found;
    },
    putRecord: async (record) => {
      records.set(storeKey(tableForItemType(record.itemType), record.pk, record.sk), record);
      replaceAfterAgentStreamWrite(record);
    },
    queryRecords: async (table, input) => {
      queryInputs.push(input);
      const values = input.ExpressionAttributeValues as
        | Readonly<Record<string, unknown>>
        | undefined;
      const pk = values?.[":pk"];
      const prefix = values?.[":prefix"];
      const maximumSk = values?.[":maximumSk"];
      const allItems = [...records.values()]
        .filter((record) => tableForItemType(record.itemType) === table)
        .filter((record) => (typeof pk === "string" ? record.pk === pk : true))
        .filter((record) => (typeof prefix === "string" ? record.sk.startsWith(prefix) : true))
        .filter((record) => (typeof maximumSk === "string" ? record.sk <= maximumSk : true))
        .sort((left, right) => left.sk.localeCompare(right.sk));
      if (input.ScanIndexForward === false) allItems.reverse();
      const startKey = input.ExclusiveStartKey as Readonly<Record<string, unknown>> | undefined;
      const startIndex =
        typeof startKey?.sk === "string"
          ? Math.max(0, allItems.findIndex((record) => record.sk === startKey.sk) + 1)
          : 0;
      const requestedLimit = typeof input.Limit === "number" ? input.Limit : allItems.length;
      const pageSize = Math.min(options.queryPageSize ?? allItems.length, requestedLimit);
      const items = allItems.slice(startIndex, startIndex + pageSize);
      const last = items.at(-1);
      return {
        items,
        ...(startIndex + items.length < allItems.length && last
          ? { lastEvaluatedKey: { pk: last.pk, sk: last.sk } }
          : {}),
      };
    },
    transactWrite: async (operations, clientRequestToken) => {
      if (
        options.delayModelInvocationCommitMs &&
        operations.some(
          (operation) =>
            operation.kind === "put" && operation.record.itemType === "model-invocation",
        )
      ) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, options.delayModelInvocationCommitMs),
        );
      }
      transactionInputs.push([...operations]);
      transactionTokens.push(clientRequestToken);
      if (
        modelInvocationCancellationPending &&
        operations.some(
          (operation) =>
            operation.kind === "put" && operation.record.itemType === "model-invocation",
        )
      ) {
        modelInvocationCancellationPending = false;
        cancelRunningRun();
      }
      if (
        heartbeatCancellationPending &&
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "semantic-event" &&
            operation.record.data.eventType === "run.heartbeat",
        )
      ) {
        heartbeatCancellationPending = false;
        cancelRunningRun();
      }
      if (
        completionCancellationPending &&
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "run" &&
            operation.record.data.status === "completed",
        )
      ) {
        completionCancellationPending = false;
        cancelRunningRun();
      }
      if (
        claimFailurePending &&
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "run" &&
            operation.record.data.status === "running",
        )
      ) {
        claimFailurePending = false;
        throw new Error("simulated claim failure before commit");
      }
      if (
        completionFailurePending &&
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "run" &&
            operation.record.data.status === "completed",
        )
      ) {
        completionFailurePending = false;
        options.onCompletionFailureBeforeCommit?.();
        throw new Error("simulated transient completion failure");
      }
      if (
        canceledFailurePending &&
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "run" &&
            operation.record.data.status === "canceled",
        )
      ) {
        canceledFailurePending = false;
        throw new Error("simulated transient canceled-run persistence failure");
      }
      if (
        heartbeatFailurePending &&
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "semantic-event" &&
            operation.record.data.eventType === "run.heartbeat",
        )
      ) {
        heartbeatFailurePending = false;
        options.onHeartbeatFailureBeforeCommit?.();
        throw new Error("simulated heartbeat failure before commit");
      }
      if (
        completionConflictPending &&
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "run" &&
            operation.record.data.status === "completed",
        )
      ) {
        completionConflictPending = false;
        const threadOperation = operations.find(
          (operation) => operation.kind === "put" && operation.record.itemType === "thread",
        );
        if (threadOperation?.kind === "put") {
          const current = records.get(
            storeKey(
              tableForItemType(threadOperation.record.itemType),
              threadOperation.record.pk,
              threadOperation.record.sk,
            ),
          );
          if (current?.itemType === "thread") {
            records.set(
              storeKey(tableForItemType(current.itemType), current.pk, current.sk),
              Schema.decodeUnknownSync(ThreadRecord)(
                withCanonicalRecordKeys({
                  data: {
                    ...current.data,
                    ...(options.conflictThreadAgentDeploymentId
                      ? { agentDeploymentId: options.conflictThreadAgentDeploymentId }
                      : {}),
                    updatedAt: options.conflictThreadUpdatedAt ?? "2026-07-22T00:00:00.500Z",
                    version: current.data.version + 1,
                  },
                  itemType: "thread" as const,
                }),
              ),
            );
          }
        }
        throw new Error("simulated optimistic write conflict");
      }
      const prepared = await prepareDynamoTransactionOperations(operations);
      const supplied = new Map<string, TransactionOperation>();
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        const { itemType, pk, sk } = operation.record;
        supplied.set(storeKey(tableForItemType(itemType), pk, sk), operation);
      }
      const committed = new Map(records);
      try {
        for (const operation of prepared) {
          if (operation.kind === "condition-check") write(operation);
        }
        for (const operation of prepared) {
          if (operation.kind === "condition-check") continue;
          const { itemType, pk, sk } = operation.record;
          const companion =
            operation.kind === "put" && operation.conditionExpression?.includes(" OR ")
              ? { kind: "put" as const, record: operation.record }
              : operation;
          write(supplied.get(storeKey(tableForItemType(itemType), pk, sk)) ?? companion);
        }
      } catch (cause) {
        records.clear();
        for (const [recordKey, record] of committed) records.set(recordKey, record);
        throw cause;
      }
      if (
        ambiguousModelInvocationPending &&
        operations.some(
          (operation) =>
            operation.kind === "put" && operation.record.itemType === "model-invocation",
        )
      ) {
        ambiguousModelInvocationPending = false;
        throw new Error("simulated lost model invocation response");
      }
      if (
        ambiguousCompletionPending &&
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "run" &&
            operation.record.data.status === "completed",
        )
      ) {
        ambiguousCompletionPending = false;
        completionReconciliationReadPending = options.failCompletionReconciliationReadOnce ?? false;
        throw new Error("simulated lost completion response");
      }
      if (
        repinAfterClaimPending &&
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "run" &&
            operation.record.data.status === "running",
        )
      ) {
        repinAfterClaimPending = false;
        const claimedRun = operations.find(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "run" &&
            operation.record.data.status === "running",
        );
        const claimedThreadId =
          claimedRun?.kind === "put" && claimedRun.record.itemType === "run"
            ? claimedRun.record.data.threadId
            : undefined;
        const persistedThread = claimedThreadId
          ? [...records.values()].find(
              (record) => record.itemType === "thread" && record.data.id === claimedThreadId,
            )
          : undefined;
        if (persistedThread?.itemType === "thread") {
          records.set(
            storeKey(
              tableForItemType(persistedThread.itemType),
              persistedThread.pk,
              persistedThread.sk,
            ),
            Schema.decodeUnknownSync(ThreadRecord)(
              withCanonicalRecordKeys({
                data: {
                  ...persistedThread.data,
                  agentDeploymentId: options.repinThreadAfterClaimAgentDeploymentId!,
                  version: persistedThread.data.version + 1,
                },
                itemType: "thread" as const,
              }),
            ),
          );
        }
      }
      if (
        ambiguousClaimPending &&
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "run" &&
            operation.record.data.status === "running",
        )
      ) {
        ambiguousClaimPending = false;
        throw new Error("simulated lost claim response");
      }
      if (
        ambiguousHeartbeatPending &&
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "semantic-event" &&
            operation.record.data.eventType === "run.heartbeat",
        )
      ) {
        ambiguousHeartbeatPending = false;
        throw new Error("simulated lost heartbeat response");
      }
    },
  };
  return {
    cancelRunningRun,
    database,
    queryInputs,
    records,
    transactionInputs,
    transactionTokens,
  };
}

export function fixtures() {
  const timestamp = "2026-07-22T00:00:00.000Z";
  const organizationId = id(1);
  const projectId = id(2);
  const environmentId = id(3);
  const workspaceId = id(4);
  const agentDefinitionId = id(5);
  const releaseId = id(6);
  const deploymentId = id(7);
  const threadId = id(8);
  const userMessageId = id(9);
  const runId = id(10);
  const manifest = Schema.decodeUnknownSync(AgentManifestV1)({
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: {
      key: "runtime.test-agent",
      name: "Runtime Test Agent",
      version: "1.0.0",
    },
    spec: {
      instructions: "Return the completed result.",
      memory: { mode: "off" },
      model: { fallbackIds: [], id: "openrouter/qwen/qwen3.7-plus" },
      sandbox: { mode: "none" },
      skills: [],
    },
  });
  const release = Schema.decodeUnknownSync(AgentReleaseRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId,
        contentHash: agentManifestContentHash(manifest),
        createdAt: timestamp,
        createdByPrincipalId: id(11),
        environmentId,
        id: releaseId,
        manifest,
        organizationId,
        projectId,
        releaseNumber: 1,
        status: "active" as const,
        version: 0,
      },
      itemType: "agent-release" as const,
    }),
  );
  const deployment = Schema.decodeUnknownSync(AgentDeploymentRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId,
        agentReleaseId: releaseId,
        createdAt: timestamp,
        currentState: "ready" as const,
        desiredState: "running" as const,
        environmentId,
        id: deploymentId,
        organizationId,
        projectId,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "agent-deployment" as const,
    }),
  );
  const thread = Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: deploymentId,
        archived: false,
        channel: "api",
        createdAt: timestamp,
        createdBy: { type: "service-account" as const },
        environmentId,
        id: threadId,
        organizationId,
        pinned: false,
        projectId,
        streamId: id(12),
        title: "Runtime test",
        updatedAt: timestamp,
        version: 0,
        workspaceId,
      },
      itemType: "thread" as const,
    }),
  );
  const userMessage = Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: deploymentId,
        body: "Produce the answer.",
        contentHash: "user-hash",
        createdAt: timestamp,
        environmentId,
        id: userMessageId,
        organizationId,
        projectId,
        role: "user" as const,
        runId,
        sequence: 0,
        threadId,
      },
      itemType: "message" as const,
    }),
  );
  const run = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: deploymentId,
        agentReleaseId: releaseId,
        attempt: 0,
        captureMode: "metadata-only" as const,
        createdAt: timestamp,
        environmentId,
        executor: "hosted",
        id: runId,
        idempotencyKey: "run/request-1",
        organizationId,
        priority: 1,
        projectId,
        redactionPolicyVersion: 1 as const,
        schemaVersion: 1 as const,
        spanId: "0123456789abcdef",
        status: "queued" as const,
        threadId,
        trigger: "api",
        traceId: "0123456789abcdef0123456789abcdef",
        updatedAt: timestamp,
        version: 0,
        workspaceId,
      },
      itemType: "run" as const,
    }),
  );
  const queue: AgentRunQueueMessage = {
    environmentId,
    idempotencyKey: run.data.idempotencyKey,
    organizationId,
    projectId,
    runId,
    spanId: run.data.spanId,
    threadId,
    traceId: run.data.traceId,
    userMessageId,
    userMessageSequence: 0,
  };
  return { deployment, queue, release, run, thread, userMessage };
}

export function manifestWithRuntime(
  manifest: AgentManifestV1,
  runtime: NonNullable<AgentManifestV1["spec"]["runtime"]>,
): AgentManifestV1 {
  return {
    ...manifest,
    spec: {
      ...manifest.spec,
      runtime: {
        ...manifest.spec.runtime,
        ...runtime,
      },
    },
  };
}

export function releaseWithManifest(
  release: AgentReleaseRecordValue,
  manifest: AgentManifestV1,
): AgentReleaseRecordValue {
  return Schema.decodeUnknownSync(AgentReleaseRecord)(
    withCanonicalRecordKeys({
      data: {
        ...release.data,
        contentHash: agentManifestContentHash(manifest),
        manifest,
      },
      itemType: "agent-release" as const,
    }),
  );
}

export function workerDependencies(database: DynamoDatabaseService) {
  let nextId = 100;
  let milliseconds = Date.parse("2026-07-22T00:00:01.000Z");
  const events: Parameters<NonNullable<AgentRunWorkerDependencies["appendThreadEvent"]>>[0][] = [];
  const dependencies: AgentRunWorkerDependencies = {
    appendThreadEvent: async (event) => void events.push(event),
    database,
    generateId: async () => id(nextId++),
    now: () => new Date(milliseconds++),
    organizationCapacity: makeOrganizationCapacity(database),
    queueMaxReceiveCount: 900,
    retryQueueMessage: async () => undefined,
    runtime: {
      generateAssistantMessage: async (request) => {
        expect(request.agentReleaseId).toBe(id(6));
        expect(request.prompt).toBe("Produce the answer.");
        return { assistantMessage: "Persisted assistant result." };
      },
    },
    tenantLimitMetrics: recordingTenantLimitMetrics().metrics,
    tenantLimits: testTenantLimits().resolver,
    workerId: "worker-test",
  };
  return { dependencies, events };
}
