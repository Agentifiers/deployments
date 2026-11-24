import {
  RunRecord,
  RunLookupRecord,
  Ulid,
  key,
  makeConversationPersistence,
  makeConversationTemporalContinuityPersistence,
  type ConversationContinuationScope,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  workerPersistence,
} from "@deployments-ai/db";
import {
  conversationMessageIsNonReplayable,
  conversationMessageIsTransient,
} from "@deployments-ai/conversations";
import { Schema } from "effect";
import { prefetch } from "./prefetch.ts";
import type {
  AgentDeploymentRecordValue,
  AgentReleaseRecordValue,
  AgentRunQueueMessage,
  ApprovalRecordValue,
  ConversationCheckpointRecordValue,
  MessageRecordValue,
  RunRecordValue,
  RunLookupRecordValue,
  ThreadRecordValue,
  TimelineEventRecordValue,
  ToolCallRecordValue,
} from "./types.ts";

export class AgentRunWorkerRecordError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentRunWorkerRecordError";
  }
}

export const MAX_INLINE_ASSISTANT_MESSAGE_BYTES = 256 * 1024;
export const MAX_RUNTIME_USAGE_ENTRIES = 32;

export function expectedRecord<ItemType extends PlatformRecord["itemType"]>(
  record: PlatformRecord | undefined,
  itemType: ItemType,
  label: string,
): Extract<PlatformRecord, { readonly itemType: ItemType }> {
  if (!record || record.itemType !== itemType) {
    throw new AgentRunWorkerRecordError("record_not_found", `${label} was not found.`);
  }
  return record as Extract<PlatformRecord, { readonly itemType: ItemType }>;
}

export async function getRecord(
  database: DynamoDatabaseService,
  table: "control" | "execution",
  recordKey: { readonly pk: string; readonly sk: string },
): Promise<PlatformRecord | undefined> {
  return workerPersistence.read(database, table, recordKey, true);
}

export function threadPartition(organizationId: Ulid, threadId: Ulid): string {
  return key("ORG", organizationId, "THREAD", threadId);
}

export function environmentPartition(organizationId: Ulid, environmentId: Ulid): string {
  return key("ORG", organizationId, "ENV", environmentId);
}

export async function loadRun(
  database: DynamoDatabaseService,
  message: AgentRunQueueMessage,
): Promise<RunRecordValue | undefined> {
  const record = await getRecord(database, "execution", {
    pk: threadPartition(message.organizationId, message.threadId),
    sk: key("RUN", message.idempotencyKey),
  });
  if (!record) return undefined;
  const run = expectedRecord(record, "run", "Run");
  if (
    run.data.id !== message.runId ||
    run.data.organizationId !== message.organizationId ||
    run.data.projectId !== message.projectId ||
    run.data.environmentId !== message.environmentId ||
    run.data.spanId !== message.spanId ||
    run.data.threadId !== message.threadId ||
    run.data.traceId !== message.traceId ||
    (run.data.userMessageId !== undefined && run.data.userMessageId !== message.userMessageId) ||
    (run.data.userMessageSequence !== undefined &&
      run.data.userMessageSequence !== message.userMessageSequence)
  ) {
    throw new AgentRunWorkerRecordError(
      "run_scope_mismatch",
      "Queue message scope does not match the persisted run.",
    );
  }
  return run;
}

export function runLookupRecord(run: RunRecordValue): RunLookupRecordValue {
  return Schema.decodeUnknownSync(RunLookupRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: run.data.createdAt,
        environmentId: run.data.environmentId,
        idempotencyKey: run.data.idempotencyKey,
        organizationId: run.data.organizationId,
        projectId: run.data.projectId,
        runId: run.data.id,
        threadId: run.data.threadId,
      },
      itemType: "run-lookup" as const,
    }),
  );
}

export async function loadRunLookup(
  database: DynamoDatabaseService,
  message: Pick<
    AgentRunQueueMessage,
    "environmentId" | "organizationId" | "projectId" | "threadId"
  >,
  runId: Ulid,
): Promise<RunLookupRecordValue | undefined> {
  const record = await getRecord(database, "execution", {
    pk: threadPartition(message.organizationId, message.threadId),
    sk: key("RUN-LOOKUP", runId),
  });
  if (!record) return undefined;
  const lookup = expectedRecord(record, "run-lookup", "Run lookup");
  if (
    lookup.data.runId !== runId ||
    lookup.data.organizationId !== message.organizationId ||
    lookup.data.projectId !== message.projectId ||
    lookup.data.environmentId !== message.environmentId ||
    lookup.data.threadId !== message.threadId
  ) {
    throw new AgentRunWorkerRecordError(
      "run_scope_mismatch",
      "Run lookup does not match the requested scope.",
    );
  }
  return lookup;
}

