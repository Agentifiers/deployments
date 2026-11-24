/* eslint-disable no-await-in-loop -- Worker transitions and stream events are ordered side effects. */

import {
  isRuntimeHostShutdown,
  RuntimeArtifactPersistenceError,
  RuntimeArtifactPublicationError,
  RuntimeToolPreparationRetryableError,
  createAgentRuntime,
  type AgentRunResult,
  type RuntimeModelInvocationAttempt,
  runtimeExecutionFailureState,
} from "@deployments-ai/agent-runtime";
import { makeConversationTemporalContinuityPersistence } from "@deployments-ai/db";
import {
  loadCausalThreadMessages,
  loadRunLookup,
  loadRun,
  loadThread,
  loadTriggerMessage,
  AgentRunWorkerRecordError,
} from "./records.ts";
import type {
  AgentRunQueueMessage,
  AgentRunQueueDelivery,
  AgentRunWorkerDependencies,
  MessageRecordValue,
  ProcessAgentRunResult,
  RunRecordValue,
  ThreadRecordValue,
} from "./types.ts";
import {
  loadRunExecutionTarget,
  runExecutionProfile,
  validateRunExecutionTarget,
  type RunExecutionTarget,
} from "./agent-run-execution-target.ts";
import { boundRunToolAuthorization } from "./execution-tool-policy.ts";
import {
  AgentRunClaimActiveError,
  DEFAULT_RUNNING_CLAIM_TIMEOUT_MS,
  agentRunRetryAttemptsExhausted,
  TERMINAL_STATUSES,
  agentRunRetryExhaustedError,
  assertPromptBinding,
  now,
  permanentTriggerBindingError,
  selectedPrompt,
} from "./agent-run-input.ts";
import { compileAgentManifestRuntime } from "./agent-manifest-runtime.ts";
import type {
  ClaimedRunOutcome,
  ReleaseRunClaim,
  RuntimeLeaseRecordValue,
} from "./agent-run-input.ts";
import { ExternalCancellationReconciledError } from "./agent-run-input.ts";
import {
  loadMatchingRunThreadExecutionLease,
  loadRunThreadExecutionLease,
  matchingRunThreadExecutionLease,
  progressEvent,
  recoverStaleForeignThreadExecutionLease,
  releasePublishedRunThreadExecutionLease,
  replaySameRunCallbackPublication,
} from "./agent-run-lease.ts";
import { executeWithThreadSandboxRelease } from "./thread-sandbox/run-exit.ts";
import { runtimeInput } from "./agent-run-runtime-input.ts";
import { admitAgentRunModels } from "./agent-run-model-admission.ts";
import { prefetch } from "./prefetch.ts";
import { createRuntimeRunLogger, progressLogEntry } from "./runtime-log-emitter.ts";
import {
  claimHeartbeatInterval,
  executeWithClaimHeartbeat,
  queueVisibilityExtensionTimeout,
  queueVisibilityRenewalInterval,
} from "./agent-run-claim.ts";
import { admitRun } from "./run-capacity.ts";
import {
  persistFailedRun,
  persistInterruptedRun,
  persistRetryableRun,
} from "./agent-run-terminal.ts";
import { persistRuntimeResult } from "./agent-run-result-persistence.ts";
import { persistModelInvocationAtProviderBoundary } from "./model-invocations.ts";
import {
  captureModelInvocationFailure,
  recoverModelFallbackStartIndex,
} from "./agent-run-model-recovery.ts";
import { attemptTraceFinalization } from "./trace-finalization.ts";
import {
  externalCancellationReconciler,
  type ExternalCancellationExecutionState,
} from "./external-cancellation-persistence.ts";
import { publishAgentRunOutcome } from "./agent-run-outcome.ts";
import { ensureCompletedRunMemoryFlush } from "./agent-run-memory.ts";
import {
  ensureChannelAgentStreams,
  finalizeChannelAgentStreams,
  isChannelAgentStreamInitializationRetryable,
} from "./channel-agent-stream.ts";
import {
  publishPersistedPausedRun,
  publishPersistedTerminalRun,
} from "./agent-run-replay-publication.ts";
import { publishAgentPlanUpdate } from "./agent-run-plan.ts";
import { createAssistantTokenStream } from "./assistant-token-stream.ts";
import { resolveAwaitedDelegation } from "./agent-delegation-results.ts";

