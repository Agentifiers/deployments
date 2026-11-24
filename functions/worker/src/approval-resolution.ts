import { boundedRuntimeError } from "@deployments-ai/agent-runtime";
import {
  Ulid,
  executionEventPayload,
  executionPinsPayload,
  type TransactionOperation,
} from "@deployments-ai/db";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { createThreadStreamEvent } from "@deployments-ai/streaming";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import {
  loadRunApproval,
  loadRunToolCall,
  loadThreadRunById,
  terminalRun,
  timelineRecord,
} from "./records.ts";
import type { RunRecordValue, ToolCallRecordValue } from "./types.ts";
import { agentRunQueueMessageGroupId } from "./types.ts";
import { attemptTraceFinalization } from "./trace-finalization.ts";
import { resumesAfterToolResult, sameToolOutput } from "./client-tool-results.ts";
import {
  continuationWithoutPendingAction,
  withRunToolContinuationReferences,
} from "./continuation.ts";
import {
  ApprovalResolutionError,
  assertApprovalResolvable,
  assertResolverAdmitted,
  acquirePublicationBarrier,
  approvalPublicationOwner,
  approvedToolContinuation,
  assertPublicationBarrierReleased,
  callbackPublicationBarrier,
  completePublishedBarrier,
  loadResolutionState,
  matchingPublicationBarrier,
  now,
  publishResolution,
  queueMessage,
  replayResult,
  requireRunEnqueue,
  resumeExecutionConditions,
  resolutionMatches,
  resolvedApproval,
  resolvedToolCall,
  resumedRun,
} from "./approval-shared.ts";
import type {
  ApprovalResolutionDecision,
  ResolveRunApprovalDependencies,
  ResolveRunApprovalInput,
  ResolveRunApprovalResult,
  ResolveRunToolResult,
  ResolveRunToolResultInput,
  RuntimeLeaseRecordValue,
} from "./approval-shared.ts";

