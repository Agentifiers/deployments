import {
  agentRunSandboxOwner,
  type AgentRunExecutionPins,
  type AgentRunResult,
  type RuntimeSandboxPolicy,
} from "@deployments-ai/agent-runtime";
import type { RunRecordValue } from "../types.ts";
import type { ThreadSandboxScope, ThreadSandboxWorkspace } from "./contracts.ts";

/** Time a run exit gives the thread sandbox release (snapshot, upload, destroy). */
const THREAD_SANDBOX_RELEASE_AFTER_EXIT_MS = 150_000;

export interface ThreadSandboxReleaseClock {
  /** Epoch milliseconds now. */
  readonly now: () => number;
  /** Epoch milliseconds of the host drain deadline; undefined while the host is not draining. */
  readonly drainDeadline?: () => number | undefined;
}

type RunSandboxInput = Omit<ThreadSandboxScope, "executionTargetId" | "executionTargetKind"> &
  AgentRunExecutionPins;

function runSandboxScope(
  input: Pick<
    RunSandboxInput,
    "environmentId" | "organizationId" | "projectId" | "runId" | "threadId"
  > & { readonly workspaceId?: string | undefined },
  owner: Pick<ThreadSandboxScope, "executionTargetId" | "executionTargetKind">,
): ThreadSandboxScope {
  return {
    ...owner,
    environmentId: input.environmentId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    runId: input.runId,
    threadId: input.threadId,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  };
}

/**
 * Runs one agent run slice and, for thread-persistent runs, snapshots and destroys the
 * thread's sandbox at every exit (result or throw) while the caller still owns the thread.
 * Release gets 150 s from the exit; a draining host caps it at its drain deadline.
 *
 * A checkpoint keeps the sandbox: the same run resumes at once and reacquires it, so a desktop's
 * windows and other processes outside `/workspace` survive the run's transaction-size slices. A
 * checkpoint on a draining host still releases, because the run may resume on another host.
 */
export async function executeWithThreadSandboxRelease<
  T extends Pick<AgentRunResult, "completionStatus">,
>(
  threadSandbox: ThreadSandboxWorkspace | undefined,
  input: RunSandboxInput & { readonly sandboxPolicy: RuntimeSandboxPolicy },
  clock: ThreadSandboxReleaseClock,
  execute: () => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  try {
    result = await execute();
    return result;
  } finally {
    const resumesHere =
      result?.completionStatus === "checkpointed" && clock.drainDeadline?.() === undefined;
    if (threadSandbox && input.sandboxPolicy.mode === "thread-persistent" && !resumesHere) {
      const exitDeadline = clock.now() + THREAD_SANDBOX_RELEASE_AFTER_EXIT_MS;
      const drainDeadline = clock.drainDeadline?.();
      await threadSandbox.release(runSandboxScope(input, agentRunSandboxOwner(input)), {
        deadline:
          drainDeadline === undefined ? exitDeadline : Math.min(exitDeadline, drainDeadline),
      });
    }
  }
}

/**
 * Releases a sandbox a checkpointed run kept, when the run then ends without resuming its tool
 * loop (canceled while queued, or failed before it was claimed again). A sandbox that a later run
 * of the thread has since leased is left alone.
 */
export async function releaseThreadSandboxKeptByRun(
  threadSandbox: ThreadSandboxWorkspace | undefined,
  run: RunRecordValue,
): Promise<void> {
  if (!threadSandbox || !run.data.checkpointCount) return;
  await threadSandbox.release(
    runSandboxScope({ ...run.data, runId: run.data.id }, agentRunSandboxOwner(run.data)),
    { onlyIfLeasedByRun: true },
  );
}
