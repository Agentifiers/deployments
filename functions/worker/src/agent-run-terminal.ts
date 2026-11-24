/* eslint-disable no-await-in-loop -- Worker transitions and stream events are ordered side effects. */

import {
  boundedRuntimeError,
  RuntimeToolPreparationRetryableError,
  type RuntimeArtifactContinuation,
  type RuntimeCompletedToolCall,
  type RuntimeModelContinuation,
  type RuntimePendingAction,
  type RuntimeModelInvocationAttempt,
  type RuntimeRetriedToolCall,
  type RuntimeUsageEntry,
} from "@deployments-ai/agent-runtime";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { conversationMessageIsTransient } from "@deployments-ai/conversations";
import { createThreadStreamEvent } from "@deployments-ai/streaming";
import { Ulid, executionEventPayload, executionPinsPayload } from "@deployments-ai/db";
import { Schema } from "effect";
import {
  loadFinalizedMessageForRun,
  loadRunApproval,
  loadRunToolCall,
  loadRunTimelineEvent,
  pausedToolCallRecord,
  requestingModelGeneration,
  retryableRun,
  terminalRun,
  timelineRecord,
  AgentRunWorkerRecordError,
} from "./records.ts";
import type {
  AgentRunQueueMessage,
  AgentRunWorkerDependencies,
  MessageRecordValue,
  RunRecordValue,
} from "./types.ts";
import { runToolContinuation, withRunToolContinuation } from "./continuation.ts";
import {
  CodedRunFailure,
  TERMINAL_STATUSES,
  metadata,
  now,
  pendingActionCorrelation,
} from "./agent-run-input.ts";
import type { RuntimeLeaseRecordValue } from "./agent-run-input.ts";
import {
  appendEvent,
  queuedRunThreadExecutionLease,
  requireThreadExecutionLease,
} from "./agent-run-lease.ts";
import { runtimeUsageOperations } from "./agent-run-claim.ts";
import {
  completedToolCallPersistence,
  terminalApprovedToolPersistence,
} from "./agent-run-completion.ts";
import { modelInvocationPersistenceOperations } from "./model-invocations.ts";
import { scheduleClientToolPauseExpiration } from "./client-tool-expiration.ts";
import { generationReasoningPersistence } from "./generation-reasoning.ts";

interface RequeuedRunState {
  readonly artifactContinuation?: RuntimeArtifactContinuation;
  readonly completedToolCalls: readonly RuntimeCompletedToolCall[];
  readonly modelContinuation?: RuntimeModelContinuation;
  readonly modelInvocationAttempts: readonly RuntimeModelInvocationAttempt[];
  readonly retriedToolCall?: RuntimeRetriedToolCall;
  readonly usage: readonly RuntimeUsageEntry[];
}

/** The bounded, redacted reason a `run.retry-scheduled` event persists for a retryable failure. */
export function retryScheduledReason(cause: unknown): string {
  return boundedRuntimeError(cause, "Agent run will be retried.");
}

export async function persistRetryableRun(
  dependencies: AgentRunWorkerDependencies,
  previous: RunRecordValue,
  cause: unknown,
  lease: RuntimeLeaseRecordValue,
  completedToolCalls: readonly RuntimeCompletedToolCall[] = [],
  artifactContinuation?: import("@deployments-ai/agent-runtime").RuntimeArtifactContinuation,
  usage: readonly RuntimeUsageEntry[] = [],
  modelContinuation?: import("@deployments-ai/agent-runtime").RuntimeModelContinuation,
  modelInvocationAttempts: readonly RuntimeModelInvocationAttempt[] = [],
): Promise<RunRecordValue> {
  const retriedToolCall =
    cause instanceof RuntimeToolPreparationRetryableError ? cause.retriedToolCall : undefined;
  return persistRequeuedRun(
    dependencies,
    previous,
    lease,
    {
      ...(artifactContinuation ? { artifactContinuation } : {}),
      completedToolCalls,
      ...(modelContinuation ? { modelContinuation } : {}),
      modelInvocationAttempts,
      ...(retriedToolCall ? { retriedToolCall } : {}),
      usage,
    },
    "run.retry-scheduled",
    retryScheduledReason(cause),
  );
}

/**
 * Persists a runtime checkpoint taken at a tool-batch boundary and returns the run to the queue
 * so a fresh worker invocation resumes the same model continuation.
 */
