/* eslint-disable no-await-in-loop -- Worker transitions are ordered side effects. */

import type { AgentRunResult, RuntimeModelInvocationAttempt } from "@deployments-ai/agent-runtime";
import { AgentRunWorkerRecordError } from "./records.ts";
import type {
  AgentRunQueueMessage,
  AgentRunWorkerDependencies,
  RunRecordValue,
  ThreadRecordValue,
} from "./types.ts";
import { AgentRunMessageBodyWriteOutcomeUnknownError } from "./types.ts";
import { CompletionNotCommittedError, MAX_AGENT_RUN_CHECKPOINTS } from "./agent-run-input.ts";
import type {
  AcknowledgeExternalCancellation,
  ClaimedRunOutcome,
  CompletedRunPlan,
  ReleaseRunClaim,
} from "./agent-run-input.ts";
import { compileAgentManifestRuntime } from "./agent-manifest-runtime.ts";
import type { RunExecutionProfile } from "./agent-run-execution-target.ts";
import {
  cleanupPreparedMessageBody,
  persistCompletedRun,
  persistPausedRun,
  prepareCompletedRun,
} from "./agent-run-completion.ts";
import {
  persistCanceledRun,
  persistCheckpointedRun,
  persistFailedRun,
  persistInterruptedRun,
} from "./agent-run-terminal.ts";
import { persistExternalCancellationState } from "./external-cancellation-persistence.ts";

export interface RuntimeResultPersistenceInput {
  readonly acknowledgeExternalCancellation: AcknowledgeExternalCancellation;
  readonly claimedThread: ThreadRecordValue;
  /** Reads the latest heartbeat-renewed run claim. */
  readonly currentRun: () => RunRecordValue;
  readonly dependencies: AgentRunWorkerDependencies;
  readonly modelInvocationAttempts: RuntimeModelInvocationAttempt[];
  readonly queue: AgentRunQueueMessage;
  readonly releaseClaimWithCancellation: ReleaseRunClaim;
  /** Frozen manifest of the run's execution target (release or execution binding). */
  readonly manifest: RunExecutionProfile["manifest"];
  readonly result: AgentRunResult;
  readonly signal: AbortSignal;
}

/**
 * Persists a claimed run's runtime result as paused, checkpointed, interrupted, canceled, or
 * completed.
 */
