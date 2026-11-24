import type {
  RuntimeArtifactContinuation,
  RuntimeCompletedToolCall,
  RuntimeModelContinuation,
  RuntimeModelInvocationAttempt,
  RuntimePendingAction,
  RuntimeUsageEntry,
} from "@deployments-ai/agent-runtime";
import { executionEventPayload } from "@deployments-ai/db";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import {
  completedToolCallPersistence,
  terminalApprovedToolPersistence,
} from "./agent-run-completion.ts";
import { loadMatchingRunThreadExecutionLease } from "./agent-run-lease.ts";
import { pendingActionCorrelation, now } from "./agent-run-input.ts";
import type { ReconcileCanceledRunClaim } from "./agent-run-input.ts";
import { runtimeUsageOperations } from "./agent-run-claim.ts";
import { runToolContinuation, withRunToolContinuation } from "./continuation.ts";
import { modelInvocationPersistenceOperations } from "./model-invocations.ts";
import {
  loadRun,
  loadRunToolCall,
  pausedToolCallRecord,
  settledCanceledRun,
  timelineRecord,
  AgentRunWorkerRecordError,
} from "./records.ts";
import type { AgentRunQueueMessage, AgentRunWorkerDependencies, RunRecordValue } from "./types.ts";

export interface ExternalCancellationExecutionState {
  readonly artifactContinuation?: RuntimeArtifactContinuation;
  readonly completedToolCalls: readonly RuntimeCompletedToolCall[];
  readonly message: string;
  readonly modelContinuation?: RuntimeModelContinuation;
  readonly pendingAction?: RuntimePendingAction;
  readonly usage: readonly RuntimeUsageEntry[];
}

export function externalCancellationReconciler(
  dependencies: AgentRunWorkerDependencies,
  queue: AgentRunQueueMessage,
  state: () => ExternalCancellationExecutionState,
  modelInvocationAttempts: () => readonly RuntimeModelInvocationAttempt[],
): ReconcileCanceledRunClaim {
  return ({ run }) => {
    const snapshot = state();
    return persistExternalCancellationState(
      dependencies,
      queue,
      run,
      snapshot.message,
      snapshot.completedToolCalls,
      snapshot.pendingAction,
      snapshot.usage,
      snapshot.artifactContinuation,
      snapshot.modelContinuation,
      modelInvocationAttempts(),
    );
  };
}

export async function persistExternalCancellationState(
  dependencies: AgentRunWorkerDependencies,
  queue: AgentRunQueueMessage,
  execution: RunRecordValue,
  message: string,
  completedToolCalls: readonly RuntimeCompletedToolCall[],
  pendingAction?: RuntimePendingAction,
  usage: readonly RuntimeUsageEntry[] = [],
  artifactContinuation?: RuntimeArtifactContinuation,
  modelContinuation?: RuntimeModelContinuation,
  modelInvocationAttempts: readonly RuntimeModelInvocationAttempt[] = [],
): Promise<RunRecordValue | undefined> {
  const canceled = await loadRun(dependencies.database, queue);
  if (
    canceled?.data.status !== "canceled" ||
    canceled.data.claimedBy !== execution.data.claimedBy ||
    canceled.data.attempt !== execution.data.attempt ||
    canceled.data.traceId !== execution.data.traceId
  ) {
    return undefined;
  }
  if (await loadMatchingRunThreadExecutionLease(dependencies, canceled)) return undefined;
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
  const timestamp = now(dependencies);
  const continuedArtifacts =
    artifactContinuation ?? runToolContinuation(execution).artifactContinuation;
  const run = withRunToolContinuation(
    settledCanceledRun(canceled, timestamp),
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
    previousRun: execution,
    timestamp,
  });
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
    eventType: "run.cancellation-reconciled",
    id: await dependencies.generateId(),
    now: timestamp,
    run,
    sequence: run.data.version,
  });
  const runEvent = makeSemanticEventRecord({
    aggregateId: run.data.id,
    aggregateType: "run",
    aggregateVersion: run.data.version + 1,
    environmentId: run.data.environmentId,
    eventId: await dependencies.generateId(),
    eventType: "run.cancellation-reconciled",
    occurredAt: timestamp,
    organizationId: run.data.organizationId,
    payload: executionEventPayload(run.data, {
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
  const [usageOperations, invocationOperations] = await Promise.all([
    runtimeUsageOperations(dependencies, run, usage),
    modelInvocationPersistenceOperations(dependencies.database, modelInvocationAttempts),
  ]);
  try {
    await transactWithSemanticEvents(
      dependencies.database,
      [
        { kind: "put", previousRecord: canceled, record: run },
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
      ],
      [
        runEvent,
        ...completedPersistence.events,
        ...terminalToolPersistence.events,
        ...(toolEvent ? [toolEvent] : []),
      ],
    );
    return run;
  } catch (cause) {
    const latest = await loadRun(dependencies.database, queue);
    if (
      latest?.data.status === "canceled" &&
      latest.data.claimedBy === undefined &&
      latest.data.attempt === execution.data.attempt
    ) {
      return latest;
    }
    throw cause;
  }
}