export async function resolveRunApproval(
  input: ResolveRunApprovalInput,
  dependencies: ResolveRunApprovalDependencies,
): Promise<ResolveRunApprovalResult> {
  await assertResolverAdmitted(input, dependencies);
  const current = await loadResolutionState(input, dependencies);
  assertApprovalResolvable(current.run);
  if (current.approval.data.status !== "pending") {
    const replay = replayResult(input, current);
    if (replay.queueMessage) requireRunEnqueue(dependencies);
    const barrier = await matchingPublicationBarrier(
      replay.run,
      approvalPublicationOwner(replay.approval),
      dependencies,
    );
    await publishResolution(dependencies, replay, barrier);
    if (replay.run.data.status === "failed") {
      await attemptTraceFinalization(dependencies.database, replay.run, now(dependencies));
    }
    return replay;
  }
  if (current.run.data.status !== "waiting-for-approval") {
    throw new ApprovalResolutionError(
      "run_not_waiting_for_approval",
      "Run cannot be resumed from its current status.",
    );
  }
  if (current.toolCall.data.status !== "waiting") {
    throw new ApprovalResolutionError(
      "tool_call_not_waiting_for_approval",
      "Tool call is no longer waiting for approval.",
    );
  }
  await assertPublicationBarrierReleased(current.run, dependencies);

  const timestamp = now(dependencies);
  const expiresAt = current.approval.data.expiresAt
    ? Date.parse(current.approval.data.expiresAt)
    : Number.POSITIVE_INFINITY;
  const decision: ApprovalResolutionDecision =
    Number.isFinite(expiresAt) && expiresAt <= timestamp.getTime() ? "expired" : input.decision;
  if (decision === "approved") requireRunEnqueue(dependencies);
  const executionConditions =
    decision === "approved"
      ? await resumeExecutionConditions(current.run, dependencies, timestamp)
      : [];
  const approval = resolvedApproval(current.approval, input, decision, timestamp);
  const toolCall = resolvedToolCall(current.toolCall, decision, timestamp);
  const baseRun =
    decision === "approved"
      ? resumedRun(current.run, timestamp)
      : terminalRun(
          current.run,
          "failed",
          timestamp,
          boundedRuntimeError(
            decision === "expired" ? "Tool approval expired." : "Tool approval was rejected.",
            "Tool approval failed.",
          ),
        );
  const continuation =
    decision === "approved"
      ? approvedToolContinuation(current.run, current.toolCall, current.approval)
      : undefined;
  const run = continuation
    ? withRunToolContinuationReferences(baseRun, continuation)
    : withRunToolContinuationReferences(baseRun, continuationWithoutPendingAction(current.run));
  const resumeQueueMessage = decision === "approved" ? queueMessage(run) : undefined;
  const barrier = callbackPublicationBarrier(run, approvalPublicationOwner(approval), timestamp);
  const timeline = timelineRecord({
    data: {
      approvalId: approval.data.id,
      decision,
      status: run.data.status,
      toolCallId: toolCall.data.id,
    },
    eventType: "approval.resolved",
    id: await dependencies.generateId(),
    now: timestamp,
    run,
    sequence: run.data.version,
  });
  const approvalEvent = makeSemanticEventRecord({
    aggregateId: approval.data.id,
    aggregateType: "approval",
    aggregateVersion: approval.data.version + 1,
    environmentId: approval.data.environmentId,
    eventId: await dependencies.generateId(),
    eventType: "approval.resolved",
    occurredAt: timestamp,
    organizationId: approval.data.organizationId,
    payload: executionEventPayload(run.data, {
      approvalId: approval.data.id,
      decision,
      runId: approval.data.runId,
      status: approval.data.status,
      toolCallId: approval.data.toolCallId ?? null,
    }),
    projectId: approval.data.projectId,
  });
  const toolEvent = makeSemanticEventRecord({
    aggregateId: toolCall.data.id,
    aggregateType: "tool-call",
    aggregateVersion: toolCall.data.version + 1,
    environmentId: toolCall.data.environmentId,
    eventId: await dependencies.generateId(),
    eventType: decision === "approved" ? "tool-call.approved" : "tool-call.failed",
    occurredAt: timestamp,
    organizationId: toolCall.data.organizationId,
    payload: executionEventPayload(run.data, {
      approvalId: approval.data.id,
      runId: toolCall.data.runId,
      status: toolCall.data.status,
      toolCallId: toolCall.data.id,
      toolName: toolCall.data.toolName,
    }),
    projectId: toolCall.data.projectId,
  });
  const runEvent = makeSemanticEventRecord({
    aggregateId: run.data.id,
    aggregateType: "run",
    aggregateVersion: run.data.version + 1,
    environmentId: run.data.environmentId,
    eventId: await dependencies.generateId(),
    eventType: decision === "approved" ? "run.resumed" : "run.failed",
    occurredAt: timestamp,
    organizationId: run.data.organizationId,
    payload: executionEventPayload(run.data, {
      ...executionPinsPayload(run.data),
      approvalId: approval.data.id,
      status: run.data.status,
      threadId: run.data.threadId,
      toolCallId: toolCall.data.id,
    }),
    projectId: run.data.projectId,
  });
  const operations: readonly TransactionOperation[] = [
    ...executionConditions,
    acquirePublicationBarrier(barrier),
    { kind: "put", previousRecord: current.approval, record: approval },
    { kind: "put", previousRecord: current.toolCall, record: toolCall },
    { kind: "put", previousRecord: current.run, record: run },
    {
      conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      kind: "put",
      record: timeline,
    },
  ];
  const events = [approvalEvent, toolEvent, runEvent] as const;
  const transactionToken = createHash("sha256")
    .update(JSON.stringify({ events, operations }))
    .digest("hex")
    .slice(0, 36);
  try {
    await transactWithSemanticEvents(dependencies.database, operations, events, transactionToken);
  } catch (cause) {
    const persisted = await loadResolutionState(input, dependencies);
    if (!resolutionMatches(persisted.approval, decision)) throw cause;
    const replay = replayResult(input, persisted);
    const persistedBarrier = await matchingPublicationBarrier(
      replay.run,
      approvalPublicationOwner(replay.approval),
      dependencies,
    );
    await publishResolution(dependencies, replay, persistedBarrier);
    if (replay.run.data.status === "failed") {
      await attemptTraceFinalization(dependencies.database, replay.run, now(dependencies));
    }
    return replay;
  }

  const result: ResolveRunApprovalResult = {
    approval,
    decision,
    ...(resumeQueueMessage ? { queueMessage: resumeQueueMessage } : {}),
    run,
    toolCall,
  };
  await publishResolution(dependencies, result, barrier);
  if (result.run.data.status === "failed") {
    await attemptTraceFinalization(dependencies.database, result.run, now(dependencies));
  }
  return result;
}

export async function loadToolResultState(
  input: ResolveRunToolResultInput,
  dependencies: ResolveRunApprovalDependencies,
): Promise<{ readonly run: RunRecordValue; readonly toolCall: ToolCallRecordValue }> {
  const run = await loadThreadRunById(dependencies.database, input, input.runId);
  if (!run) throw new ApprovalResolutionError("run_not_found", "Run was not found.");
  const toolCall = await loadRunToolCall(dependencies.database, run, input.toolCallId);
  if (!toolCall)
    throw new ApprovalResolutionError("tool_call_not_found", "Tool call was not found.");
  return { run, toolCall };
}

export function toolResultMatches(
  toolCall: ToolCallRecordValue,
  outcome: ResolveRunToolResultInput["outcome"],
  output?: ResolveRunToolResultInput["output"],
): boolean {
  return (
    toolCall.data.status === (outcome === "completed" ? "succeeded" : "failed") &&
    sameToolOutput(toolCall.data.output, output)
  );
}