export async function persistRuntimeResult(
  input: RuntimeResultPersistenceInput,
): Promise<ClaimedRunOutcome> {
  const {
    acknowledgeExternalCancellation,
    claimedThread,
    currentRun,
    dependencies,
    modelInvocationAttempts,
    queue,
    releaseClaimWithCancellation,
    manifest,
    result,
    signal,
  } = input;
  if (
    result.completionStatus === "waiting-for-approval" ||
    result.completionStatus === "waiting-for-tool"
  ) {
    if (!result.pendingAction) {
      const cause = new Error("Paused runtime result did not include pending action correlation.");
      const failed = await releaseClaimWithCancellation(({ lease, run }) =>
        persistFailedRun(
          dependencies,
          run,
          cause,
          lease,
          result.completedToolCalls,
          result.usage,
          result.artifactContinuation,
          result.modelContinuation,
          modelInvocationAttempts,
        ),
      );
      return { cause, kind: "failed", run: failed };
    }
    const pendingAction = result.pendingAction;
    const pausedStatus = result.completionStatus;
    const paused = await releaseClaimWithCancellation(({ lease, run }) =>
      persistPausedRun(
        dependencies,
        run,
        lease,
        pausedStatus,
        result.assistantMessage,
        result.completedToolCalls,
        pendingAction,
        result.artifactContinuation,
        result.modelContinuation,
        result.usage,
        modelInvocationAttempts,
      ),
    );
    return {
      kind: "paused",
      pendingAction,
      run: paused,
      status: pausedStatus,
    };
  }
  if (result.completionStatus === "checkpointed") {
    if ((currentRun().data.checkpointCount ?? 0) >= MAX_AGENT_RUN_CHECKPOINTS) {
      const cause = new AgentRunWorkerRecordError(
        "run_checkpoint_limit_exhausted",
        `Agent run failed after reaching the ${MAX_AGENT_RUN_CHECKPOINTS}-checkpoint limit without finishing.`,
      );
      const failed = await releaseClaimWithCancellation(({ lease, run }) =>
        persistFailedRun(
          dependencies,
          run,
          cause,
          lease,
          result.completedToolCalls,
          result.usage,
          result.artifactContinuation,
          result.modelContinuation,
          modelInvocationAttempts,
        ),
      );
      return { cause, kind: "failed", run: failed };
    }
    const checkpointed = await releaseClaimWithCancellation(({ lease, run }) =>
      persistCheckpointedRun(dependencies, run, lease, {
        ...(result.artifactContinuation
          ? { artifactContinuation: result.artifactContinuation }
          : {}),
        completedToolCalls: result.completedToolCalls,
        ...(result.modelContinuation ? { modelContinuation: result.modelContinuation } : {}),
        modelInvocationAttempts,
        usage: result.usage,
      }),
    );
    return { kind: "checkpointed", run: checkpointed };
  }
  if (result.completionStatus === "interrupted") {
    const interrupted = await releaseClaimWithCancellation(({ lease, run }) =>
      persistInterruptedRun(dependencies, run, lease, {
        ...(result.artifactContinuation
          ? { artifactContinuation: result.artifactContinuation }
          : {}),
        completedToolCalls: result.completedToolCalls,
        ...(result.modelContinuation ? { modelContinuation: result.modelContinuation } : {}),
        modelInvocationAttempts,
        usage: result.usage,
      }),
    );
    return { kind: "interrupted", run: interrupted };
  }
  if (result.completionStatus === "canceled") {
    const externalCancellation = await persistExternalCancellationState(
      dependencies,
      queue,
      currentRun(),
      result.assistantMessage,
      result.completedToolCalls,
      result.pendingAction,
      result.usage,
      result.artifactContinuation,
      result.modelContinuation,
      modelInvocationAttempts,
    );
    if (externalCancellation) {
      await acknowledgeExternalCancellation();
      return { kind: "canceled", run: externalCancellation };
    }
    const canceled = await releaseClaimWithCancellation(({ lease, run }) =>
      persistCanceledRun(
        dependencies,
        run,
        lease,
        result.assistantMessage,
        result.completedToolCalls,
        result.pendingAction,
        result.usage,
        result.artifactContinuation,
        result.modelContinuation,
        modelInvocationAttempts,
      ),
    );
    return { kind: "canceled", run: canceled };
  }

  let completionPlan: CompletedRunPlan;
  try {
    completionPlan = await prepareCompletedRun(
      dependencies,
      currentRun(),
      result.assistantMessage,
      result.completedToolCalls,
      result.brainEvidence,
      result.usage,
      signal,
    );
  } catch (cause) {
    if (cause instanceof AgentRunMessageBodyWriteOutcomeUnknownError) throw cause;
    const failedUsage =
      cause instanceof AgentRunWorkerRecordError && cause.code === "invalid_usage_entry"
        ? []
        : result.usage;
    const failed = await releaseClaimWithCancellation(({ lease, run }) =>
      persistFailedRun(
        dependencies,
        run,
        cause,
        lease,
        result.completedToolCalls,
        failedUsage,
        result.artifactContinuation,
        result.modelContinuation,
        modelInvocationAttempts,
      ),
    );
    return { cause, kind: "failed", run: failed };
  }
  try {
    const completed = await releaseClaimWithCancellation(async ({ lease, run }) => {
      return persistCompletedRun(
        dependencies,
        queue,
        run,
        claimedThread,
        lease,
        completionPlan,
        result.modelId,
        modelInvocationAttempts,
      );
    });
    const compiled = compileAgentManifestRuntime(manifest);
    return {
      contextCheckpointMode: compiled.contextCheckpointMode,
      kind: "completed",
      memoryMode: compiled.memoryMode,
      memoryModelId: compiled.modelId,
      ...(compiled.memoryReviewMode ? { memoryReviewMode: compiled.memoryReviewMode } : {}),
      message: completed.message,
      run: completed.run,
    };
  } catch (cause) {
    const persistenceCause =
      cause instanceof CompletionNotCommittedError ? cause.persistenceCause : cause;
    if (
      !(cause instanceof CompletionNotCommittedError) &&
      !(cause instanceof AgentRunWorkerRecordError)
    ) {
      throw cause;
    }
    if (!(persistenceCause instanceof AgentRunWorkerRecordError)) throw persistenceCause;
    // The completion is known absent and this run still owns the thread barrier.
    await cleanupPreparedMessageBody(dependencies, completionPlan, currentRun());
    const failed = await releaseClaimWithCancellation(({ lease, run }) =>
      persistFailedRun(
        dependencies,
        run,
        persistenceCause,
        lease,
        result.completedToolCalls,
        result.usage,
        result.artifactContinuation,
        result.modelContinuation,
        modelInvocationAttempts,
      ),
    );
    return { cause: persistenceCause, kind: "failed", run: failed };
  }
}
