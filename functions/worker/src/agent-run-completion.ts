/* eslint-disable no-await-in-loop -- Worker transitions and stream events are ordered side effects. */

import { validateStructuredResponse } from "@deployments-ai/agent-manifest";
import {
  type RuntimeCompletedToolCall,
  type RuntimeBrainEvidenceContextItem,
  type RuntimeModelInvocationAttempt,
  type RuntimePendingAction,
  type RuntimeUsageEntry,
} from "@deployments-ai/agent-runtime";
import {
  internalSemanticEventPayload,
  makeSemanticEventRecord,
  transactWithSemanticEvents,
} from "@deployments-ai/events";
import { DEFAULT_DURABLE_STREAM_MAX_APPEND_BATCH_BYTES } from "@deployments-ai/streaming";
import {
  ToolCallRecord,
  Ulid,
  executionEventPayload,
  executionPinsPayload,
  withCanonicalRecordKeys,
  type TransactionOperation,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import {
  advancedThread,
  assistantMessageRecord,
  completedToolCallRecord,
  loadRun,
  loadRunToolCall,
  loadThread,
  MAX_INLINE_ASSISTANT_MESSAGE_BYTES,
  pausedToolCallRecord,
  pendingApprovalRecord,
  terminalRun,
  timelineRecord,
  AgentRunWorkerRecordError,
} from "./records.ts";
import type {
  AgentRunQueueMessage,
  AgentRunWorkerDependencies,
  MessageRecordValue,
  RunRecordValue,
  ThreadRecordValue,
  ToolCallRecordValue,
} from "./types.ts";
import { runToolContinuation, withRunToolContinuation } from "./continuation.ts";
import {
  CompletionNotCommittedError,
  MAX_COMPLETION_ATTEMPTS,
  inlineFinalizedMessageAppendBytes,
  now,
  pendingActionCorrelation,
  stableCompletionMessageId,
  validateThreadPin,
} from "./agent-run-input.ts";
import {
  nonReplayableConversationMessageMetadata,
  conversationMessageIsTransient,
  transientConversationMessageMetadata,
} from "@deployments-ai/conversations";
import type {
  CompletedRunPlan,
  CompletedToolCallPersistence,
  RuntimeLeaseRecordValue,
} from "./agent-run-input.ts";
import { requireThreadExecutionLease } from "./agent-run-lease.ts";
import { runtimeUsageOperations } from "./agent-run-claim.ts";
import { finalizedMessageForRun } from "./agent-run-terminal.ts";
import { channelResponsePersistence } from "./channel-response.ts";
import { modelInvocationPersistenceOperations } from "./model-invocations.ts";
import { generationReasoningPersistence } from "./generation-reasoning.ts";

export async function completedToolCallPersistence(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  calls: readonly RuntimeCompletedToolCall[],
  timestamp: Date,
): Promise<CompletedToolCallPersistence> {
  const idempotencyKeys = new Set<string>();
  const toolCallIds = new Set<Ulid>();
  const operations: TransactionOperation[] = [];
  const events: ReturnType<typeof makeSemanticEventRecord>[] = [];
  for (const call of calls) {
    if (idempotencyKeys.has(call.idempotencyKey) || toolCallIds.has(call.toolCallId)) {
      throw new AgentRunWorkerRecordError(
        "invalid_completed_tool_calls",
        "Completed tool calls must have unique IDs and idempotency keys.",
      );
    }
    idempotencyKeys.add(call.idempotencyKey);
    toolCallIds.add(call.toolCallId);
    const previous = await loadRunToolCall(dependencies.database, run, call.toolCallId);
    const record = completedToolCallRecord({
      call,
      now: timestamp,
      ...(previous ? { previous } : {}),
      run,
    });
    if (record === previous) continue;
    operations.push(
      previous
        ? { kind: "put", previousRecord: previous, record }
        : {
            conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            kind: "put",
            record,
          },
    );
    events.push(
      makeSemanticEventRecord({
        aggregateId: record.data.id,
        aggregateType: "tool-call",
        aggregateVersion: record.data.version + 1,
        environmentId: record.data.environmentId,
        eventId: await dependencies.generateId(),
        eventType: "tool-call.completed",
        occurredAt: timestamp,
        organizationId: record.data.organizationId,
        payload: executionEventPayload(run.data, {
          ...(record.data.approvalId ? { approvalId: record.data.approvalId } : {}),
          ...(record.data.externalOperationId
            ? { externalOperationId: record.data.externalOperationId }
            : {}),
          runId: record.data.runId,
          status: record.data.status,
          toolCallId: record.data.id,
          toolName: record.data.toolName,
        }),
        projectId: record.data.projectId,
      }),
    );
  }
  return { events, operations };
}

export async function terminalApprovedToolPersistence(input: {
  readonly completedToolCalls: readonly RuntimeCompletedToolCall[];
  readonly dependencies: AgentRunWorkerDependencies;
  readonly outputSummary: string;
  readonly pendingAction?: RuntimePendingAction;
  readonly previousRun: RunRecordValue;
  readonly timestamp: Date;
}): Promise<CompletedToolCallPersistence> {
  const pending = runToolContinuation(input.previousRun).pendingAction;
  if (!pending || pending.kind !== "approval") return { events: [], operations: [] };
  if (input.completedToolCalls.some((call) => call.toolCallId === pending.toolCallId)) {
    return { events: [], operations: [] };
  }
  if (
    input.pendingAction?.kind === "tool" &&
    input.pendingAction.toolCallId === pending.toolCallId
  ) {
    return { events: [], operations: [] };
  }
  const previous = await loadRunToolCall(
    input.dependencies.database,
    input.previousRun,
    pending.toolCallId,
  );
  if (
    !previous?.data.approvalId ||
    previous.data.policyAction !== "require-approval" ||
    previous.data.status !== "pending"
  ) {
    throw new AgentRunWorkerRecordError(
      "invalid_tool_continuation",
      "Approved tool continuation is not a canonical pending tool call.",
    );
  }
  const timestamp = input.timestamp.toISOString();
  const toolCall: ToolCallRecordValue = Schema.decodeUnknownSync(ToolCallRecord)(
    withCanonicalRecordKeys({
      data: {
        ...previous.data,
        completedAt: timestamp,
        outputSummary: input.outputSummary,
        status: "failed" as const,
        updatedAt: timestamp,
        version: previous.data.version + 1,
      },
      itemType: "tool-call" as const,
    }),
  );
  const event = makeSemanticEventRecord({
    aggregateId: toolCall.data.id,
    aggregateType: "tool-call",
    aggregateVersion: toolCall.data.version + 1,
    environmentId: toolCall.data.environmentId,
    eventId: await input.dependencies.generateId(),
    eventType: "tool-call.failed",
    occurredAt: input.timestamp,
    organizationId: toolCall.data.organizationId,
    payload: executionEventPayload(input.previousRun.data, {
      ...(toolCall.data.approvalId ? { approvalId: toolCall.data.approvalId } : {}),
      runId: toolCall.data.runId,
      status: toolCall.data.status,
      toolCallId: toolCall.data.id,
      toolName: toolCall.data.toolName,
    }),
    projectId: toolCall.data.projectId,
  });
  return {
    events: [event],
    operations: [{ kind: "put", previousRecord: previous, record: toolCall }],
  };
}

export async function prepareCompletedRun(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  body: string,
  completedToolCalls: readonly RuntimeCompletedToolCall[],
  brainEvidence: readonly RuntimeBrainEvidenceContextItem[],
  usage: readonly RuntimeUsageEntry[],
  signal?: AbortSignal,
): Promise<CompletedRunPlan> {
  const brainToolCalls = completedToolCalls.filter(
    (call) =>
      call.toolName === "agent.brain.search" ||
      call.toolName === "agent.brain.ask" ||
      call.toolName === "agent.brain.get_document" ||
      call.toolName === "agent.brain.get_entity",
  );
  const hasBrainEvidence = brainToolCalls.length > 0 || brainEvidence.length > 0;
  if (hasBrainEvidence && !dependencies.prepareBrainPublication) {
    throw new AgentRunWorkerRecordError(
      "brain_publication_unavailable",
      "Brain-derived output requires a disclosure-revalidating private publication adapter.",
    );
  }
  // Validate the private model payload, not the safe artifact pointer published to history.
  if (run.data.responseFormat) validateStructuredResponse(body, run.data.responseFormat);
  const brainPublication = hasBrainEvidence
    ? await dependencies.prepareBrainPublication!({
        body,
        brainEvidence,
        brainToolCalls,
        run,
        ...(signal ? { signal } : {}),
      })
    : undefined;
  const publishableBody = brainPublication?.body ?? body;
  // Automation results remain provisional until an external channel confirms delivery. A
  // confirmed result is published later as a separate visible message; suppressed results stay
  // out of model history instead of becoming assistant-only turns that the model imitates.
  const transientAutomationOutput =
    run.data.trigger === "heartbeat" ||
    run.data.trigger === "schedule" ||
    run.data.responsePublication === "external";
  const protectedMessageMetadata = hasBrainEvidence
    ? nonReplayableConversationMessageMetadata(brainPublication?.messageMetadata)
    : brainPublication?.messageMetadata;
  const messageMetadata = transientAutomationOutput
    ? transientConversationMessageMetadata(protectedMessageMetadata)
    : protectedMessageMetadata;
  const timestamp = now(dependencies);
  const plannedRun = terminalRun(run, "completed", timestamp);
  const streamEventId = await dependencies.generateId();
  const messageId = stableCompletionMessageId(run.data.id);
  const timelineId = await dependencies.generateId();
  const runEventId = await dependencies.generateId();
  const threadEventId = await dependencies.generateId();
  const usageOperations = await runtimeUsageOperations(dependencies, plannedRun, usage);
  const bodyBytes = new TextEncoder().encode(publishableBody).byteLength;
  const contentHash = createHash("sha256").update(publishableBody).digest("hex");
  const requiresExternalBody =
    bodyBytes > MAX_INLINE_ASSISTANT_MESSAGE_BYTES ||
    inlineFinalizedMessageAppendBytes({
      body: publishableBody,
      contentHash,
      messageId,
      run: plannedRun,
      streamEventId,
      timestamp,
    }) > DEFAULT_DURABLE_STREAM_MAX_APPEND_BATCH_BYTES;
  if (requiresExternalBody && !dependencies.writeMessageBody) {
    throw new AgentRunWorkerRecordError(
      "assistant_body_too_large",
      "Assistant message cannot fit its canonical record or finalized stream event and requires a message body writer.",
    );
  }
  if (requiresExternalBody && !dependencies.deleteMessageBody) {
    throw new AgentRunWorkerRecordError(
      "message_body_cleanup_unavailable",
      "Message body externalization requires an exact-version cleanup adapter.",
    );
  }
  const bodyRef = requiresExternalBody
    ? await dependencies.writeMessageBody!({
        body: publishableBody,
        contentHash,
        messageId,
        run: plannedRun,
        ...(signal ? { signal } : {}),
      })
    : undefined;
  return {
    body: publishableBody,
    ...(bodyRef ? { bodyRef } : {}),
    completedToolCalls,
    messageId,
    ...(messageMetadata ? { messageMetadata } : {}),
    runEventId,
    streamEventId,
    threadEventId,
    timelineId,
    timestamp,
    usageOperations,
  };
}

export async function cleanupPreparedMessageBody(
  dependencies: AgentRunWorkerDependencies,
  plan: CompletedRunPlan,
  run: RunRecordValue,
): Promise<void> {
  if (!plan.bodyRef) return;
  await dependencies.deleteMessageBody!({
    bodyRef: plan.bodyRef,
    messageId: plan.messageId,
    run,
  });
}

export async function persistPausedRun(
  dependencies: AgentRunWorkerDependencies,
  previous: RunRecordValue,
  lease: RuntimeLeaseRecordValue,
  status: "waiting-for-approval" | "waiting-for-tool",
  message: string,
  completedToolCalls: readonly RuntimeCompletedToolCall[],
  pendingAction: RuntimePendingAction,
  artifactContinuation: import("@deployments-ai/agent-runtime").RuntimeArtifactContinuation,
  modelContinuation: import("@deployments-ai/agent-runtime").RuntimeModelContinuation | undefined,
  usage: readonly RuntimeUsageEntry[],
  modelInvocationAttempts: readonly RuntimeModelInvocationAttempt[] = [],
): Promise<RunRecordValue> {
  const timestamp = now(dependencies);
  const run = withRunToolContinuation(
    terminalRun(previous, status, timestamp),
    completedToolCalls,
    pendingAction,
    artifactContinuation,
    modelContinuation,
  );
  const completedPersistence = await completedToolCallPersistence(
    dependencies,
    run,
    completedToolCalls,
    timestamp,
  );
  if (
    completedToolCalls.some(
      (call) =>
        call.toolCallId === pendingAction.toolCallId ||
        call.idempotencyKey === pendingAction.idempotencyKey,
    )
  ) {
    throw new AgentRunWorkerRecordError(
      "invalid_tool_continuation",
      "Pending and completed tool continuations must be distinct.",
    );
  }
  const previousToolCall =
    pendingAction.kind === "tool"
      ? await loadRunToolCall(dependencies.database, run, pendingAction.toolCallId)
      : undefined;
  const toolCall = pausedToolCallRecord({
    action: pendingAction,
    now: timestamp,
    ...(previousToolCall ? { previous: previousToolCall } : {}),
    run,
  });
  const approval =
    pendingAction.kind === "approval"
      ? pendingApprovalRecord({ action: pendingAction, now: timestamp, run })
      : undefined;
  const timeline = timelineRecord({
    data: {
      message,
      status,
      toolCallId: pendingAction.toolCallId,
      toolName: pendingAction.toolName,
      ...(pendingAction.kind === "approval"
        ? { approvalId: pendingAction.approvalId }
        : { externalOperationId: pendingAction.externalOperationId }),
    },
    eventType: `run.${status}`,
    id: await dependencies.generateId(),
    now: timestamp,
    run,
    sequence: run.data.version,
  });
  const event = makeSemanticEventRecord({
    aggregateId: run.data.id,
    aggregateType: "run",
    aggregateVersion: run.data.version + 1,
    environmentId: run.data.environmentId,
    eventId: await dependencies.generateId(),
    eventType: `run.${status}`,
    occurredAt: timestamp,
    organizationId: run.data.organizationId,
    payload: executionEventPayload(run.data, {
      message,
      pendingAction: pendingActionCorrelation(pendingAction),
      status,
      threadId: run.data.threadId,
    }),
    projectId: run.data.projectId,
  });
  const toolEvent = makeSemanticEventRecord({
    aggregateId: toolCall.data.id,
    aggregateType: "tool-call",
    aggregateVersion: toolCall.data.version + 1,
    environmentId: toolCall.data.environmentId,
    eventId: await dependencies.generateId(),
    eventType: pendingAction.kind === "tool" ? "tool-call.running" : "tool-call.requested",
    occurredAt: timestamp,
    organizationId: toolCall.data.organizationId,
    payload: executionEventPayload(run.data, {
      effect: toolCall.data.effect,
      policyAction: toolCall.data.policyAction ?? null,
      runId: toolCall.data.runId,
      status: toolCall.data.status,
      toolCallId: toolCall.data.id,
      toolName: toolCall.data.toolName,
    }),
    projectId: toolCall.data.projectId,
  });
  const approvalEvent = approval
    ? makeSemanticEventRecord({
        aggregateId: approval.data.id,
        aggregateType: "approval",
        aggregateVersion: 1,
        environmentId: approval.data.environmentId,
        eventId: await dependencies.generateId(),
        eventType: "approval.requested",
        occurredAt: timestamp,
        organizationId: approval.data.organizationId,
        payload: executionEventPayload(run.data, {
          approvalId: approval.data.id,
          runId: approval.data.runId,
          status: approval.data.status,
          toolCallId: approval.data.toolCallId ?? null,
        }),
        projectId: approval.data.projectId,
      })
    : undefined;
  const usageOperations = await runtimeUsageOperations(dependencies, run, usage);
  const invocationOperations = await modelInvocationPersistenceOperations(
    dependencies.database,
    modelInvocationAttempts,
  );
  await transactWithSemanticEvents(
    dependencies.database,
    [
      { kind: "put", previousRecord: previous, record: run },
      { kind: "put", record: timeline },
      ...completedPersistence.operations,
      ...generationReasoningPersistence({
        modelContinuation,
        now: timestamp,
        previousRun: previous,
      }),
      previousToolCall
        ? { kind: "put", previousRecord: previousToolCall, record: toolCall }
        : {
            conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            kind: "put",
            record: toolCall,
          },
      ...(approval
        ? [
            {
              conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              kind: "put" as const,
              record: approval,
            },
          ]
        : []),
      ...usageOperations,
      ...invocationOperations,
      requireThreadExecutionLease(lease),
    ],
    [event, ...completedPersistence.events, toolEvent, ...(approvalEvent ? [approvalEvent] : [])],
  );
  return run;
}

export async function persistCompletedRun(
  dependencies: AgentRunWorkerDependencies,
  queue: AgentRunQueueMessage,
  previousRun: RunRecordValue,
  previousThread: ThreadRecordValue,
  lease: RuntimeLeaseRecordValue,
  plan: CompletedRunPlan,
  modelId: string | undefined,
  modelInvocationAttempts: readonly RuntimeModelInvocationAttempt[] = [],
): Promise<{ readonly message: MessageRecordValue; readonly run: RunRecordValue }> {
  const latestRunTimestamp = Math.max(
    ...[previousRun.data.updatedAt, previousRun.data.heartbeatAt]
      .map((value) => (value ? Date.parse(value) : Number.NaN))
      .filter(Number.isFinite),
  );
  const completionTimestamp = new Date(
    Math.max(
      plan.timestamp.getTime(),
      Number.isFinite(latestRunTimestamp) ? latestRunTimestamp : plan.timestamp.getTime(),
    ),
  );
  const run = withRunToolContinuation(
    terminalRun(previousRun, "completed", completionTimestamp),
    [],
  );
  const completedPersistence = await completedToolCallPersistence(
    dependencies,
    run,
    plan.completedToolCalls,
    completionTimestamp,
  );
  const invocationOperations = await modelInvocationPersistenceOperations(
    dependencies.database,
    modelInvocationAttempts,
  );
  let currentThread = previousThread;

  for (let attempt = 0; attempt < MAX_COMPLETION_ATTEMPTS; attempt += 1) {
    const channelResponse = await channelResponsePersistence({
      body: plan.body,
      dependencies,
      run,
      sourceMessageId: plan.messageId,
      sourceMessageSequence: currentThread.data.version + 1,
      timestamp: completionTimestamp,
    });
    const currentThreadUpdatedAt = Date.parse(currentThread.data.updatedAt);
    const threadTimestamp = new Date(
      Math.max(
        completionTimestamp.getTime(),
        Number.isFinite(currentThreadUpdatedAt)
          ? currentThreadUpdatedAt
          : completionTimestamp.getTime(),
      ),
    );
    const thread = advancedThread(currentThread, threadTimestamp);
    const message = assistantMessageRecord({
      body: plan.body,
      ...(plan.bodyRef ? { bodyRef: plan.bodyRef } : {}),
      id: plan.messageId,
      ...(plan.messageMetadata ? { metadata: plan.messageMetadata } : {}),
      now: completionTimestamp,
      run,
      sequence: thread.data.version,
      streamEventId: plan.streamEventId,
    });
    const timeline = timelineRecord({
      data: {
        ...(plan.completedToolCalls.length > 0
          ? {
              completedToolCallIds: JSON.stringify(
                plan.completedToolCalls.map((call) => call.toolCallId),
              ),
            }
          : {}),
        messageId: message.data.id,
        messageSequence: message.data.sequence,
        ...(modelId ? { modelId } : {}),
        status: "completed",
      },
      eventType: "run.completed",
      id: plan.timelineId,
      now: completionTimestamp,
      run,
      sequence: run.data.version,
    });
    const runEvent = makeSemanticEventRecord({
      aggregateId: run.data.id,
      aggregateType: "run",
      aggregateVersion: run.data.version + 1,
      environmentId: run.data.environmentId,
      eventId: plan.runEventId,
      eventType: "run.completed",
      occurredAt: completionTimestamp,
      organizationId: run.data.organizationId,
      payload: executionEventPayload(run.data, {
        ...executionPinsPayload(run.data),
        ...(plan.completedToolCalls.length > 0
          ? {
              completedToolCalls: plan.completedToolCalls.map((call) => ({
                ...(call.outputSummary ? { outputSummary: call.outputSummary } : {}),
                toolCallId: call.toolCallId,
                toolName: call.toolName,
              })),
            }
          : {}),
        messageId: message.data.id,
        status: run.data.status,
        threadId: run.data.threadId,
      }),
      projectId: run.data.projectId,
    });
    const finalizedPayload = {
      messageId: message.data.id,
      runId: run.data.id,
      sequence: message.data.sequence,
      streamEventId: plan.streamEventId,
    };
    const threadEvent = makeSemanticEventRecord({
      aggregateId: thread.data.id,
      aggregateType: "thread",
      aggregateVersion: thread.data.version + 1,
      environmentId: thread.data.environmentId,
      eventId: plan.threadEventId,
      eventType: "assistant-message.finalized",
      occurredAt: completionTimestamp,
      organizationId: thread.data.organizationId,
      payload: conversationMessageIsTransient(message.data.metadata)
        ? internalSemanticEventPayload(finalizedPayload)
        : executionEventPayload(run.data, finalizedPayload),
      projectId: thread.data.projectId,
    });
    try {
      await transactWithSemanticEvents(
        dependencies.database,
        [
          { kind: "put", previousRecord: previousRun, record: run },
          { kind: "put", previousRecord: currentThread, record: thread },
          { kind: "put", record: message },
          { kind: "put", record: timeline },
          ...completedPersistence.operations,
          ...channelResponse.operations,
          ...plan.usageOperations,
          ...invocationOperations,
          requireThreadExecutionLease(lease),
        ],
        [runEvent, threadEvent, ...completedPersistence.events, ...channelResponse.events],
      );
      return { message, run };
    } catch (cause) {
      let latestRun: RunRecordValue | undefined;
      let latestThread: ThreadRecordValue;
      try {
        [latestRun, latestThread] = await Promise.all([
          loadRun(dependencies.database, queue),
          loadThread(dependencies.database, queue),
        ]);
      } catch (reconciliationCause) {
        throw new AggregateError(
          [cause, reconciliationCause],
          "Agent run completion outcome could not be reconciled.",
        );
      }
      if (latestRun?.data.status === "completed") {
        let persisted: MessageRecordValue | undefined;
        try {
          persisted = await finalizedMessageForRun(dependencies, queue, latestRun);
        } catch (reconciliationCause) {
          throw new AggregateError(
            [cause, reconciliationCause],
            "Completed agent run message could not be reconciled.",
          );
        }
        if (persisted) return { message: persisted, run: latestRun };
        throw new AggregateError(
          [cause],
          "Completed agent run is missing its finalized message during reconciliation.",
        );
      }
      const runUnchanged =
        latestRun?.data.status === "running" && latestRun.data.version === previousRun.data.version;
      if (
        !runUnchanged ||
        latestThread.data.version < currentThread.data.version ||
        attempt === MAX_COMPLETION_ATTEMPTS - 1
      ) {
        throw new CompletionNotCommittedError(cause);
      }
      try {
        validateThreadPin(previousRun, latestThread);
      } catch (pinCause) {
        throw new CompletionNotCommittedError(pinCause);
      }
      if (latestThread.data.version > currentThread.data.version) currentThread = latestThread;
    }
  }
  throw new Error("Agent run completion retry limit was exhausted.");
}