export function replayToolResult(
  input: ResolveRunToolResultInput,
  state: Awaited<ReturnType<typeof loadToolResultState>>,
): ResolveRunToolResult {
  if (!toolResultMatches(state.toolCall, input.outcome, input.output)) {
    throw new ApprovalResolutionError(
      "tool_call_already_resolved",
      `Tool call is already ${state.toolCall.data.status}.`,
    );
  }
  return {
    ...state,
    outcome: input.outcome,
    ...(resumesAfterToolResult(state.toolCall, input.outcome) && state.run.data.status === "queued"
      ? { queueMessage: queueMessage(state.run) }
      : {}),
  };
}

export async function publishToolResult(
  input: ResolveRunToolResultInput,
  dependencies: ResolveRunApprovalDependencies,
  state: ResolveRunToolResult,
  barrier: RuntimeLeaseRecordValue | undefined,
): Promise<void> {
  const terminalQueueMessage =
    dependencies.enqueueTerminalRun &&
    (state.run.data.status === "failed" || state.run.data.status === "canceled") &&
    state.run.data.userMessageId !== undefined &&
    state.run.data.userMessageSequence !== undefined
      ? queueMessage(state.run)
      : undefined;
  const enqueueRun = state.queueMessage ? requireRunEnqueue(dependencies) : undefined;
  if (!barrier) return;
  const appendThreadEvent = dependencies.appendThreadEvent;
  if (!appendThreadEvent) {
    throw new ApprovalResolutionError(
      "thread_publication_unavailable",
      "Tool result publication requires a thread stream adapter.",
    );
  }
  await appendThreadEvent(
    createThreadStreamEvent({
      actor: { type: "service" },
      environmentId: state.run.data.environmentId,
      eventId: `tool-result:${state.toolCall.data.id}:${state.toolCall.data.version}:${input.outcome}`,
      eventType: input.outcome === "completed" ? "tool.completed" : "tool.failed",
      occurredAt: state.toolCall.data.completedAt ?? state.toolCall.data.updatedAt,
      organizationId: state.run.data.organizationId,
      payload: {
        ...(state.toolCall.data.externalOperationId
          ? { externalOperationId: state.toolCall.data.externalOperationId }
          : {}),
        ...(state.toolCall.data.outputSummary
          ? { outputSummary: state.toolCall.data.outputSummary }
          : {}),
        ...(state.toolCall.data.executionType === "client"
          ? {
              executionType: "client",
              ...(state.toolCall.data.output ? { output: state.toolCall.data.output } : {}),
            }
          : {}),
        status: state.toolCall.data.status,
      },
      projectId: state.run.data.projectId,
      runId: state.run.data.id,
      threadId: state.run.data.threadId,
      toolCallId: state.toolCall.data.id,
    }),
  );
  if (input.outcome === "failed" && state.run.data.status === "failed") {
    await appendThreadEvent(
      createThreadStreamEvent({
        actor: { type: "service" },
        environmentId: state.run.data.environmentId,
        eventId: `run-terminal:${state.run.data.id}:${state.run.data.version}:failed`,
        eventType: "run.failed",
        occurredAt: state.run.data.completedAt ?? state.run.data.updatedAt,
        organizationId: state.run.data.organizationId,
        payload: {
          ...(state.run.data.error ? { error: state.run.data.error } : {}),
          status: state.run.data.status,
          threadId: state.run.data.threadId,
        },
        projectId: state.run.data.projectId,
        runId: state.run.data.id,
        threadId: state.run.data.threadId,
      }),
    );
  }
  if (state.queueMessage && enqueueRun) {
    await enqueueRun({
      deduplicationId: `tool-resume:${state.toolCall.data.id}:${state.toolCall.data.version}`,
      message: state.queueMessage,
      messageGroupId: agentRunQueueMessageGroupId(state.queueMessage),
    });
  }
  if (terminalQueueMessage && dependencies.enqueueTerminalRun) {
    await dependencies.enqueueTerminalRun({
      deduplicationId: `tool-terminal:${state.toolCall.data.id}:${state.toolCall.data.version}`,
      message: terminalQueueMessage,
      messageGroupId: agentRunQueueMessageGroupId(terminalQueueMessage),
    });
  }
  await completePublishedBarrier(barrier, dependencies);
}

function callbackOwnerVersion(value: string, label: string): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new ApprovalResolutionError(
      "thread_publication_barrier_invalid",
      `${label} publication barrier version is invalid.`,
    );
  }
  return version;
}

