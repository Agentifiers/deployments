import {
  ApprovalRecord,
  RunRecord,
  TimelineEventRecord,
  ToolCallRecord,
  executionEventPayload,
  executionPinsPayload,
  isDatabaseWriteConflict,
  key,
  withCanonicalRecordKeys,
  workerPersistence,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { Schema } from "effect";
import { releaseStaleThreadExecutionLease } from "./agent-run-lease-release.ts";
import { runToolContinuation, type RunToolContinuation } from "./continuation.ts";

type RunRecordValue = Extract<PlatformRecord, { readonly itemType: "run" }>;
type ApprovalRecordValue = Extract<PlatformRecord, { readonly itemType: "approval" }>;
type ToolCallRecordValue = Extract<PlatformRecord, { readonly itemType: "tool-call" }>;
type TimelineEventRecordValue = Extract<PlatformRecord, { readonly itemType: "timeline-event" }>;

export type RuntimeMutationPublicationType =
  | "runtime-api.cancel-publication"
  | "runtime-api.replay-publication"
  | "runtime-api.retry-publication";

export class RunMutationError extends Error {
  constructor(
    readonly code: "run_not_replayable" | "run_state_conflict" | "run_terminal",
    message: string,
  ) {
    super(message);
    this.name = "RunMutationError";
  }
}

export interface RunMutationDependencies {
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Promise<Ulid>;
  readonly now?: () => Date;
}

export type RunCancellation = Readonly<{
  approval?: ApprovalRecordValue;
  publication?: TimelineEventRecordValue;
  snapshot: RunRecordValue;
  toolCall?: ToolCallRecordValue;
}>;

const MAX_CANCEL_RUN_ATTEMPTS = 3;

function conflict(message: string): never {
  throw new RunMutationError("run_state_conflict", message);
}

function inRunScope<T extends ApprovalRecordValue | ToolCallRecordValue>(
  record: T,
  run: RunRecordValue,
): T {
  if (
    record.data.organizationId !== run.data.organizationId ||
    record.data.projectId !== run.data.projectId ||
    record.data.environmentId !== run.data.environmentId
  ) {
    conflict(`Run ${record.itemType} is outside the run's scope.`);
  }
  return record;
}

async function readExecution(database: DynamoDatabaseService, pk: string, sk: string) {
  return workerPersistence.read(database, "execution", { pk, sk }, true);
}

export function runQueueMessage(run: RunRecordValue) {
  if (run.data.userMessageId === undefined || run.data.userMessageSequence === undefined) {
    throw new RunMutationError("run_not_replayable", "Run has no replayable user message.");
  }
  return {
    environmentId: run.data.environmentId,
    idempotencyKey: run.data.idempotencyKey,
    organizationId: run.data.organizationId,
    projectId: run.data.projectId,
    runId: run.data.id,
    spanId: run.data.spanId,
    threadId: run.data.threadId,
    traceId: run.data.traceId,
    userMessageId: run.data.userMessageId,
    userMessageSequence: run.data.userMessageSequence,
  };
}

export function runEvent(run: RunRecordValue, eventId: Ulid, eventType: string, now: Date) {
  return makeSemanticEventRecord({
    aggregateId: run.data.id,
    aggregateType: "run",
    aggregateVersion: run.data.version + 1,
    environmentId: run.data.environmentId,
    eventId,
    eventType,
    occurredAt: now,
    organizationId: run.data.organizationId,
    payload: executionEventPayload(run.data, {
      status: run.data.status,
      threadId: run.data.threadId,
    }),
    projectId: run.data.projectId,
  });
}

export function runRequestedEvent(run: RunRecordValue, eventId: Ulid, now: Date) {
  const message = runQueueMessage(run);
  return makeSemanticEventRecord({
    aggregateId: eventId,
    aggregateType: "run-dispatch",
    aggregateVersion: 1,
    environmentId: run.data.environmentId,
    eventId,
    eventType: "run.requested",
    occurredAt: now,
    organizationId: run.data.organizationId,
    payload: executionEventPayload(run.data, {
      ...executionPinsPayload(run.data),
      dispatchId: eventId,
      idempotencyKey: run.data.idempotencyKey,
      runId: run.data.id,
      status: "queued",
      spanId: message.spanId,
      threadId: message.threadId,
      traceId: message.traceId,
      userMessageId: message.userMessageId,
      userMessageSequence: message.userMessageSequence,
    }),
    projectId: run.data.projectId,
  });
}

export function runtimeMutationPublication(
  run: RunRecordValue,
  id: Ulid,
  eventType: RuntimeMutationPublicationType,
  now: Date,
  data: Readonly<Record<string, string | number>>,
) {
  return Schema.decodeUnknownSync(TimelineEventRecord)(
    withCanonicalRecordKeys({
      data: {
        actor: { type: "service-account" as const },
        createdAt: now.toISOString(),
        data: { ...data, runSnapshot: JSON.stringify(run) },
        environmentId: run.data.environmentId,
        eventType,
        id,
        organizationId: run.data.organizationId,
        projectId: run.data.projectId,
        runId: run.data.id,
        sequence: run.data.version,
        threadId: run.data.threadId,
      },
      itemType: "timeline-event" as const,
    }),
  );
}

export async function loadRuntimeMutationPublication(
  database: DynamoDatabaseService,
  run: RunRecordValue,
  eventType: RuntimeMutationPublicationType,
) {
  let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
  const publications: TimelineEventRecordValue[] = [];
  do {
    const page = await workerPersistence.find(database, "execution", {
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      ConsistentRead: true,
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: {
        ":pk": key("ORG", run.data.organizationId, "RUN", run.data.id),
        ":prefix": "TIMELINE-EVENT#",
      },
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
      Limit: 100,
      ScanIndexForward: false,
    });
    publications.push(
      ...page.items.filter(
        (record): record is TimelineEventRecordValue =>
          record.itemType === "timeline-event" &&
          record.data.runId === run.data.id &&
          record.data.eventType === eventType,
      ),
    );
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (publications.length === 0 && exclusiveStartKey);
  return publications.toSorted(
    (left, right) =>
      right.data.sequence - left.data.sequence ||
      right.data.createdAt.localeCompare(left.data.createdAt),
  )[0];
}

export function publicationRunSnapshot(publication: TimelineEventRecordValue): RunRecordValue {
  const encoded = publication.data.data?.runSnapshot;
  try {
    if (typeof encoded !== "string") throw new Error("Run snapshot is missing.");
    const snapshot = Schema.decodeUnknownSync(RunRecord)(JSON.parse(encoded));
    if (
      snapshot.data.id !== publication.data.runId ||
      snapshot.data.threadId !== publication.data.threadId ||
      snapshot.data.version !== publication.data.sequence ||
      snapshot.data.organizationId !== publication.data.organizationId
    ) {
      throw new Error("Run snapshot does not match its publication marker.");
    }
    return snapshot;
  } catch {
    return conflict("Run mutation publication state could not be reconciled.");
  }
}

export async function matchingRunThreadExecutionLease(
  database: DynamoDatabaseService,
  run: RunRecordValue,
) {
  const leaseValue = await readExecution(
    database,
    key("RUNTIME-LEASE", run.data.threadId),
    key("RUNTIME-LEASE", `agent-run-thread/${run.data.threadId}`),
  );
  if (!leaseValue) return undefined;
  if (leaseValue.itemType !== "runtime-lease") conflict("Thread execution lease is invalid.");
  return leaseValue.data.runId === run.data.id ? leaseValue : undefined;
}

export async function recoveredRunCancellation(
  database: DynamoDatabaseService,
  run: RunRecordValue,
): Promise<RunCancellation> {
  const publication = await loadRuntimeMutationPublication(
    database,
    run,
    "runtime-api.cancel-publication",
  );
  if (!publication) return { snapshot: run };
  const snapshot = publicationRunSnapshot(publication);
  const data = publication.data.data;
  const approvalId = typeof data?.approvalId === "string" ? data.approvalId : undefined;
  const toolCallId = typeof data?.toolCallId === "string" ? data.toolCallId : undefined;
  const partition = key("ORG", run.data.organizationId, "RUN", run.data.id);
  const [approvalValue, toolCallValue] = await Promise.all([
    approvalId ? readExecution(database, partition, key("APPROVAL", approvalId)) : undefined,
    toolCallId ? readExecution(database, partition, key("TOOL-CALL", toolCallId)) : undefined,
  ]);
  const approval =
    approvalValue?.itemType === "approval" &&
    approvalValue.data.runId === run.data.id &&
    approvalValue.data.status === "rejected"
      ? inRunScope(approvalValue, run)
      : undefined;
  const toolCall =
    toolCallValue?.itemType === "tool-call" &&
    toolCallValue.data.runId === run.data.id &&
    toolCallValue.data.status === "failed"
      ? inRunScope(toolCallValue, run)
      : undefined;
  if ((approvalId && !approval) || (toolCallId && !toolCall)) {
    conflict("Canceled run publication state could not be reconciled.");
  }
  return {
    publication,
    snapshot,
    ...(approval ? { approval } : {}),
    ...(toolCall ? { toolCall } : {}),
  };
}

async function cancelRunAttempt(
  dependencies: RunMutationDependencies,
  actorId: Ulid,
  previous: RunRecordValue,
): Promise<RunCancellation> {
  const { database } = dependencies;
  if (["canceled", "completed", "failed"].includes(previous.data.status)) {
    if (previous.data.status === "canceled") return recoveredRunCancellation(database, previous);
    throw new RunMutationError("run_terminal", "Completed or failed runs cannot be canceled.");
  }
  const now = dependencies.now?.() ?? new Date();
  const {
    claimedAt: _claimedAt,
    claimedBy: _claimedBy,
    heartbeatAt: _heartbeatAt,
    ...unclaimed
  } = previous.data;
  const { toolContinuation: _toolContinuation, ...unclaimedWithoutTool } = unclaimed;
  const data =
    previous.data.status === "running"
      ? previous.data
      : previous.data.status === "waiting-for-tool"
        ? unclaimed
        : unclaimedWithoutTool;
  const replacement = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      ...previous,
      data: {
        ...data,
        completedAt: now.toISOString(),
        status: "canceled" as const,
        updatedAt: now.toISOString(),
        version: previous.data.version + 1,
      },
    }),
  );
  const executionLease = await matchingRunThreadExecutionLease(database, previous);
  const operations: TransactionOperation[] = [
    ...(executionLease ? [releaseStaleThreadExecutionLease(executionLease)] : []),
    { kind: "put", previousRecord: previous, record: replacement },
  ];
  const cancellationEventId = await dependencies.generateId();
  const terminalDispatchEventId =
    replacement.data.userMessageId !== undefined &&
    replacement.data.userMessageSequence !== undefined
      ? await dependencies.generateId()
      : undefined;
  const events = [
    runEvent(replacement, cancellationEventId, "run.canceled", now),
    ...(terminalDispatchEventId
      ? [runRequestedEvent(replacement, terminalDispatchEventId, now)]
      : []),
  ];
  let transitionedApproval: ApprovalRecordValue | undefined;
  let transitionedToolCall: ToolCallRecordValue | undefined;
  const runAggregatePk = key("ORG", previous.data.organizationId, "RUN", previous.data.id);
  if (previous.data.status === "waiting-for-approval") {
    let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
    const pendingApprovals: ApprovalRecordValue[] = [];
    do {
      const page = await workerPersistence.find(database, "execution", {
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        ConsistentRead: true,
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": runAggregatePk,
          ":prefix": "APPROVAL#",
        },
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
        Limit: 100,
      });
      pendingApprovals.push(
        ...page.items.filter(
          (record): record is ApprovalRecordValue =>
            record.itemType === "approval" && record.data.status === "pending",
        ),
      );
      exclusiveStartKey = page.lastEvaluatedKey;
    } while (exclusiveStartKey);
    if (pendingApprovals.length !== 1) {
      conflict("Run approval state could not be reconciled for cancellation.");
    }
    const pendingApproval = inRunScope(pendingApprovals[0]!, previous);
    if (!pendingApproval.data.toolCallId) conflict("Run approval is not bound to a tool call.");
    const pendingToolCall = await readExecution(
      database,
      runAggregatePk,
      key("TOOL-CALL", pendingApproval.data.toolCallId),
    );
    if (
      !pendingToolCall ||
      pendingToolCall.itemType !== "tool-call" ||
      pendingToolCall.data.status !== "waiting" ||
      pendingToolCall.data.approvalId !== pendingApproval.data.id
    ) {
      conflict("Run tool-call state could not be reconciled for cancellation.");
    }
    const approval = Schema.decodeUnknownSync(ApprovalRecord)(
      withCanonicalRecordKeys({
        ...pendingApproval,
        data: {
          ...pendingApproval.data,
          resolvedAt: now.toISOString(),
          resolvedByPrincipalId: actorId,
          status: "rejected" as const,
          updatedAt: now.toISOString(),
          version: pendingApproval.data.version + 1,
        },
      }),
    );
    const toolCall = Schema.decodeUnknownSync(ToolCallRecord)(
      withCanonicalRecordKeys({
        ...pendingToolCall,
        data: {
          ...pendingToolCall.data,
          completedAt: now.toISOString(),
          outputSummary: "Run canceled while awaiting tool approval.",
          status: "failed" as const,
          updatedAt: now.toISOString(),
          version: pendingToolCall.data.version + 1,
        },
      }),
    );
    transitionedApproval = approval;
    transitionedToolCall = toolCall;
    operations.push(
      { kind: "put", previousRecord: pendingApproval, record: approval },
      { kind: "put", previousRecord: pendingToolCall, record: toolCall },
    );
    events.push(
      makeSemanticEventRecord({
        aggregateId: approval.data.id,
        aggregateType: "approval",
        aggregateVersion: approval.data.version + 1,
        environmentId: approval.data.environmentId,
        eventId: await dependencies.generateId(),
        eventType: "approval.resolved",
        occurredAt: now,
        organizationId: approval.data.organizationId,
        payload: executionEventPayload(previous.data, {
          approvalId: approval.data.id,
          decision: "rejected",
          runId: approval.data.runId,
          status: approval.data.status,
          toolCallId: toolCall.data.id,
        }),
        projectId: approval.data.projectId,
      }),
      makeSemanticEventRecord({
        aggregateId: toolCall.data.id,
        aggregateType: "tool-call",
        aggregateVersion: toolCall.data.version + 1,
        environmentId: toolCall.data.environmentId,
        eventId: await dependencies.generateId(),
        eventType: "tool-call.failed",
        occurredAt: now,
        organizationId: toolCall.data.organizationId,
        payload: executionEventPayload(previous.data, {
          approvalId: approval.data.id,
          runId: toolCall.data.runId,
          status: toolCall.data.status,
          toolCallId: toolCall.data.id,
          toolName: toolCall.data.toolName,
        }),
        projectId: toolCall.data.projectId,
      }),
    );
  } else if (previous.data.status === "waiting-for-tool") {
    let pendingAction: RunToolContinuation["pendingAction"];
    try {
      pendingAction = runToolContinuation(previous).pendingAction;
    } catch (cause) {
      conflict(
        cause instanceof Error
          ? cause.message
          : "Run tool continuation could not be reconciled for cancellation.",
      );
    }
    if (!pendingAction || pendingAction.kind !== "tool") {
      conflict("Waiting run has an invalid asynchronous tool continuation.");
    }
    const toolCallValue = await readExecution(
      database,
      runAggregatePk,
      key("TOOL-CALL", pendingAction.toolCallId),
    );
    if (
      !toolCallValue ||
      toolCallValue.itemType !== "tool-call" ||
      toolCallValue.data.runId !== previous.data.id ||
      toolCallValue.data.status !== "running"
    ) {
      conflict("Asynchronous tool state could not be reconciled for cancellation.");
    }
    inRunScope(toolCallValue, previous);
  } else if (previous.data.status === "queued") {
    let pendingAction: RunToolContinuation["pendingAction"];
    try {
      pendingAction = runToolContinuation(previous).pendingAction;
    } catch (cause) {
      conflict(
        cause instanceof Error
          ? cause.message
          : "Run tool continuation could not be reconciled for cancellation.",
      );
    }
    if (pendingAction) {
      if (pendingAction.kind !== "approval") {
        conflict("Queued run has an invalid pending tool continuation.");
      }
      const toolCallValue = await readExecution(
        database,
        runAggregatePk,
        key("TOOL-CALL", pendingAction.toolCallId),
      );
      if (
        !toolCallValue ||
        toolCallValue.itemType !== "tool-call" ||
        toolCallValue.data.status !== "pending" ||
        !toolCallValue.data.approvalId
      ) {
        conflict("Approved tool state could not be reconciled for cancellation.");
      }
      const pendingToolCall = inRunScope(toolCallValue, previous);
      const approvalValue = await readExecution(
        database,
        runAggregatePk,
        key("APPROVAL", toolCallValue.data.approvalId),
      );
      if (
        !approvalValue ||
        approvalValue.itemType !== "approval" ||
        approvalValue.data.status !== "approved" ||
        approvalValue.data.toolCallId !== pendingToolCall.data.id
      ) {
        conflict("Approved tool approval state could not be reconciled for cancellation.");
      }
      const approval = inRunScope(approvalValue, previous);
      const toolCall = Schema.decodeUnknownSync(ToolCallRecord)(
        withCanonicalRecordKeys({
          ...pendingToolCall,
          data: {
            ...pendingToolCall.data,
            completedAt: now.toISOString(),
            outputSummary: "Run canceled before approved tool execution.",
            status: "failed" as const,
            updatedAt: now.toISOString(),
            version: pendingToolCall.data.version + 1,
          },
        }),
      );
      transitionedToolCall = toolCall;
      operations.push({
        kind: "put",
        previousRecord: pendingToolCall,
        record: toolCall,
      });
      events.push(
        makeSemanticEventRecord({
          aggregateId: toolCall.data.id,
          aggregateType: "tool-call",
          aggregateVersion: toolCall.data.version + 1,
          environmentId: toolCall.data.environmentId,
          eventId: await dependencies.generateId(),
          eventType: "tool-call.failed",
          occurredAt: now,
          organizationId: toolCall.data.organizationId,
          payload: executionEventPayload(previous.data, {
            approvalId: approval.data.id,
            runId: toolCall.data.runId,
            status: toolCall.data.status,
            toolCallId: toolCall.data.id,
            toolName: toolCall.data.toolName,
          }),
          projectId: toolCall.data.projectId,
        }),
      );
    }
  }
  const publication = runtimeMutationPublication(
    replacement,
    cancellationEventId,
    "runtime-api.cancel-publication",
    now,
    {
      runVersion: replacement.data.version,
      ...(transitionedApproval ? { approvalId: transitionedApproval.data.id } : {}),
      ...(transitionedToolCall ? { toolCallId: transitionedToolCall.data.id } : {}),
    },
  );
  operations.push({
    conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    kind: "put",
    record: publication,
  });
  await transactWithSemanticEvents(database, operations, events);
  return {
    publication,
    snapshot: replacement,
    ...(transitionedApproval ? { approval: transitionedApproval } : {}),
    ...(transitionedToolCall ? { toolCall: transitionedToolCall } : {}),
  };
}

export async function cancelRun(
  dependencies: RunMutationDependencies,
  input: { readonly actorId: Ulid; readonly loadRun: () => Promise<RunRecordValue> },
): Promise<RunCancellation> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await cancelRunAttempt(dependencies, input.actorId, await input.loadRun());
    } catch (cause) {
      if (!isDatabaseWriteConflict(cause)) throw cause;
      if (attempt >= MAX_CANCEL_RUN_ATTEMPTS) {
        conflict("Run state changed while cancellation was being applied.");
      }
    }
  }
}
