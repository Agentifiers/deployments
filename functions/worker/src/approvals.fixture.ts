import {
  RunRecord,
  RuntimeLeaseRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TableName,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { pausedToolCallRecord, pendingApprovalRecord, runLookupRecord } from "./index.ts";
import type {
  ApprovalRunEnqueueInput,
  ResolveRunApprovalInput,
  ResolveRunToolResultInput,
} from "./approvals.ts";
import type { RunRecordValue } from "./types.ts";

export const id = (value: number) =>
  `01ARZ3NDEKTSV4RRFFQ69G${String(value).padStart(4, "0")}` as Ulid;

function storeKey(table: TableName, pk: string, sk: string): string {
  return `${table}\u0000${pk}\u0000${sk}`;
}

export function inMemoryDatabase(
  initial: readonly PlatformRecord[],
  options: {
    readonly competingToolOperationIdOnce?: string;
    readonly throwAfterCommitOnce?: boolean;
  } = {},
) {
  const records = new Map<string, PlatformRecord>();
  const queryInputs: unknown[] = [];
  let ambiguousCommitPending = options.throwAfterCommitOnce ?? false;
  let competingToolOperationId = options.competingToolOperationIdOnce;
  const initialWithRunLookups: PlatformRecord[] = [];
  for (const record of initial) {
    initialWithRunLookups.push(record);
    if (record.itemType === "run") initialWithRunLookups.push(runLookupRecord(record));
  }
  for (const record of initialWithRunLookups) {
    records.set(storeKey(tableForItemType(record.itemType), record.pk, record.sk), record);
  }

  function write(operation: TransactionOperation): void {
    if (operation.kind === "condition-check") return;
    const record = operation.record;
    const table = tableForItemType(record.itemType);
    const key = storeKey(table, record.pk, record.sk);
    if (operation.kind === "delete") {
      records.delete(key);
      return;
    }
    if (operation.conditionExpression?.includes("attribute_not_exists") && records.has(key)) {
      throw new Error("simulated create conflict");
    }
    if (operation.previousRecord) {
      const existing = records.get(key);
      const currentVersion = existing
        ? (existing.data as Readonly<Record<string, unknown>>).version
        : undefined;
      const previousVersion = (operation.previousRecord.data as Readonly<Record<string, unknown>>)
        .version;
      if (!existing || currentVersion !== previousVersion) {
        throw new Error("simulated optimistic conflict");
      }
    }
    records.set(key, record);
  }

  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => {
      records.delete(storeKey(tableForItemType(record.itemType), record.pk, record.sk));
    },
    getRecord: async (table, key) => {
      const record = records.get(storeKey(table, key.pk, key.sk));
      return record;
    },
    putRecord: async (record) => {
      records.set(storeKey(tableForItemType(record.itemType), record.pk, record.sk), record);
    },
    queryRecords: async (table, input) => {
      queryInputs.push(input);
      const values = input.ExpressionAttributeValues as Readonly<Record<string, unknown>>;
      const pk = values[":pk"];
      const prefix = values[":prefix"];
      return {
        items: [...records.values()]
          .filter((record) => tableForItemType(record.itemType) === table)
          .filter((record) => (typeof pk === "string" ? record.pk === pk : true))
          .filter((record) => (typeof prefix === "string" ? record.sk.startsWith(prefix) : true))
          .sort((left, right) => left.sk.localeCompare(right.sk)),
      };
    },
    transactWrite: async (operations) => {
      if (competingToolOperationId !== undefined) {
        const operationId = competingToolOperationId;
        competingToolOperationId = undefined;
        for (const operation of operations) {
          if (operation.kind === "put" && operation.record.itemType === "tool-call") {
            write({
              ...operation,
              record: {
                ...operation.record,
                data: { ...operation.record.data, externalOperationId: operationId },
              },
            });
          } else {
            write(operation);
          }
        }
        throw new Error("simulated competing callback commit");
      }
      for (const operation of operations) write(operation);
      if (ambiguousCommitPending) {
        ambiguousCommitPending = false;
        throw new Error("simulated lost transaction response");
      }
    },
  };
  return { database, queryInputs, records };
}

export function fixture() {
  const timestamp = new Date("2026-07-22T00:00:00.000Z");
  const run = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: id(5),
        agentReleaseId: id(6),
        attempt: 1,
        captureMode: "metadata-only" as const,
        claimedAt: timestamp.toISOString(),
        claimedBy: "worker-paused",
        createdAt: timestamp.toISOString(),
        environmentId: id(3),
        executor: "hosted",
        heartbeatAt: timestamp.toISOString(),
        id: id(10),
        idempotencyKey: "run/request-1",
        organizationId: id(1),
        priority: 1,
        projectId: id(2),
        redactionPolicyVersion: 1 as const,
        schemaVersion: 1 as const,
        spanId: "0123456789abcdef",
        startedAt: timestamp.toISOString(),
        status: "waiting-for-approval" as const,
        threadId: id(8),
        trigger: "api",
        traceId: "0123456789abcdef0123456789abcdef",
        updatedAt: timestamp.toISOString(),
        userMessageId: id(9),
        userMessageSequence: 7,
        version: 2,
      },
      itemType: "run" as const,
    }),
  );
  const action = {
    approvalId: id(11),
    effect: "write" as const,
    idempotencyKey: "tool/deploy-1",
    input: { environment: "staging" },
    inputSummary: "Deploy to staging.",
    kind: "approval" as const,
    policyReason: "Deployment requires approval.",
    requiredScopes: ["deploy:write"],
    toolCallId: id(12),
    toolName: "deployment.start",
  };
  const toolCall = pausedToolCallRecord({ action, now: timestamp, run });
  const approval = pendingApprovalRecord({ action, now: timestamp, run });
  const input: ResolveRunApprovalInput = {
    approvalId: approval.data.id,
    decision: "approved",
    environmentId: run.data.environmentId,
    organizationId: run.data.organizationId,
    projectId: run.data.projectId,
    resolvedByPrincipalId: id(13),
    runId: run.data.id,
    threadId: run.data.threadId,
  };
  return { approval, input, run, toolCall };
}