function callbackOwnerUlid(value: string, label: string): Ulid {
  try {
    return Schema.decodeUnknownSync(Ulid)(value);
  } catch {
    throw new ApprovalResolutionError(
      "thread_publication_barrier_invalid",
      `${label} publication barrier identifier is invalid.`,
    );
  }
}

export async function replayCallbackPublication(
  run: RunRecordValue,
  barrier: RuntimeLeaseRecordValue,
  dependencies: ResolveRunApprovalDependencies,
): Promise<"queued" | "terminal" | undefined> {
  if (barrier.data.runId !== run.data.id) {
    throw new ApprovalResolutionError(
      "thread_publication_barrier_invalid",
      "Callback publication barrier does not match its run.",
    );
  }
  const parts = barrier.data.owner.split("/");
  if (parts[0] === "approval-resolution") {
    if (parts.length !== 3) {
      throw new ApprovalResolutionError(
        "thread_publication_barrier_invalid",
        "Approval publication barrier owner is invalid.",
      );
    }
    const approvalId = callbackOwnerUlid(parts[1]!, "Approval");
    const version = callbackOwnerVersion(parts[2]!, "Approval");
    const approval = await loadRunApproval(dependencies.database, run, approvalId);
    if (!approval || approval.data.version !== version || !approval.data.toolCallId) {
      throw new ApprovalResolutionError(
        "thread_publication_barrier_invalid",
        "Approval publication barrier does not match callback state.",
      );
    }
    const toolCall = await loadRunToolCall(dependencies.database, run, approval.data.toolCallId);
    if (!toolCall || toolCall.data.approvalId !== approval.data.id) {
      throw new ApprovalResolutionError(
        "thread_publication_barrier_invalid",
        "Approval publication barrier tool call is invalid.",
      );
    }
    if (approval.data.status === "approved" && run.data.status === "queued") {
      await publishResolution(
        dependencies,
        { approval, decision: "approved", queueMessage: queueMessage(run), run, toolCall },
        barrier,
      );
      return "queued";
    }
    if (
      (approval.data.status === "rejected" || approval.data.status === "expired") &&
      run.data.status === "failed"
    ) {
      await publishResolution(
        dependencies,
        { approval, decision: approval.data.status, run, toolCall },
        barrier,
      );
      return "terminal";
    }
    throw new ApprovalResolutionError(
      "thread_publication_barrier_invalid",
      "Approval publication barrier does not match callback state.",
    );
  }
  if (parts[0] === "tool-resolution") {
    if (parts.length !== 4 || (parts[3] !== "completed" && parts[3] !== "failed")) {
      throw new ApprovalResolutionError(
        "thread_publication_barrier_invalid",
        "Tool publication barrier owner is invalid.",
      );
    }
    const toolCallId = callbackOwnerUlid(parts[1]!, "Tool");
    const version = callbackOwnerVersion(parts[2]!, "Tool");
    const outcome = parts[3];
    const toolCall = await loadRunToolCall(dependencies.database, run, toolCallId);
    if (
      !toolCall ||
      toolCall.data.version !== version ||
      toolCall.data.status !== (outcome === "completed" ? "succeeded" : "failed")
    ) {
      throw new ApprovalResolutionError(
        "thread_publication_barrier_invalid",
        "Tool publication barrier does not match terminal callback state.",
      );
    }
    const input: ResolveRunToolResultInput = {
      environmentId: run.data.environmentId,
      organizationId: run.data.organizationId,
      outcome,
      projectId: run.data.projectId,
      runId: run.data.id,
      threadId: run.data.threadId,
      toolCallId: toolCall.data.id,
    };
    if (resumesAfterToolResult(toolCall, outcome) && run.data.status === "queued") {
      await publishToolResult(
        input,
        dependencies,
        { outcome, queueMessage: queueMessage(run), run, toolCall },
        barrier,
      );
      return "queued";
    }
    if (
      (outcome === "failed" && run.data.status === "failed") ||
      ((outcome === "completed" || outcome === "failed") && run.data.status === "canceled")
    ) {
      await publishToolResult(input, dependencies, { outcome, run, toolCall }, barrier);
      return "terminal";
    }
    throw new ApprovalResolutionError(
      "thread_publication_barrier_invalid",
      "Tool publication barrier does not match callback state.",
    );
  }
  return undefined;
}

export function assertExternalOperationCorrelation(
  toolCall: ToolCallRecordValue,
  externalOperationId: string | undefined,
): void {
  const persistedOperationId = toolCall.data.externalOperationId;
  const persistedCorrelationIsUnknown = persistedOperationId === `unknown:${toolCall.data.id}`;
  if (
    !persistedOperationId ||
    (persistedCorrelationIsUnknown
      ? !externalOperationId
      : externalOperationId !== persistedOperationId)
  ) {
    throw new ApprovalResolutionError(
      "external_operation_mismatch",
      "Tool result externalOperationId does not match the persisted operation.",
    );
  }
}
