import { boundedRuntimeError } from "@deployments-ai/agent-runtime";
import {
  ToolCallRecord,
  executionEventPayload,
  executionPinsPayload,
  withCanonicalRecordKeys,
  type TransactionOperation,
} from "@deployments-ai/db";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { terminalRun, timelineRecord } from "./records.ts";
import {
  completedContinuationAfterTool,
  continuationWithoutPendingAction,
  withRunToolContinuationReferences,
} from "./continuation.ts";
import {
  ApprovalResolutionError,
  acquirePublicationBarrier,
  assertPublicationBarrierReleased,
  boundedExternalOperationId,
  callbackPublicationBarrier,
  matchingPublicationBarrier,
  now,
  queueMessage,
  reconciledCanceledRun,
  requireRunEnqueue,
  resumeExecutionConditions,
  resumedRun,
  toolPublicationOwner,
} from "./approval-shared.ts";
import type {
  ResolveRunApprovalDependencies,
  ResolveRunToolResult,
  ResolveRunToolResultInput,
} from "./approval-shared.ts";
import {
  assertExternalOperationCorrelation,
  loadToolResultState,
  publishToolResult,
  replayToolResult,
  toolResultMatches,
} from "./approval-resolution.ts";
import { attemptTraceFinalization } from "./trace-finalization.ts";
import {
  acceptedToolResultOutput,
  clientToolCallExpired,
  resumesAfterToolResult,
  toolResultExternalOperationId,
} from "./client-tool-results.ts";

