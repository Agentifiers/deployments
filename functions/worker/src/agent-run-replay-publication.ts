import type { RuntimeLeaseRecordValue } from "./agent-run-input.ts";
import { now } from "./agent-run-input.ts";
import { releasePublishedRunThreadExecutionLease } from "./agent-run-lease.ts";
import {
  appendCanonicalRunTerminalEvent,
  appendFinalizedMessage,
  appendPausedRunEvent,
  finalizedMessageForRun,
  persistedPendingAction,
} from "./agent-run-terminal.ts";
import {
  clearChannelAgentStreamProgress,
  finalizeChannelAgentStreams,
  pauseChannelAgentStreams,
} from "./channel-agent-stream.ts";
import { attemptTraceFinalization } from "./trace-finalization.ts";
import { releaseThreadSandboxKeptByRun } from "./thread-sandbox/run-exit.ts";
import type { AgentRunQueueMessage, AgentRunWorkerDependencies, RunRecordValue } from "./types.ts";
import { replayAgentPlanSnapshot } from "./agent-run-plan.ts";
import { ensureCompletedRunMemoryFlush } from "./agent-run-memory.ts";
import { resolveAwaitedDelegation, resolvePausedDelegation } from "./agent-delegation-results.ts";

export async function publishPersistedPausedRun(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
) {
  const pendingAction = await persistedPendingAction(dependencies, run);
  let streamCause: unknown;
  try {
    await pauseChannelAgentStreams(dependencies, run);
  } catch (cause) {
    streamCause = cause;
  }
  await replayAgentPlanSnapshot(dependencies, run);
  await appendPausedRunEvent(dependencies, run, pendingAction);
  await releasePublishedRunThreadExecutionLease(dependencies, run);
  await resolvePausedDelegation(dependencies, run, pendingAction);
  clearChannelAgentStreamProgress(dependencies, run.data.id);
  if (streamCause) throw streamCause;
  return pendingAction;
}

export async function publishPersistedTerminalRun(
  dependencies: AgentRunWorkerDependencies,
  queue: AgentRunQueueMessage,
  run: RunRecordValue,
  knownLease?: RuntimeLeaseRecordValue,
): Promise<void> {
  let body: string | undefined;
  let shouldFinalizeStreams = run.data.status !== "completed";
  let streamCause: unknown;
  if (run.data.status === "completed") {
    const message = await finalizedMessageForRun(dependencies, queue, run);
    if (message) {
      await appendFinalizedMessage(dependencies, message);
      try {
        body =
          message.data.body ??
          (dependencies.readMessageBody
            ? await dependencies.readMessageBody(message)
            : "Agent response is available in Deployments.ai.");
        shouldFinalizeStreams = true;
      } catch (cause) {
        streamCause = cause;
      }
    }
  }
  if (shouldFinalizeStreams && !streamCause) {
    try {
      await finalizeChannelAgentStreams({
        ...(body !== undefined ? { body } : {}),
        dependencies,
        run,
      });
    } catch (cause) {
      streamCause = cause;
    }
  }
  await replayAgentPlanSnapshot(dependencies, run);
  await appendCanonicalRunTerminalEvent(dependencies, run);
  await releaseThreadSandboxKeptByRun(dependencies.threadSandbox, run);
  await releasePublishedRunThreadExecutionLease(dependencies, run, knownLease);
  await ensureCompletedRunMemoryFlush(dependencies, run, undefined, queue);
  await attemptTraceFinalization(dependencies.database, run, now(dependencies));
  await resolveAwaitedDelegation(dependencies, run);
  clearChannelAgentStreamProgress(dependencies, run.data.id);
  if (streamCause) throw streamCause;
}