export async function persistCheckpointedRun(
  dependencies: AgentRunWorkerDependencies,
  previous: RunRecordValue,
  lease: RuntimeLeaseRecordValue,
  state: RequeuedRunState,
): Promise<RunRecordValue> {
  return persistRequeuedRun(
    dependencies,
    previous,
    lease,
    state,
    "run.checkpointed",
    "Agent run checkpointed its tool loop and will resume in a new execution.",
    (previous.data.checkpointCount ?? 0) + 1,
  );
}

/**
 * Persists a run stopped by its draining worker host and returns it to the queue. Like a
 * checkpoint it advances `checkpointCount`, so the claim does not consume a retry attempt; unlike
 * a checkpoint it never fails the run at the checkpoint limit.
 */
export async function persistInterruptedRun(
  dependencies: AgentRunWorkerDependencies,
  previous: RunRecordValue,
  lease: RuntimeLeaseRecordValue,
  state: RequeuedRunState,
): Promise<RunRecordValue> {
  return persistRequeuedRun(
    dependencies,
    previous,
    lease,
    state,
    "run.interrupted",
    "Agent run was interrupted by worker shutdown and will resume in a new execution.",
    (previous.data.checkpointCount ?? 0) + 1,
  );
}

async function persistRequeuedRun(
  dependencies: AgentRunWorkerDependencies,
  previous: RunRecordValue,
  lease: RuntimeLeaseRecordValue,
  state: RequeuedRunState,
  eventType: "run.checkpointed" | "run.interrupted" | "run.retry-scheduled",
  reason: string,
  checkpointCount?: number,
): Promise<RunRecordValue> {
  const timestamp = now(dependencies);
  const previousContinuation = runToolContinuation(previous);
  const run = withRunToolContinuation(
    retryableRun(previous, timestamp, checkpointCount),
    state.completedToolCalls,
    undefined,
    state.artifactContinuation ?? previousContinuation.artifactContinuation,
    state.modelContinuation ?? previousContinuation.modelContinuation,
    state.retriedToolCall,
  );
  const completedPersistence = await completedToolCallPersistence(
    dependencies,
    run,
    state.completedToolCalls,
    timestamp,
  );
  const usageOperations = await runtimeUsageOperations(dependencies, run, state.usage);
  const invocationOperations = await modelInvocationPersistenceOperations(
    dependencies.database,
    state.modelInvocationAttempts,
  );
  const queuedLease = queuedRunThreadExecutionLease(lease, run, timestamp);
  const timeline = timelineRecord({
    data: { reason, status: "queued" },
    eventType,
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
    eventType,
    occurredAt: timestamp,
    organizationId: run.data.organizationId,
    payload: executionEventPayload(run.data, {
      reason,
      status: "queued",
      threadId: run.data.threadId,
    }),
    projectId: run.data.projectId,
  });
  await transactWithSemanticEvents(
    dependencies.database,
    [
      { kind: "put", previousRecord: previous, record: run },
      { kind: "put", record: timeline },
      ...completedPersistence.operations,
      ...generationReasoningPersistence({
        modelContinuation: state.modelContinuation,
        now: timestamp,
        previousRun: previous,
      }),
      ...usageOperations,
      ...invocationOperations,
      { kind: "put", previousRecord: lease, record: queuedLease },
    ],
    [event, ...completedPersistence.events],
  );
  return run;
}

export async function persistFailedRun(
  dependencies: AgentRunWorkerDependencies,
  previous: RunRecordValue,
  cause: unknown,
  lease?: RuntimeLeaseRecordValue,
  completedToolCalls: readonly RuntimeCompletedToolCall[] = [],
  usage: readonly RuntimeUsageEntry[] = [],
  artifactContinuation?: import("@deployments-ai/agent-runtime").RuntimeArtifactContinuation,
  modelContinuation?: import("@deployments-ai/agent-runtime").RuntimeModelContinuation,
  modelInvocationAttempts: readonly RuntimeModelInvocationAttempt[] = [],
): Promise<RunRecordValue> {
  const timestamp = now(dependencies);
  const error = boundedRuntimeError(cause, "Agent run failed.");
  const continuedArtifacts =
    artifactContinuation ?? runToolContinuation(previous).artifactContinuation;
  const run = withRunToolContinuation(
    terminalRun(
      previous,
      "failed",
      timestamp,
      error,
      cause instanceof CodedRunFailure ? cause.code : undefined,
    ),
    [],
    undefined,
    continuedArtifacts,
    modelContinuation,
  );
  const completedPersistence = await completedToolCallPersistence(
    dependencies,
    run,
    completedToolCalls,
    timestamp,
  );
  const terminalToolPersistence = await terminalApprovedToolPersistence({
    completedToolCalls,
    dependencies,
    outputSummary: "Agent run failed before approved tool execution.",
    previousRun: previous,
    timestamp,
  });
  const timeline = timelineRecord({
    data: { error, status: "failed" },
    eventType: "run.failed",
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
    eventType: "run.failed",
    occurredAt: timestamp,
    organizationId: run.data.organizationId,
    payload: executionEventPayload(run.data, {
      ...executionPinsPayload(run.data),
      error,
      status: run.data.status,
      threadId: run.data.threadId,
    }),
    projectId: run.data.projectId,
  });
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
      ...terminalToolPersistence.operations,
      ...usageOperations,
      ...invocationOperations,
      ...(lease ? [requireThreadExecutionLease(lease)] : []),
    ],
    [event, ...completedPersistence.events, ...terminalToolPersistence.events],
  );
  return run;
}