export async function resolveRunToolResult(
  input: ResolveRunToolResultInput,
  dependencies: ResolveRunApprovalDependencies,
  /** Internal maintenance only: fail an expired client tool call and resume its run. */
  options?: { readonly expired?: boolean },
): Promise<ResolveRunToolResult> {
  const current = await loadToolResultState(input, dependencies);
  const externalOperationId = boundedExternalOperationId(
    toolResultExternalOperationId(current.toolCall, input.externalOperationId),
  );
  assertExternalOperationCorrelation(current.toolCall, externalOperationId);
  if (current.toolCall.data.status !== "running") {
    const replay = replayToolResult(input, current);
    if (replay.queueMessage) requireRunEnqueue(dependencies);
    const barrier = await matchingPublicationBarrier(
      replay.run,
      toolPublicationOwner(replay.toolCall, replay.outcome),
      dependencies,
    );
    await publishToolResult(input, dependencies, replay, barrier);
    if (replay.run.data.status === "failed" || replay.run.data.status === "canceled") {
      await attemptTraceFinalization(dependencies.database, replay.run, now(dependencies));
    }
    return replay;
  }
  const canceledRun = current.run.data.status === "canceled";
  if (current.run.data.status !== "waiting-for-tool" && !canceledRun) {
    throw new ApprovalResolutionError(
      "run_not_waiting_for_tool",
      "Run cannot accept a tool result from its current status.",
    );
  }
  await assertPublicationBarrierReleased(current.run, dependencies);
  const timestamp = now(dependencies);
  if (clientToolCallExpired(current.toolCall, timestamp) !== (options?.expired === true)) {
    throw new ApprovalResolutionError(
      "tool_call_expired",
      options?.expired
        ? "Client tool call has not expired."
        : "Client tool call expired before its result was submitted.",
    );
  }
  const output = acceptedToolResultOutput(current.toolCall, input.outcome, input.output);
  let resumes = resumesAfterToolResult(current.toolCall, input.outcome);
  if (resumes && !canceledRun) requireRunEnqueue(dependencies);
  let executionConditions: readonly TransactionOperation[] = [];
  if (resumes && !canceledRun) {
    try {
      executionConditions = await resumeExecutionConditions(current.run, dependencies, timestamp);
    } catch (cause) {
      // A bound run whose binding expired while its client tool was pending can never resume;
      // expiring the tool call fails the run instead of redelivering the deadline forever.
      if (
        !options?.expired ||
        !(cause instanceof ApprovalResolutionError) ||
        cause.code !== "execution_binding_expired"
      ) {
        throw cause;
      }
      resumes = false;
    }
  }

  const outputSummary = boundedRuntimeError(
    input.outputSummary ??
      (input.outcome === "completed"
        ? "Asynchronous tool completed."
        : "Asynchronous tool failed."),
    input.outcome === "completed" ? "Asynchronous tool completed." : "Asynchronous tool failed.",
  );
  const toolCall = Schema.decodeUnknownSync(ToolCallRecord)(
    withCanonicalRecordKeys({
      data: {
        ...current.toolCall.data,
        completedAt: timestamp.toISOString(),
        ...(externalOperationId ? { externalOperationId } : {}),
        ...(output ? { output } : {}),
        outputSummary,
        status: input.outcome === "completed" ? "succeeded" : "failed",
        updatedAt: timestamp.toISOString(),
        version: current.toolCall.data.version + 1,
      },
      itemType: "tool-call" as const,
    }),
  );
  const baseRun = canceledRun
    ? reconciledCanceledRun(current.run, timestamp)
    : resumes
      ? resumedRun(current.run, timestamp)
      : terminalRun(current.run, "failed", timestamp, outputSummary);
  const run = resumes
    ? withRunToolContinuationReferences(
        baseRun,
        completedContinuationAfterTool(current.run, toolCall),
      )
    : withRunToolContinuationReferences(baseRun, continuationWithoutPendingAction(current.run));
  const resumeQueueMessage =
    resumes && run.data.status === "queued" ? queueMessage(run) : undefined;
  const barrier = callbackPublicationBarrier(
    run,
    toolPublicationOwner(toolCall, input.outcome),
    timestamp,
  );
  const timeline = timelineRecord({
    data: {
      outcome: input.outcome,
      status: run.data.status,
      toolCallId: toolCall.data.id,
    },
    eventType: `tool.${input.outcome}`,
    id: await dependencies.generateId(),
    now: timestamp,
    run,
    sequence: run.data.version,
  });
  const toolEvent = makeSemanticEventRecord({
    aggregateId: toolCall.data.id,
    aggregateType: "tool-call",
    aggregateVersion: toolCall.data.version + 1,
    environmentId: toolCall.data.environmentId,
    eventId: await dependencies.generateId(),
    eventType: input.outcome === "completed" ? "tool-call.completed" : "tool-call.failed",
    occurredAt: timestamp,
    organizationId: toolCall.data.organizationId,
    payload: executionEventPayload(current.run.data, {
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
    eventType: canceledRun ? "run.tool-reconciled" : resumes ? "run.resumed" : "run.failed",
    occurredAt: timestamp,
    organizationId: run.data.organizationId,
    payload: executionEventPayload(run.data, {
      ...executionPinsPayload(run.data),
      status: run.data.status,
      threadId: run.data.threadId,
      toolCallId: toolCall.data.id,
    }),
    projectId: run.data.projectId,
  });
  const operations: readonly TransactionOperation[] = [
    ...executionConditions,
    acquirePublicationBarrier(barrier),
    { kind: "put", previousRecord: current.toolCall, record: toolCall },
    { kind: "put", previousRecord: current.run, record: run },
    {
      conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      kind: "put",
      record: timeline,
    },
  ];
  const events = [toolEvent, runEvent] as const;
  const transactionToken = createHash("sha256")
    .update(JSON.stringify({ events, operations }))
    .digest("hex")
    .slice(0, 36);
  try {
    await transactWithSemanticEvents(dependencies.database, operations, events, transactionToken);
  } catch (cause) {
    const persisted = await loadToolResultState(input, dependencies);
    assertExternalOperationCorrelation(persisted.toolCall, externalOperationId);
    if (!toolResultMatches(persisted.toolCall, input.outcome, output)) throw cause;
    const replay = replayToolResult(input, persisted);
    const persistedBarrier = await matchingPublicationBarrier(
      replay.run,
      toolPublicationOwner(replay.toolCall, replay.outcome),
      dependencies,
    );
    await publishToolResult(input, dependencies, replay, persistedBarrier);
    if (replay.run.data.status === "failed" || replay.run.data.status === "canceled") {
      await attemptTraceFinalization(dependencies.database, replay.run, now(dependencies));
    }
    return replay;
  }

  const result: ResolveRunToolResult = {
    outcome: input.outcome,
    ...(resumeQueueMessage ? { queueMessage: resumeQueueMessage } : {}),
    run,
    toolCall,
  };
  await publishToolResult(input, dependencies, result, barrier);
  if (result.run.data.status === "failed" || result.run.data.status === "canceled") {
    await attemptTraceFinalization(dependencies.database, result.run, now(dependencies));
  }
  return result;
}