export async function loadThreadRunById(
  database: DynamoDatabaseService,
  message: Pick<
    AgentRunQueueMessage,
    "environmentId" | "organizationId" | "projectId" | "threadId"
  >,
  runId: Ulid,
): Promise<RunRecordValue | undefined> {
  const lookup = await loadRunLookup(database, message, runId);
  if (!lookup) return undefined;
  const record = await getRecord(database, "execution", {
    pk: threadPartition(message.organizationId, message.threadId),
    sk: key("RUN", lookup.data.idempotencyKey),
  });
  if (!record) {
    throw new AgentRunWorkerRecordError(
      "run_lookup_orphaned",
      `Run lookup ${runId} does not resolve to a canonical run.`,
    );
  }
  const run = expectedRecord(record, "run", "Run");
  if (
    run.data.id !== runId ||
    run.data.idempotencyKey !== lookup.data.idempotencyKey ||
    run.data.organizationId !== message.organizationId ||
    run.data.projectId !== message.projectId ||
    run.data.environmentId !== message.environmentId ||
    run.data.threadId !== message.threadId
  ) {
    throw new AgentRunWorkerRecordError(
      "run_scope_mismatch",
      "Run lookup does not match its canonical run.",
    );
  }
  return run;
}

export async function loadThread(
  database: DynamoDatabaseService,
  message: AgentRunQueueMessage,
): Promise<ThreadRecordValue> {
  const record = await getRecord(database, "execution", {
    pk: threadPartition(message.organizationId, message.threadId),
    sk: key("THREAD", message.threadId),
  });
  return expectedRecord(record, "thread", "Thread");
}

export async function loadAgentDeployment(
  database: DynamoDatabaseService,
  message: Pick<AgentRunQueueMessage, "environmentId" | "organizationId">,
  deploymentId: Ulid,
): Promise<AgentDeploymentRecordValue> {
  const record = await getRecord(database, "control", {
    pk: environmentPartition(message.organizationId, message.environmentId),
    sk: key("AGENT-DEPLOYMENT", deploymentId),
  });
  return expectedRecord(record, "agent-deployment", "Agent deployment");
}

export async function loadAgentRelease(
  database: DynamoDatabaseService,
  message: Pick<AgentRunQueueMessage, "environmentId" | "organizationId">,
  releaseId: Ulid,
): Promise<AgentReleaseRecordValue> {
  const record = await getRecord(database, "control", {
    pk: environmentPartition(message.organizationId, message.environmentId),
    sk: key("AGENT-RELEASE", releaseId),
  });
  return expectedRecord(record, "agent-release", "Agent release");
}

export const THREAD_MESSAGE_QUERY_LIMIT = 100;
export const MAX_CAUSAL_HISTORY_MESSAGES = 4_096;
export const MAX_CAUSAL_HISTORY_PAGES = 128;

export function scopedMessages(
  records: readonly PlatformRecord[],
  message: AgentRunQueueMessage,
): readonly MessageRecordValue[] {
  return records.filter(
    (record): record is MessageRecordValue =>
      record.itemType === "message" &&
      record.data.organizationId === message.organizationId &&
      record.data.projectId === message.projectId &&
      record.data.environmentId === message.environmentId &&
      record.data.threadId === message.threadId,
  );
}

export async function loadTriggerMessage(
  database: DynamoDatabaseService,
  message: Pick<
    AgentRunQueueMessage,
    | "environmentId"
    | "organizationId"
    | "projectId"
    | "threadId"
    | "userMessageId"
    | "userMessageSequence"
  >,
): Promise<MessageRecordValue | undefined> {
  const record = await getRecord(database, "execution", {
    pk: threadPartition(message.organizationId, message.threadId),
    sk: key(
      "MESSAGE",
      String(message.userMessageSequence).padStart(16, "0"),
      message.userMessageId,
    ),
  });
  if (!record) return undefined;
  const trigger = expectedRecord(record, "message", "Trigger message");
  if (
    trigger.data.id !== message.userMessageId ||
    trigger.data.sequence !== message.userMessageSequence ||
    trigger.data.organizationId !== message.organizationId ||
    trigger.data.projectId !== message.projectId ||
    trigger.data.environmentId !== message.environmentId ||
    trigger.data.threadId !== message.threadId
  ) {
    throw new AgentRunWorkerRecordError(
      "trigger_message_scope_mismatch",
      "Queue message scope does not match the persisted trigger message.",
    );
  }
  return trigger;
}