export async function persistCanceledRun(
  dependencies: AgentRunWorkerDependencies,
  previous: RunRecordValue,
  lease: RuntimeLeaseRecordValue,
  message: string,
  completedToolCalls: readonly RuntimeCompletedToolCall[],
  pendingAction?: RuntimePendingAction,
  usage: readonly RuntimeUsageEntry[] = [],
  artifactContinuation?: import("@deployments-ai/agent-runtime").RuntimeArtifactContinuation,
  modelContinuation?: import("@deployments-ai/agent-runtime").RuntimeModelContinuation,
  modelInvocationAttempts: readonly RuntimeModelInvocationAttempt[] = [],
): Promise<RunRecordValue> {
  const timestamp = now(dependencies);
  const continuedArtifacts =
    artifactContinuation ?? runToolContinuation(previous).artifactContinuation;
  const run = withRunToolContinuation(
    terminalRun(previous, "canceled", timestamp),
    completedToolCalls,
    pendingAction?.kind === "tool" ? pendingAction : undefined,
    continuedArtifacts,
    modelContinuation,
  );
  const completedPersistence = await completedToolCallPersistence(
    dependencies,
    run,
    completedToolCalls,
    timestamp,
  );
  const terminalToolPersistence = await terminalApprovedToolPersistence({
    completedToolCalls,
    dependencies,
    outputSummary: "Agent run was canceled before approved tool execution.",
    ...(pendingAction ? { pendingAction } : {}),
    previousRun: previous,
    timestamp,
  });
  if (
    pendingAction &&
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
  const previousRunningToolCall =
    pendingAction?.kind === "tool"
      ? await loadRunToolCall(dependencies.database, run, pendingAction.toolCallId)
      : undefined;
  const runningToolCall =
    pendingAction?.kind === "tool"
      ? pausedToolCallRecord({
          action: pendingAction,
          now: timestamp,
          ...(previousRunningToolCall ? { previous: previousRunningToolCall } : {}),
          run,
        })
      : undefined;
  const timeline = timelineRecord({
    data: {
      message,
      status: "canceled",
      ...(pendingAction
        ? {
            toolCallId: pendingAction.toolCallId,
            toolName: pendingAction.toolName,
            ...(pendingAction.kind === "approval"
              ? { approvalId: pendingAction.approvalId }
              : { externalOperationId: pendingAction.externalOperationId }),
          }
        : {}),
    },
    eventType: "run.canceled",
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
    eventType: "run.canceled",
    occurredAt: timestamp,
    organizationId: run.data.organizationId,
    payload: executionEventPayload(run.data, {
      message,
      ...(pendingAction ? { pendingAction: pendingActionCorrelation(pendingAction) } : {}),
      status: run.data.status,
      threadId: run.data.threadId,
    }),
    projectId: run.data.projectId,
  });
  const toolEvent = runningToolCall
    ? makeSemanticEventRecord({
        aggregateId: runningToolCall.data.id,
        aggregateType: "tool-call",
        aggregateVersion: runningToolCall.data.version + 1,
        environmentId: runningToolCall.data.environmentId,
        eventId: await dependencies.generateId(),
        eventType: "tool-call.running",
        occurredAt: timestamp,
        organizationId: runningToolCall.data.organizationId,
        payload: executionEventPayload(run.data, {
          externalOperationId: runningToolCall.data.externalOperationId ?? null,
          runId: runningToolCall.data.runId,
          status: runningToolCall.data.status,
          toolCallId: runningToolCall.data.id,
          toolName: runningToolCall.data.toolName,
        }),
        projectId: runningToolCall.data.projectId,
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
      ...terminalToolPersistence.operations,
      ...(runningToolCall
        ? [
            previousRunningToolCall
              ? {
                  kind: "put" as const,
                  previousRecord: previousRunningToolCall,
                  record: runningToolCall,
                }
              : {
                  conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                  kind: "put" as const,
                  record: runningToolCall,
                },
          ]
        : []),
      ...usageOperations,
      ...invocationOperations,
      requireThreadExecutionLease(lease),
    ],
    [
      event,
      ...completedPersistence.events,
      ...terminalToolPersistence.events,
      ...(toolEvent ? [toolEvent] : []),
    ],
  );
  return run;
}

export async function finalizedMessageForRun(
  dependencies: AgentRunWorkerDependencies,
  queue: AgentRunQueueMessage,
  run: RunRecordValue,
): Promise<MessageRecordValue | undefined> {
  return loadFinalizedMessageForRun(dependencies.database, queue, run);
}

export async function appendFinalizedMessage(
  dependencies: AgentRunWorkerDependencies,
  message: MessageRecordValue,
): Promise<void> {
  if (!message.data.streamEventId || conversationMessageIsTransient(message.data.metadata)) {
    return;
  }
  await appendEvent(
    dependencies,
    createThreadStreamEvent({
      actor: { type: "agent" },
      environmentId: message.data.environmentId,
      eventId: message.data.streamEventId,
      eventType: "assistant-message.finalized",
      messageId: message.data.id,
      occurredAt: message.data.createdAt,
      organizationId: message.data.organizationId,
      payload: {
        ...(message.data.body !== undefined
          ? { body: message.data.body }
          : {
              bodyByteSize: message.data.bodyRef!.byteSize,
              bodyExternalized: true,
            }),
        contentHash: message.data.contentHash,
        sequence: message.data.sequence,
      },
      projectId: message.data.projectId,
      ...(message.data.runId ? { runId: message.data.runId } : {}),
      threadId: message.data.threadId,
    }),
  );
}

export async function appendCanonicalRunTerminalEvent(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
): Promise<void> {
  if (!TERMINAL_STATUSES.has(run.data.status)) return;
  await appendEvent(
    dependencies,
    createThreadStreamEvent({
      actor: { id: dependencies.workerId, type: "worker" },
      environmentId: run.data.environmentId,
      eventId: `run-terminal:${run.data.id}:${run.data.version}:${run.data.status}`,
      eventType: `run.${run.data.status}`,
      occurredAt: run.data.completedAt ?? run.data.updatedAt,
      organizationId: run.data.organizationId,
      payload: {
        ...(run.data.error ? { error: run.data.error } : {}),
        status: run.data.status,
        threadId: run.data.threadId,
      },
      projectId: run.data.projectId,
      runId: run.data.id,
      threadId: run.data.threadId,
    }),
  );
}

function pendingActionText(data: Readonly<Record<string, unknown>>, field: string): string {
  const value = data[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new AgentRunWorkerRecordError(
      "paused_action_missing",
      `Paused run timeline requires ${field}.`,
    );
  }
  return value.trim();
}

function pendingActionUlid(data: Readonly<Record<string, unknown>>, field: string): Ulid {
  try {
    return Schema.decodeUnknownSync(Ulid)(pendingActionText(data, field));
  } catch {
    throw new AgentRunWorkerRecordError(
      "paused_action_missing",
      `Paused run timeline ${field} must be a canonical ULID.`,
    );
  }
}

export async function persistedPendingAction(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
): Promise<RuntimePendingAction> {
  const timeline = await loadRunTimelineEvent(dependencies.database, run);
  if (!timeline || timeline.data.eventType !== `run.${run.data.status}`) {
    throw new AgentRunWorkerRecordError(
      "paused_action_missing",
      `Paused run ${run.data.id} does not have its canonical timeline event.`,
    );
  }
  const data = metadata(timeline.data.data);
  const toolCallId = pendingActionUlid(data, "toolCallId");
  const toolName = pendingActionText(data, "toolName");
  const toolCall = await loadRunToolCall(dependencies.database, run, toolCallId);
  if (!toolCall || toolCall.data.toolName !== toolName || !toolCall.data.idempotencyKey) {
    throw new AgentRunWorkerRecordError(
      "paused_action_missing",
      `Paused run ${run.data.id} does not have its canonical tool call.`,
    );
  }
  const common = {
    effect: toolCall.data.effect,
    ...(toolCall.data.connectionId &&
    toolCall.data.authorizationFingerprint &&
    toolCall.data.externalAccountId
      ? {
          executionBinding: {
            authorizationFingerprint: toolCall.data.authorizationFingerprint,
            connectionId: toolCall.data.connectionId,
            ...(toolCall.data.destinationsHash
              ? { destinationsHash: toolCall.data.destinationsHash }
              : {}),
            externalAccountId: toolCall.data.externalAccountId,
            ...(toolCall.data.inputHash ? { inputHash: toolCall.data.inputHash } : {}),
            ...(toolCall.data.toolAdapterId ? { toolAdapterId: toolCall.data.toolAdapterId } : {}),
            ...(toolCall.data.toolPlanFingerprint
              ? { toolPlanFingerprint: toolCall.data.toolPlanFingerprint }
              : {}),
          },
        }
      : {}),
    idempotencyKey: toolCall.data.idempotencyKey,
    ...(toolCall.data.input ? { input: toolCall.data.input } : {}),
    inputSummary: toolCall.data.inputSummary,
    ...requestingModelGeneration(toolCall.data),
    policyReason: toolCall.data.policyReason ?? "Tool policy decision unavailable.",
    requiredScopes: [...toolCall.data.requiredScopes],
    toolCallId,
    toolName,
  };
  if (run.data.status === "waiting-for-approval") {
    const approvalId = pendingActionUlid(data, "approvalId");
    const approval = await loadRunApproval(dependencies.database, run, approvalId);
    if (
      !approval ||
      approval.data.status !== "pending" ||
      approval.data.toolCallId !== toolCallId ||
      toolCall.data.status !== "waiting" ||
      toolCall.data.approvalId !== approvalId
    ) {
      throw new AgentRunWorkerRecordError(
        "paused_action_missing",
        `Paused run ${run.data.id} does not have its canonical pending approval.`,
      );
    }
    return {
      ...common,
      approvalId,
      kind: "approval",
    };
  }
  if (run.data.status === "waiting-for-tool") {
    if (toolCall.data.status !== "running") {
      throw new AgentRunWorkerRecordError(
        "paused_action_missing",
        `Paused run ${run.data.id} tool call is not running.`,
      );
    }
    return {
      ...common,
      ...(toolCall.data.executionType === "client" && toolCall.data.expiresAt
        ? {
            client: {
              expiresAt: toolCall.data.expiresAt,
              ...(toolCall.data.outputSchema ? { outputSchema: toolCall.data.outputSchema } : {}),
            },
          }
        : {}),
      externalOperationId: pendingActionText(data, "externalOperationId"),
      kind: "tool",
    };
  }
  throw new AgentRunWorkerRecordError("paused_action_missing", `Run ${run.data.id} is not paused.`);
}

export async function appendPausedRunEvent(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  pendingAction: RuntimePendingAction,
): Promise<void> {
  await scheduleClientToolPauseExpiration(
    dependencies.scheduleClientToolExpiration,
    run,
    pendingAction,
  );
  const eventType = pendingAction.kind === "approval" ? "approval.requested" : "tool.running";
  await appendEvent(
    dependencies,
    createThreadStreamEvent({
      actor: { id: dependencies.workerId, type: "worker" },
      environmentId: run.data.environmentId,
      eventId: `run-paused:${run.data.id}:${run.data.version}:${pendingAction.kind}`,
      eventType,
      occurredAt: run.data.updatedAt,
      organizationId: run.data.organizationId,
      payload: {
        pendingAction: pendingActionCorrelation(pendingAction),
        status: run.data.status,
        threadId: run.data.threadId,
        // Client-executed tools need their input to run; other tools keep inputs off the stream.
        ...(pendingAction.kind === "tool" && pendingAction.client
          ? {
              clientTool: {
                expiresAt: pendingAction.client.expiresAt,
                input: pendingAction.input ?? {},
                ...(pendingAction.client.outputSchema
                  ? { outputSchema: pendingAction.client.outputSchema }
                  : {}),
              },
            }
          : {}),
      },
      projectId: run.data.projectId,
      runId: run.data.id,
      threadId: run.data.threadId,
      toolCallId: pendingAction.toolCallId,
      ...(pendingAction.kind === "approval" ? { approvalId: pendingAction.approvalId } : {}),
    }),
  );
}