export function asyncFixture() {
  const approvalFixture = fixture();
  const run = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...approvalFixture.run.data,
        status: "waiting-for-tool" as const,
      },
      itemType: "run" as const,
    }),
  );
  const action = {
    effect: "write" as const,
    externalOperationId: "provider-operation-1",
    idempotencyKey: "tool/deploy-async-1",
    input: { environment: "staging" },
    inputSummary: "Deploy to staging asynchronously.",
    kind: "tool" as const,
    policyReason: "Allowed.",
    requiredScopes: ["deploy:write"],
    toolCallId: id(14),
    toolName: "deployment.start",
  };
  const toolCall = pausedToolCallRecord({
    action,
    now: new Date("2026-07-22T00:00:00.000Z"),
    run,
  });
  const input: ResolveRunToolResultInput = {
    environmentId: run.data.environmentId,
    externalOperationId: action.externalOperationId,
    organizationId: run.data.organizationId,
    outcome: "completed",
    outputSummary: "Deployment completed.",
    projectId: run.data.projectId,
    runId: run.data.id,
    threadId: run.data.threadId,
    toolCallId: toolCall.data.id,
  };
  return { input, run, toolCall };
}

export function dependencies(
  database: DynamoDatabaseService,
  options: {
    readonly failAppendOnce?: boolean;
    readonly failEnqueueOnce?: boolean;
    readonly onAppend?: () => void;
    readonly onEnqueue?: () => void;
  } = {},
) {
  let nextId = 100;
  let appendFailurePending = options.failAppendOnce ?? false;
  let enqueueFailurePending = options.failEnqueueOnce ?? false;
  const enqueued: ApprovalRunEnqueueInput[] = [];
  const events: Array<{
    readonly actor?: { readonly id?: string; readonly type: string };
    readonly eventType: string;
    readonly runId?: string;
  }> = [];
  return {
    dependencies: {
      appendThreadEvent: async (event: {
        readonly actor?: { readonly id?: string; readonly type: string };
        readonly eventType: string;
        readonly runId?: string;
      }) => {
        options.onAppend?.();
        if (appendFailurePending) {
          appendFailurePending = false;
          throw new Error("simulated stream publication failure");
        }
        events.push({
          ...(event.actor ? { actor: event.actor } : {}),
          eventType: event.eventType,
          ...(event.runId ? { runId: event.runId } : {}),
        });
      },
      database,
      enqueueRun: async (input: ApprovalRunEnqueueInput) => {
        options.onEnqueue?.();
        if (enqueueFailurePending) {
          enqueueFailurePending = false;
          throw new Error("simulated queue publication failure");
        }
        enqueued.push(input);
      },
      generateId: async () => id(nextId++),
      now: () => new Date("2026-07-22T00:01:00.000Z"),
    },
    enqueued,
    events,
  };
}

/** Simulates the worker claiming a resumed run: the run is running and holds the thread lease. */
export function claimResumedRun(
  records: Map<string, PlatformRecord>,
  resumed: RunRecordValue,
): void {
  const claimedAt = "2026-07-22T00:01:05.000Z";
  const owner = "worker:resumed";
  const running = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...resumed.data,
        claimedAt,
        claimedBy: owner,
        heartbeatAt: claimedAt,
        status: "running" as const,
        updatedAt: claimedAt,
        version: resumed.data.version + 1,
      },
      itemType: "run" as const,
    }),
  );
  const lease = Schema.decodeUnknownSync(RuntimeLeaseRecord)(
    withCanonicalRecordKeys({
      data: {
        acquiredAt: claimedAt,
        environmentId: resumed.data.environmentId,
        expiresAt: "2026-07-22T00:16:05.000Z",
        id: resumed.data.threadId,
        leaseKey: `agent-run-thread/${resumed.data.threadId}`,
        organizationId: resumed.data.organizationId,
        owner,
        projectId: resumed.data.projectId,
        runId: resumed.data.id,
        threadId: resumed.data.threadId,
        version: 0,
      },
      itemType: "runtime-lease" as const,
    }),
  );
  for (const record of [running, lease]) {
    records.set(storeKey(tableForItemType(record.itemType), record.pk, record.sk), record);
  }
}