export function messageCharacterUpperBound(message: MessageRecordValue): number | undefined {
  return message.data.body?.length ?? message.data.bodyRef?.byteSize;
}

export async function loadCausalThreadMessages(
  database: DynamoDatabaseService,
  message: AgentRunQueueMessage,
  trigger: MessageRecordValue,
  maximumCharacters: number,
  checkpointMode: "auto" | "off" = "off",
  continuityScope?: ConversationContinuationScope,
): Promise<{
  readonly checkpoint?: ConversationCheckpointRecordValue;
  readonly priorMessages: readonly MessageRecordValue[];
}> {
  const persistence = makeConversationPersistence(database);
  const causalPage = (exclusiveStartKey?: Readonly<Record<string, unknown>>) =>
    persistence.causalMessagePage(message, {
      ...(exclusiveStartKey ? { exclusiveStartKey } : {}),
      limit: THREAD_MESSAGE_QUERY_LIMIT,
      maximumSortKey: trigger.sk,
    });
  const firstPage = maximumCharacters > 0 ? prefetch(causalPage()) : undefined;
  const checkpoint =
    checkpointMode === "auto" && trigger.data.sequence > 0
      ? await persistence.latestCheckpoint(
          { organizationId: message.organizationId, threadId: message.threadId },
          trigger.data.sequence - 1,
        )
      : undefined;
  if (!firstPage) {
    return {
      ...(checkpoint ? { checkpoint } : {}),
      priorMessages: [],
    };
  }
  const priorDescending: MessageRecordValue[] = [];
  let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
  let budgetReached = false;
  let selectedCharacters = 0;
  let pages = 0;
  do {
    pages += 1;
    const result = await (pages === 1 ? firstPage : causalPage(exclusiveStartKey));
    for (const candidate of scopedMessages(result.items, message)) {
      if (candidate.data.sequence >= trigger.data.sequence) continue;
      if (
        conversationMessageIsTransient(candidate.data.metadata) ||
        conversationMessageIsNonReplayable(candidate.data.metadata)
      ) {
        continue;
      }
      if (priorDescending.length >= MAX_CAUSAL_HISTORY_MESSAGES) {
        budgetReached = true;
        break;
      }
      priorDescending.push(candidate);
      selectedCharacters += messageCharacterUpperBound(candidate) ?? maximumCharacters;
      if (selectedCharacters >= maximumCharacters) {
        budgetReached = true;
        break;
      }
      if (priorDescending.length === MAX_CAUSAL_HISTORY_MESSAGES) {
        budgetReached = true;
        break;
      }
    }
    exclusiveStartKey = result.lastEvaluatedKey;
  } while (exclusiveStartKey && !budgetReached && pages < MAX_CAUSAL_HISTORY_PAGES);
  if (exclusiveStartKey && !budgetReached) {
    throw new AgentRunWorkerRecordError(
      "causal_history_scan_limit",
      `Causal thread history exceeded the ${MAX_CAUSAL_HISTORY_PAGES}-page scan limit.`,
    );
  }
  const predecessors =
    continuityScope &&
    selectedCharacters < maximumCharacters &&
    priorDescending.length < MAX_CAUSAL_HISTORY_MESSAGES &&
    pages < MAX_CAUSAL_HISTORY_PAGES
      ? await makeConversationTemporalContinuityPersistence(
          database,
        ).recentReplayablePredecessorMessages(
          {
            ...continuityScope,
            organizationId: message.organizationId,
            projectId: message.projectId,
            environmentId: message.environmentId,
            threadId: message.threadId,
          },
          {
            maximumCharacters: maximumCharacters - selectedCharacters,
            maximumMessages: MAX_CAUSAL_HISTORY_MESSAGES - priorDescending.length,
            maximumPages: MAX_CAUSAL_HISTORY_PAGES - pages,
            throughCreatedAt: trigger.data.createdAt,
          },
        )
      : [];
  return {
    ...(checkpoint &&
    checkpoint.data.organizationId === message.organizationId &&
    checkpoint.data.projectId === message.projectId &&
    checkpoint.data.environmentId === message.environmentId &&
    checkpoint.data.threadId === message.threadId
      ? { checkpoint }
      : {}),
    priorMessages: [...predecessors, ...priorDescending.reverse()],
  };
}

