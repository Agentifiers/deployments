import type { ClaimedRunOutcome } from "./agent-run-input.ts";
import { now } from "./agent-run-input.ts";
import {
  appendCanonicalRunTerminalEvent,
  appendFinalizedMessage,
  appendPausedRunEvent,
  retryScheduledReason,
} from "./agent-run-terminal.ts";
import { failureChain } from "./failure-log.ts";
import { releasePublishedRunThreadExecutionLease } from "./agent-run-lease.ts";
import { attemptTraceFinalization } from "./trace-finalization.ts";
import { releaseThreadSandboxKeptByRun } from "./thread-sandbox/run-exit.ts";
import type { AgentRunWorkerDependencies, ProcessAgentRunResult } from "./types.ts";
import { ensureCompletedRunMemoryFlush } from "./agent-run-memory.ts";
import { queueMessage } from "./approval-shared.ts";
import {
  clearChannelAgentStreamProgress,
  finalizeChannelAgentStreams,
  pauseChannelAgentStreams,
} from "./channel-agent-stream.ts";
import { replayAgentPlanSnapshot } from "./agent-run-plan.ts";
import { resolveAwaitedDelegation, resolvePausedDelegation } from "./agent-delegation-results.ts";

const RETRYABLE_QUEUE_BACKOFF_SECONDS = 60;

export async function publishAgentRunOutcome(
  dependencies: AgentRunWorkerDependencies,
  outcome: ClaimedRunOutcome,
): Promise<ProcessAgentRunResult> {
  if (outcome.kind === "paused") {
    let streamCause: unknown;
    try {
      await pauseChannelAgentStreams(dependencies, outcome.run);
    } catch (cause) {
      streamCause = cause;
    }
    await replayAgentPlanSnapshot(dependencies, outcome.run);
    await appendPausedRunEvent(dependencies, outcome.run, outcome.pendingAction);
    await releasePublishedRunThreadExecutionLease(dependencies, outcome.run);
    await resolvePausedDelegation(dependencies, outcome.run, outcome.pendingAction);
    clearChannelAgentStreamProgress(dependencies, outcome.run.data.id);
    if (streamCause) throw streamCause;
    return {
      action: "paused",
      pendingAction: outcome.pendingAction,
      run: outcome.run,
      status: outcome.status,
    };
  }
  if (outcome.kind === "canceled") {
    let streamCause: unknown;
    try {
      await finalizeChannelAgentStreams({ dependencies, run: outcome.run });
    } catch (cause) {
      streamCause = cause;
    }
    await replayAgentPlanSnapshot(dependencies, outcome.run);
    await appendCanonicalRunTerminalEvent(dependencies, outcome.run);
    await releaseThreadSandboxKeptByRun(dependencies.threadSandbox, outcome.run);
    await releasePublishedRunThreadExecutionLease(dependencies, outcome.run);
    await attemptTraceFinalization(dependencies.database, outcome.run, now(dependencies));
    await resolveAwaitedDelegation(dependencies, outcome.run);
    clearChannelAgentStreamProgress(dependencies, outcome.run.data.id);
    if (streamCause) throw streamCause;
    return { action: "skipped", reason: "Run was canceled.", run: outcome.run };
  }
  if (outcome.kind === "failed") {
    let streamCause: unknown;
    try {
      await finalizeChannelAgentStreams({ dependencies, run: outcome.run });
    } catch (cause) {
      streamCause = cause;
    }
    await replayAgentPlanSnapshot(dependencies, outcome.run);
    await appendCanonicalRunTerminalEvent(dependencies, outcome.run);
    await releaseThreadSandboxKeptByRun(dependencies.threadSandbox, outcome.run);
    await releasePublishedRunThreadExecutionLease(dependencies, outcome.run);
    await attemptTraceFinalization(dependencies.database, outcome.run, now(dependencies));
    await resolveAwaitedDelegation(dependencies, outcome.run);
    clearChannelAgentStreamProgress(dependencies, outcome.run.data.id);
    if (streamCause) throw streamCause;
    return { action: "skipped", reason: "Run failed.", run: outcome.run };
  }
  if (
    outcome.kind === "retryable" ||
    outcome.kind === "checkpointed" ||
    outcome.kind === "interrupted"
  ) {
    try {
      await pauseChannelAgentStreams(dependencies, outcome.run);
    } catch {
      // The next run generation reconciles an older streaming segment before execution.
    }
    clearChannelAgentStreamProgress(dependencies, outcome.run.data.id);
    if (outcome.kind === "checkpointed") {
      return {
        action: "requeued",
        reason: "Run was requeued to resume its checkpointed tool loop.",
        retryAfterSeconds: 0,
      };
    }
    if (outcome.kind === "interrupted") {
      return {
        action: "requeued",
        reason: "Run was requeued after its worker host shut down.",
        retryAfterSeconds: 0,
      };
    }
    return {
      action: "requeued",
      failure: {
        causeTypes: failureChain(outcome.cause)
          .slice(1)
          .map((link) => link.type),
        message: retryScheduledReason(outcome.cause),
        type: outcome.cause instanceof Error ? outcome.cause.name : typeof outcome.cause,
      },
      reason: "Run was requeued after a retryable runtime failure.",
      retryAfterSeconds: RETRYABLE_QUEUE_BACKOFF_SECONDS,
    };
  }
  let streamCause: unknown;
  try {
    const body =
      outcome.message.data.body ??
      (dependencies.readMessageBody
        ? await dependencies.readMessageBody(outcome.message)
        : "Agent response is available in Deployments.ai.");
    await finalizeChannelAgentStreams({ body, dependencies, run: outcome.run });
  } catch (cause) {
    streamCause = cause;
  }
  await replayAgentPlanSnapshot(dependencies, outcome.run);
  await appendFinalizedMessage(dependencies, outcome.message);
  await appendCanonicalRunTerminalEvent(dependencies, outcome.run);
  await releasePublishedRunThreadExecutionLease(dependencies, outcome.run);
  await ensureCompletedRunMemoryFlush(
    dependencies,
    outcome.run,
    outcome.memoryMode,
    queueMessage(outcome.run),
    outcome.contextCheckpointMode,
    outcome.memoryReviewMode,
    outcome.memoryModelId,
  );
  await attemptTraceFinalization(dependencies.database, outcome.run, now(dependencies));
  await resolveAwaitedDelegation(dependencies, outcome.run);
  clearChannelAgentStreamProgress(dependencies, outcome.run.data.id);
  if (streamCause) throw streamCause;
  return {
    action: "completed",
    messageId: outcome.message.data.id,
    run: outcome.run,
  };
}