const RETRYABLE_QUEUE_BACKOFF_SECONDS = 60;

export async function processAgentRun(
  queue: AgentRunQueueMessage,
  dependencies: AgentRunWorkerDependencies,
  delivery?: AgentRunQueueDelivery,
): Promise<ProcessAgentRunResult> {
  let initial = await loadRun(dependencies.database, queue);
  if (!initial) {
    const lookup = await loadRunLookup(dependencies.database, queue, queue.runId);
    if (!lookup) return { action: "skipped", reason: "Run was not found." };
    if (lookup.data.idempotencyKey !== queue.idempotencyKey) {
      throw new AgentRunWorkerRecordError(
        "run_queue_binding_mismatch",
        "Queue idempotency key does not match the canonical run lookup.",
      );
    }
    throw new AgentRunWorkerRecordError(
      "run_lookup_orphaned",
      "Canonical run lookup does not resolve to its run record.",
    );
  }
  if (initial.data.status === "canceled" && initial.data.claimedBy) {
    const lease = await loadMatchingRunThreadExecutionLease(dependencies, initial);
    if (lease) throw new AgentRunClaimActiveError(initial.data.id);
  }
  const callbackReplay = await replaySameRunCallbackPublication(dependencies, initial);
  if (callbackReplay === "terminal") {
    await finalizeChannelAgentStreams({ dependencies, run: initial });
    await releasePublishedRunThreadExecutionLease(dependencies, initial);
    await ensureCompletedRunMemoryFlush(dependencies, initial, undefined, queue);
    await attemptTraceFinalization(dependencies.database, initial, now(dependencies));
    await resolveAwaitedDelegation(dependencies, initial);
    return {
      action: "skipped",
      reason: `Run is already ${initial.data.status}.`,
      run: initial,
    };
  }
  if (TERMINAL_STATUSES.has(initial.data.status)) {
    await publishPersistedTerminalRun(dependencies, queue, initial);
    return {
      action: "skipped",
      reason: `Run is already ${initial.data.status}.`,
      run: initial,
    };
  }
  if (
    initial.data.status === "waiting-for-approval" ||
    initial.data.status === "waiting-for-tool"
  ) {
    const pendingAction = await publishPersistedPausedRun(dependencies, initial);
    return {
      action: "paused",
      pendingAction,
      run: initial,
      status: initial.data.status,
    };
  }
  const claimTimeoutMs = dependencies.runningClaimTimeoutMs ?? DEFAULT_RUNNING_CLAIM_TIMEOUT_MS;
  if (!Number.isSafeInteger(claimTimeoutMs) || claimTimeoutMs <= 1) {
    throw new AgentRunWorkerRecordError(
      "invalid_claim_timeout",
      "Run claim timeout must be an integer greater than one millisecond.",
    );
  }
  const heartbeatAt = initial.data.heartbeatAt ? Date.parse(initial.data.heartbeatAt) : Number.NaN;
  const claimEvaluationTime = now(dependencies).getTime();
  const heartbeatAge = claimEvaluationTime - heartbeatAt;
  const runningClaimExpired =
    initial.data.status === "running" &&
    (!Number.isFinite(heartbeatAt) ||
      heartbeatAge >= claimTimeoutMs ||
      heartbeatAge < -claimTimeoutMs);
  if (initial.data.status === "running" && !runningClaimExpired) {
    throw new AgentRunClaimActiveError(initial.data.id);
  }
  if (initial.data.status !== "queued" && !runningClaimExpired) {
    return {
      action: "skipped",
      reason: `Run cannot be claimed from ${initial.data.status}.`,
      run: initial,
    };
  }

  if (await recoverStaleForeignThreadExecutionLease(dependencies, queue, claimTimeoutMs)) {
    return {
      action: "requeued",
      reason: "Run was requeued behind recovered callback work.",
      retryAfterSeconds: RETRYABLE_QUEUE_BACKOFF_SECONDS,
    };
  }

  const heartbeatIntervalMs = claimHeartbeatInterval(dependencies, claimTimeoutMs);
  const visibilityRenewalIntervalMs = queueVisibilityRenewalInterval(dependencies);
  const visibilityTimeoutMs = queueVisibilityExtensionTimeout(dependencies);
  const leaseRead = prefetch(loadRunThreadExecutionLease(dependencies, initial));
  const pinsRead = prefetch(
    Promise.all([
      loadThread(dependencies.database, queue),
      loadRunExecutionTarget(dependencies.database, queue, initial),
    ]),
  );
  const triggerRead = prefetch(loadTriggerMessage(dependencies.database, queue));
  const runLookupRead = prefetch(loadRunLookup(dependencies.database, queue, initial.data.id));
  const preclaimLease = await leaseRead;
  const preclaimRunLease = matchingRunThreadExecutionLease(preclaimLease, initial);
  let thread: ThreadRecordValue;
  let target: RunExecutionTarget;
  try {
    [thread, target] = await pinsRead;
  } catch (cause) {
    if (!(cause instanceof AgentRunWorkerRecordError) || cause.code !== "record_not_found") {
      throw cause;
    }
    const failed = await persistFailedRun(dependencies, initial, cause, preclaimRunLease);
    await publishPersistedTerminalRun(dependencies, queue, failed, preclaimRunLease);
    return { action: "skipped", reason: "Run pins are missing.", run: failed };
  }
  let trigger: MessageRecordValue;
  try {
    const loaded = await triggerRead;
    assertPromptBinding(loaded, queue.userMessageId, initial);
    trigger = loaded;
  } catch (cause) {
    if (!permanentTriggerBindingError(cause)) throw cause;
    const failed = await persistFailedRun(dependencies, initial, cause, preclaimRunLease);
    await publishPersistedTerminalRun(dependencies, queue, failed, preclaimRunLease);
    return {
      action: "skipped",
      reason: "Run trigger message is invalid.",
      run: failed,
    };
  }

  try {
    validateRunExecutionTarget(initial, thread, target, now(dependencies));
  } catch (cause) {
    const failed = await persistFailedRun(dependencies, initial, cause, preclaimRunLease);
    await publishPersistedTerminalRun(dependencies, queue, failed, preclaimRunLease);
    return {
      action: "skipped",
      reason: "Run pins are not executable.",
      run: failed,
    };
  }

  let claimed: RunRecordValue;
  let threadLease: RuntimeLeaseRecordValue;
  try {
    const admission = await admitRun({
      basis: { lease: preclaimLease, run: initial, runLookup: await runLookupRead, target, thread },
      claimTimeoutMs,
      dependencies,
      queue,
      receiveCount: delivery?.receiveCount,
      runLease: preclaimRunLease,
    });
    if (admission.kind === "settled") return admission.result;
    claimed = admission.claim.run;
    threadLease = admission.claim.lease;
  } catch (cause) {
    const latestRun = await loadRun(dependencies.database, queue);
    if (
      latestRun &&
      latestRun.data.status === initial.data.status &&
      latestRun.data.version === initial.data.version
    ) {
      const [latestThread, latestTarget] = await Promise.all([
        loadThread(dependencies.database, queue),
        loadRunExecutionTarget(dependencies.database, queue, latestRun),
      ]);
      try {
        validateRunExecutionTarget(latestRun, latestThread, latestTarget, now(dependencies));
      } catch (pinCause) {
        const latestLease =
          latestRun.data.status === "queued" || runningClaimExpired
            ? await loadMatchingRunThreadExecutionLease(dependencies, latestRun)
            : undefined;
        const failed = await persistFailedRun(dependencies, latestRun, pinCause, latestLease);
        await publishPersistedTerminalRun(dependencies, queue, failed, latestLease);
        return {
          action: "skipped",
          reason: "Run pins became non-executable.",
          run: failed,
        };
      }
    }
    throw cause;
  }
  const profile = runExecutionProfile(target);
  const releaseContinuity =
    target.kind === "deployment"
      ? {
          agentDefinitionId: target.release.data.agentDefinitionId,
          currentAgentDeploymentId: target.deployment.data.id,
        }
      : undefined;
  let outcome: ClaimedRunOutcome;
  // The agent generation gateway mints run tokens only while this claim is registered.
  const unregisterModelLease = dependencies.runModelTokens?.register({
    leaseOwner: threadLease.data.owner,
    organizationId: claimed.data.organizationId,
    runId: claimed.data.id,
    threadId: claimed.data.threadId,
  });
  const runLogger = dependencies.runtimeLogs
    ? createRuntimeRunLogger({
        database: dependencies.database,
        now: () => now(dependencies),
        run: claimed,
        workerId: dependencies.workerId,
      })
    : undefined;
  const unregisterRunLogger = runLogger
    ? dependencies.runtimeLogs?.register(claimed.data.id, runLogger)
    : undefined;
  try {
    outcome = await executeWithClaimHeartbeat<ClaimedRunOutcome>(
      dependencies,
      queue,
      delivery,
      claimed,
      threadLease,
      claimTimeoutMs,
      heartbeatIntervalMs,
      visibilityRenewalIntervalMs,
      visibilityTimeoutMs,
      (renewed) => {
        claimed = renewed.run;
        threadLease = renewed.lease;
      },
      async (signal, releaseClaim, withClaimSnapshot, acknowledgeExternalCancellation) => {
        let modelInvocationAttempts: RuntimeModelInvocationAttempt[] = [];
        let cancellationState: ExternalCancellationExecutionState = {
          completedToolCalls: [],
          message: "Agent run was canceled before terminal persistence.",
          usage: [],
        };
        const reconcileCancellation = externalCancellationReconciler(
          dependencies,
          queue,
          () => cancellationState,
          () => modelInvocationAttempts,
        );
        const releaseClaimWithCancellation: ReleaseRunClaim = (release) =>
          releaseClaim(release, reconcileCancellation);
        let recoveredModelFallbackStartIndex: number | undefined;
        let claimedThread!: ThreadRecordValue;
        let result!: AgentRunResult;
        try {
          if (runningClaimExpired) {
            recoveredModelFallbackStartIndex = await recoverModelFallbackStartIndex(
              dependencies.database,
              initial,
            );
          }
          claimedThread = await loadThread(dependencies.database, queue);
          validateRunExecutionTarget(claimed, claimedThread, target, now(dependencies));
          const compiledManifest = compileAgentManifestRuntime(profile.manifest);
          const messageContextRead = prefetch(
            loadCausalThreadMessages(
              dependencies.database,
              queue,
              trigger,
              compiledManifest.recentMessageCharacterBudget,
              compiledManifest.contextCheckpointMode,
              claimedThread.data.continuedFromThreadId && releaseContinuity
                ? {
                    ...releaseContinuity,
                    environmentId: claimed.data.environmentId,
                    organizationId: claimed.data.organizationId,
                    projectId: claimed.data.projectId,
                    threadId: claimed.data.threadId,
                    ...(claimed.data.workspaceId ? { workspaceId: claimed.data.workspaceId } : {}),
                  }
                : undefined,
            ),
          );
          const promptRead = prefetch(selectedPrompt(trigger, dependencies, signal));
          const modelAdmissionRead = prefetch(
            admitAgentRunModels(
              dependencies,
              claimed,
              compiledManifest,
              profile.pins.agentDefinitionId,
            ),
          );
          await ensureChannelAgentStreams(dependencies, claimed, trigger, signal);
          const messageContext = await messageContextRead;
          const prompt = await promptRead;
          const conversationTimingAnchor =
            claimedThread.data.continuedFromThreadId &&
            releaseContinuity &&
            !messageContext.priorMessages.some(
              (message) => message.data.role === "assistant" || message.data.role === "user",
            )
              ? await makeConversationTemporalContinuityPersistence(
                  dependencies.database,
                ).latestReplayablePredecessorMessage(
                  {
                    ...releaseContinuity,
                    environmentId: claimed.data.environmentId,
                    organizationId: claimed.data.organizationId,
                    projectId: claimed.data.projectId,
                    threadId: claimed.data.threadId,
                    throughCreatedAt: trigger.data.createdAt,
                    ...(claimed.data.workspaceId ? { workspaceId: claimed.data.workspaceId } : {}),
                  },
                  signal,
                )
              : undefined;
          const assistantTextStream = createAssistantTokenStream(dependencies, claimed);
          const runtime = createAgentRuntime({
            // Runtime timestamps (usage, progress) share the worker claim clock.
            now: () => now(dependencies).getTime(),
            ...dependencies.runtime,
            ...(profile.toolPolicy !== "deployment" && dependencies.runtime.authorizeToolCall
              ? {
                  authorizeToolCall: boundRunToolAuthorization(
                    dependencies.runtime.authorizeToolCall,
                    profile.toolPolicy,
                  ),
                }
              : {}),
            appendProgress: (event) => {
              runLogger?.log(progressLogEntry(event));
              return progressEvent(dependencies, event, claimed);
            },
            ...(assistantTextStream ? { assistantTextStream } : {}),
            ...(dependencies.createExecutionInputArtifactLoader
              ? { loadInputArtifacts: dependencies.createExecutionInputArtifactLoader() }
              : {}),
            publishAgentPlan: (event) =>
              withClaimSnapshot(({ lease, run }) =>
                publishAgentPlanUpdate(dependencies, event, run, lease),
              ),
            shouldCancel: async (runId) => {
              if (await dependencies.runtime.shouldCancel?.(runId)) return true;
              const latest = await loadRun(dependencies.database, queue);
              return latest?.data.id === runId && latest.data.status === "canceled";
            },
            recordModelInvocation: async (attempt) => {
              await withClaimSnapshot(async ({ lease, run }) => {
                await persistModelInvocationAtProviderBoundary(
                  dependencies,
                  queue,
                  run,
                  lease,
                  attempt,
                );
              });
              modelInvocationAttempts.push(attempt);
            },
          });
          const runInput = await runtimeInput({
            ...(messageContext.checkpoint ? { checkpoint: messageContext.checkpoint } : {}),
            ...(conversationTimingAnchor ? { conversationTimingAnchor } : {}),
            dependencies,
            messages: messageContext.priorMessages,
            modelAdmission: await modelAdmissionRead,
            profile,
            prompt,
            run: claimed,
            signal,
            userMessage: trigger,
          });
          result = await executeWithThreadSandboxRelease(
            dependencies.threadSandbox,
            runInput,
            {
              now: () => now(dependencies).getTime(),
              ...(dependencies.hostDrain ? { drainDeadline: dependencies.hostDrain.deadline } : {}),
            },
            () =>
              runtime.execute({
                ...runInput,
                ...(recoveredModelFallbackStartIndex !== undefined
                  ? { modelFallbackStartIndex: recoveredModelFallbackStartIndex }
                  : {}),
              }),
          );
          cancellationState = {
            ...(result.artifactContinuation
              ? { artifactContinuation: result.artifactContinuation }
              : {}),
            completedToolCalls: result.completedToolCalls,
            message: result.assistantMessage,
            ...(result.modelContinuation ? { modelContinuation: result.modelContinuation } : {}),
            ...(result.pendingAction ? { pendingAction: result.pendingAction } : {}),
            usage: result.usage,
          };
        } catch (cause) {
          const { capturedInvocationAttempts, invalidInvocationUsage, persistenceCause } =
            captureModelInvocationFailure(cause, modelInvocationAttempts);
          modelInvocationAttempts = capturedInvocationAttempts;
          const failureState = runtimeExecutionFailureState(cause);
          cancellationState = {
            ...(failureState?.artifactContinuation
              ? { artifactContinuation: failureState.artifactContinuation }
              : {}),
            completedToolCalls: failureState?.completedToolCalls ?? [],
            message: "Agent run was canceled while reconciling a runtime failure.",
            ...(failureState?.modelContinuation
              ? { modelContinuation: failureState.modelContinuation }
              : {}),
            usage: invalidInvocationUsage ? [] : (failureState?.usage ?? []),
          };
          if (invalidInvocationUsage) {
            const failed = await releaseClaimWithCancellation(({ lease, run }) =>
              persistFailedRun(
                dependencies,
                run,
                persistenceCause,
                lease,
                failureState?.completedToolCalls,
                [],
                failureState?.artifactContinuation,
                failureState?.modelContinuation,
                capturedInvocationAttempts,
              ),
            );
            return { cause, kind: "failed", run: failed };
          }
          // A host-shutdown stop is not a failure: persist the progress made and requeue the run.
          if (
            isRuntimeHostShutdown(signal) &&
            !(cause instanceof RuntimeArtifactPersistenceError)
          ) {
            const interrupted = await releaseClaimWithCancellation(({ lease, run }) =>
              persistInterruptedRun(dependencies, run, lease, {
                ...(failureState?.artifactContinuation
                  ? { artifactContinuation: failureState.artifactContinuation }
                  : {}),
                completedToolCalls: failureState?.completedToolCalls ?? [],
                ...(failureState?.modelContinuation
                  ? { modelContinuation: failureState.modelContinuation }
                  : {}),
                modelInvocationAttempts: capturedInvocationAttempts,
                usage: failureState?.usage ?? [],
              }),
            );
            return { kind: "interrupted", run: interrupted };
          }
          if (
            cause instanceof RuntimeArtifactPublicationError ||
            cause instanceof RuntimeToolPreparationRetryableError ||
            isChannelAgentStreamInitializationRetryable(cause)
          ) {
            if (agentRunRetryAttemptsExhausted(claimed)) {
              const failed = await releaseClaimWithCancellation(({ lease, run }) =>
                persistFailedRun(
                  dependencies,
                  run,
                  agentRunRetryExhaustedError(),
                  lease,
                  failureState?.completedToolCalls,
                  failureState?.usage,
                  failureState?.artifactContinuation,
                  failureState?.modelContinuation,
                  capturedInvocationAttempts,
                ),
              );
              return { cause, kind: "failed", run: failed };
            }
            const retryable = await releaseClaimWithCancellation(({ lease, run }) =>
              persistRetryableRun(
                dependencies,
                run,
                cause,
                lease,
                failureState?.completedToolCalls,
                failureState?.artifactContinuation,
                failureState?.usage,
                failureState?.modelContinuation,
                capturedInvocationAttempts,
              ),
            );
            return { cause, kind: "retryable", run: retryable };
          }
          const failed = await releaseClaimWithCancellation(({ lease, run }) =>
            persistFailedRun(
              dependencies,
              run,
              cause,
              lease,
              failureState?.completedToolCalls,
              failureState?.usage,
              failureState?.artifactContinuation,
              failureState?.modelContinuation,
              capturedInvocationAttempts,
            ),
          );
          return { cause, kind: "failed", run: failed };
        }

        return persistRuntimeResult({
          acknowledgeExternalCancellation,
          claimedThread,
          currentRun: () => claimed,
          dependencies,
          manifest: profile.manifest,
          modelInvocationAttempts,
          queue,
          releaseClaimWithCancellation,
          result,
          signal,
        });
      },
    );
  } catch (cause) {
    if (!(cause instanceof ExternalCancellationReconciledError)) throw cause;
    outcome = { kind: "canceled", run: cause.run };
  } finally {
    unregisterModelLease?.();
    unregisterRunLogger?.();
    await runLogger?.close();
  }

  return publishAgentRunOutcome(dependencies, outcome);
}