export async function loadFinalizedMessageForRun(
  database: DynamoDatabaseService,
  message: AgentRunQueueMessage,
  run: RunRecordValue,
): Promise<MessageRecordValue | undefined> {
  const timeline = await loadRunTimelineEvent(database, run);
  if (!timeline || timeline.data.eventType !== "run.completed") return undefined;
  const data = timeline.data.data;
  const rawMessageId = data?.messageId;
  const messageSequence = data?.messageSequence;
  let messageId: Ulid;
  try {
    messageId = Schema.decodeUnknownSync(Ulid)(rawMessageId);
  } catch {
    throw new AgentRunWorkerRecordError(
      "invalid_finalized_message_reference",
      `Completed run ${run.data.id} timeline messageId must be a canonical ULID.`,
    );
  }
  if (
    typeof messageSequence !== "number" ||
    !Number.isSafeInteger(messageSequence) ||
    messageSequence < 0
  ) {
    throw new AgentRunWorkerRecordError(
      "invalid_finalized_message_reference",
      `Completed run ${run.data.id} timeline messageSequence must be a non-negative safe integer.`,
    );
  }
  const record = await getRecord(database, "execution", {
    pk: threadPartition(message.organizationId, message.threadId),
    sk: key("MESSAGE", String(messageSequence).padStart(16, "0"), messageId),
  });
  if (!record) return undefined;
  const finalized = expectedRecord(record, "message", "Finalized assistant message");
  if (
    finalized.data.id !== messageId ||
    finalized.data.sequence !== messageSequence ||
    finalized.data.role !== "assistant" ||
    finalized.data.runId !== run.data.id ||
    finalized.data.organizationId !== message.organizationId ||
    finalized.data.projectId !== message.projectId ||
    finalized.data.environmentId !== message.environmentId ||
    finalized.data.threadId !== message.threadId
  ) {
    throw new AgentRunWorkerRecordError(
      "finalized_message_scope_mismatch",
      `Completed run ${run.data.id} finalized message does not match its timeline reference.`,
    );
  }
  return finalized;
}

export async function loadRunTimelineEvent(
  database: DynamoDatabaseService,
  run: RunRecordValue,
): Promise<TimelineEventRecordValue | undefined> {
  const sequence = String(run.data.version).padStart(16, "0");
  const result = await workerPersistence.find(database, "execution", {
    ConsistentRead: true,
    ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
    ExpressionAttributeValues: {
      ":pk": key("ORG", run.data.organizationId, "RUN", run.data.id),
      ":prefix": key("TIMELINE-EVENT", sequence),
    },
    KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
    Limit: 2,
  });
  const matches = result.items.filter(
    (record): record is TimelineEventRecordValue =>
      record.itemType === "timeline-event" &&
      record.data.organizationId === run.data.organizationId &&
      record.data.projectId === run.data.projectId &&
      record.data.environmentId === run.data.environmentId &&
      record.data.threadId === run.data.threadId &&
      record.data.runId === run.data.id &&
      record.data.sequence === run.data.version,
  );
  if (matches.length > 1) {
    throw new AgentRunWorkerRecordError(
      "ambiguous_run_timeline",
      `Run ${run.data.id} has multiple timeline events for version ${run.data.version}.`,
    );
  }
  return matches[0];
}

export async function loadRunToolCall(
  database: DynamoDatabaseService,
  run: RunRecordValue,
  toolCallId: Ulid,
): Promise<ToolCallRecordValue | undefined> {
  const record = await getRecord(database, "execution", {
    pk: key("ORG", run.data.organizationId, "RUN", run.data.id),
    sk: key("TOOL-CALL", toolCallId),
  });
  if (!record) return undefined;
  const toolCall = expectedRecord(record, "tool-call", "Tool call");
  if (
    toolCall.data.id !== toolCallId ||
    toolCall.data.organizationId !== run.data.organizationId ||
    toolCall.data.projectId !== run.data.projectId ||
    toolCall.data.environmentId !== run.data.environmentId ||
    toolCall.data.runId !== run.data.id
  ) {
    throw new AgentRunWorkerRecordError(
      "tool_call_scope_mismatch",
      `Tool call ${toolCallId} does not match run ${run.data.id}.`,
    );
  }
  return toolCall;
}

export async function loadRunApproval(
  database: DynamoDatabaseService,
  run: RunRecordValue,
  approvalId: Ulid,
): Promise<ApprovalRecordValue | undefined> {
  const record = await getRecord(database, "execution", {
    pk: key("ORG", run.data.organizationId, "RUN", run.data.id),
    sk: key("APPROVAL", approvalId),
  });
  if (!record) return undefined;
  const approval = expectedRecord(record, "approval", "Approval");
  if (
    approval.data.id !== approvalId ||
    approval.data.organizationId !== run.data.organizationId ||
    approval.data.projectId !== run.data.projectId ||
    approval.data.environmentId !== run.data.environmentId ||
    approval.data.runId !== run.data.id
  ) {
    throw new AgentRunWorkerRecordError(
      "approval_scope_mismatch",
      `Approval ${approvalId} does not match run ${run.data.id}.`,
    );
  }
  return approval;
}

export function runningRun(
  previous: RunRecordValue,
  workerId: string,
  now: Date,
  triggerMessage: { readonly id: Ulid; readonly sequence: number },
  executionSlot: number,
): RunRecordValue {
  if (
    (previous.data.userMessageId !== undefined &&
      previous.data.userMessageId !== triggerMessage.id) ||
    (previous.data.userMessageSequence !== undefined &&
      previous.data.userMessageSequence !== triggerMessage.sequence)
  ) {
    throw new AgentRunWorkerRecordError(
      "trigger_message_scope_mismatch",
      `Run ${previous.data.id} is already bound to another trigger message.`,
    );
  }
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...previous.data,
        attempt: previous.data.attempt + 1,
        claimedAt: now.toISOString(),
        claimedBy: workerId,
        executionSlot,
        heartbeatAt: now.toISOString(),
        startedAt: previous.data.startedAt ?? now.toISOString(),
        status: "running" as const,
        updatedAt: now.toISOString(),
        userMessageId: triggerMessage.id,
        userMessageSequence: triggerMessage.sequence,
        version: previous.data.version + 1,
      },
      itemType: "run" as const,
    }),
  );
}

export function heartbeatRun(
  previous: RunRecordValue,
  workerId: string,
  now: Date,
): RunRecordValue {
  if (previous.data.status !== "running" || previous.data.claimedBy !== workerId) {
    throw new AgentRunWorkerRecordError(
      "run_claim_lost",
      "Run heartbeat cannot renew a claim owned by another worker.",
    );
  }
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...previous.data,
        heartbeatAt: now.toISOString(),
        updatedAt: now.toISOString(),
        version: previous.data.version + 1,
      },
      itemType: "run" as const,
    }),
  );
}

export function retryableRun(
  previous: RunRecordValue,
  now: Date,
  checkpointCount?: number,
): RunRecordValue {
  const {
    claimedAt: _claimedAt,
    claimedBy: _claimedBy,
    heartbeatAt: _heartbeatAt,
    ...data
  } = previous.data;
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...data,
        ...(checkpointCount !== undefined ? { checkpointCount } : {}),
        queuedAt: now.toISOString(),
        status: "queued" as const,
        updatedAt: now.toISOString(),
        version: previous.data.version + 1,
      },
      itemType: "run" as const,
    }),
  );
}

export function settledCanceledRun(previous: RunRecordValue, now: Date): RunRecordValue {
  if (previous.data.status !== "canceled") {
    throw new AgentRunWorkerRecordError(
      "run_state_conflict",
      "Only a canceled run can settle an external cancellation.",
    );
  }
  const {
    claimedAt: _claimedAt,
    claimedBy: _claimedBy,
    heartbeatAt: _heartbeatAt,
    ...data
  } = previous.data;
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...data,
        updatedAt: now.toISOString(),
        version: previous.data.version + 1,
      },
      itemType: "run" as const,
    }),
  );
}

export function terminalRun(
  previous: RunRecordValue,
  status: "canceled" | "completed" | "failed" | "waiting-for-approval" | "waiting-for-tool",
  now: Date,
  error?: string,
  errorCode?: string,
): RunRecordValue {
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...previous.data,
        ...(status === "completed" || status === "canceled" || status === "failed"
          ? { completedAt: now.toISOString() }
          : {}),
        ...(error ? { error: { ...(errorCode ? { code: errorCode } : {}), message: error } } : {}),
        heartbeatAt: now.toISOString(),
        status,
        updatedAt: now.toISOString(),
        version: previous.data.version + 1,
      },
      itemType: "run" as const,
    }),
  );
}
