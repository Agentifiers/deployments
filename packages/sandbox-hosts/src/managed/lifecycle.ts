import { fromDatabase, sandboxHostPersistence } from "@deployments-ai/db";
import { isDeepStrictEqual } from "node:util";
import { Effect } from "effect";
import {
  SandboxOperationError,
  SandboxRecordError,
  type ManagerBase,
  type SandboxManagerService,
} from "./contracts.ts";
import {
  checkpointOutcomeMayBeSuspended,
  dataPlaneOutcomeMayBeInFlight,
  destroyOutcomeMayHaveCompleted,
  assertResumedLeaseMatches,
  leaseFromRecord,
  reconcileResumedLease,
  resumeOutcomeMayBeActive,
} from "./leases.ts";
import { operationError } from "./operations.ts";
import { timestamp, updateLeaseRecord } from "./records.ts";
import type { AllocationRuntime } from "./allocation.ts";
import type { CapacityRuntime } from "./capacity.ts";
import type { CompensationRuntime } from "./compensation.ts";
import type { CreateReconciliationRuntime } from "./create-reconciliation.ts";
import type { LifecycleReconciliationRuntime } from "./lifecycle-reconciliation.ts";
import type { OperationRuntime } from "./operations.ts";
import type { StateRuntime } from "./state.ts";
import type { TransitionRuntime } from "./transitions.ts";

const RECOVERABLE_RESUME_FAILURES = new Set([
  "provider-checkpoint-outcome-unknown",
  "provider-resume-failed",
  "provider-resume-identity-mismatch",
]);

function isPersistenceUnknown(error: { readonly _tag: string }) {
  return error._tag === "SandboxPersistenceUnknownError";
}

export function createLifecycleMethods(
  context: ManagerBase &
    TransitionRuntime &
    OperationRuntime &
    StateRuntime &
    CapacityRuntime &
    CompensationRuntime &
    AllocationRuntime &
    CreateReconciliationRuntime &
    LifecycleReconciliationRuntime,
): SandboxManagerService {
  const {
    provider,
    database,
    now,
    transition,
    terminalTransition,
    prepareTerminalTransition,
    commitTransition,
    commitHoldingTransitionRetryingAfterStaleHolderDestroy,
    commitDestroyCompletion,
    commitPreparedTransitionWithRetry,
    unlockedProviderCall,
    unlockedProviderMutation,
    acquireLeaseOperationGuard,
    releaseLeaseOperationGuard,
    withLeaseOperationLock,
    guardedDownloadStream,
    requireReady,
    requireLifecycleState,
    compensateResumedLease,
    create,
    reconcileCreate,
    reconcileCreateWithCleanup,
    reconcileCreateWithLease,
    reconcileCheckpoint,
    reconcileCheckpointWithResult,
    reconcileResume,
    reconcileResumeWithLease,
    resolveCreateAsNotAllocated,
  } = context;
  return {
    checkpoint: (sandbox, label) =>
      withLeaseOperationLock(sandbox.record.data, "checkpoint", (signal, retain) =>
        Effect.gen(function* () {
          const lease = yield* requireLifecycleState(sandbox, "checkpoint", ["ready"]);
          const checkpointRequestedAt = now();
          const checkpointing = yield* updateLeaseRecord(
            sandbox.record,
            {
              checkpointRequestedAt: timestamp(checkpointRequestedAt),
              status: "checkpointing",
            },
            checkpointRequestedAt,
          ).pipe(
            Effect.flatMap((record) =>
              commitTransition(sandbox.record, record, "sandbox.checkpointing"),
            ),
          );
          const result = yield* Effect.result(
            unlockedProviderMutation(
              "checkpoint",
              checkpointing.data.id,
              (combinedSignal) =>
                provider.checkpoint({
                  lease,
                  signal: combinedSignal,
                  ...(label ? { label } : {}),
                }),
              signal,
            ),
          );
          if (result._tag === "Failure") {
            const mayBeSuspended = checkpointOutcomeMayBeSuspended(result.failure);
            if (mayBeSuspended) retain();
            if (mayBeSuspended && provider.reconcileCheckpoint) {
              yield* transition(
                checkpointing,
                {
                  failureReason: "provider-checkpoint-outcome-unknown",
                  status: "checkpointing",
                },
                "sandbox.checkpointing",
              );
            } else {
              yield* terminalTransition(
                checkpointing,
                {
                  failureReason: mayBeSuspended
                    ? "provider-checkpoint-outcome-unknown"
                    : "provider-checkpoint-failed",
                  status: "error",
                },
                "sandbox.failed",
                mayBeSuspended ? { nextComputeUsageActive: false } : {},
              );
            }
            return yield* Effect.fail(result.failure);
          }
          if (result.success.provider !== provider.name) {
            yield* terminalTransition(
              checkpointing,
              {
                failureReason: "provider-checkpoint-provider-mismatch",
                status: "error",
              },
              "sandbox.failed",
            );
            return yield* Effect.fail(
              new SandboxRecordError({
                cause: result.success,
                message: "Sandbox checkpoint returned the wrong provider.",
              }),
            );
          }
          const observedAt = now();
          const minimumCompletedAt = Math.max(
            Date.parse(checkpointing.data.checkpointRequestedAt ?? checkpointing.data.updatedAt),
            Date.parse(
              checkpointing.data.usageAccountedThrough ?? checkpointing.data.usageStartedAt,
            ),
          );
          const completedAt =
            Number.isFinite(result.success.createdAt) &&
            result.success.createdAt >= minimumCompletedAt &&
            result.success.createdAt <= observedAt
              ? result.success.createdAt
              : observedAt;
          const suspendedTransition = yield* prepareTerminalTransition(
            checkpointing,
            {
              checkpointRef: result.success.checkpointRef,
              status: "suspended",
            },
            "sandbox.suspended",
            {
              completedAt,
              nextComputeUsageActive: false,
              transitionAt: observedAt,
            },
          );
          const suspendedCommit = yield* Effect.result(suspendedTransition.commit);
          if (suspendedCommit._tag === "Failure" && isPersistenceUnknown(suspendedCommit.failure)) {
            return yield* Effect.fail(suspendedCommit.failure);
          }
          const persisted =
            suspendedCommit._tag === "Success"
              ? suspendedCommit.success
              : yield* suspendedTransition.commit.pipe(
                  Effect.mapError(
                    (recoveryFailure) =>
                      new SandboxOperationError({
                        cause: {
                          originalFailure: suspendedCommit.failure,
                          recoveryFailure,
                        },
                        leaseId: checkpointing.data.id,
                        message: `Sandbox checkpoint persistence failed for provider ${provider.name}.`,
                        operation: "checkpoint-persistence",
                        provider: provider.name,
                      }),
                  ),
                );
          return {
            checkpoint: result.success,
            lease: {
              ...lease,
              checkpointRef: result.success.checkpointRef,
              status: "suspended",
            },
            record: persisted,
          };
        }),
      ),
    create,
    destroy: (sandbox) =>
      withLeaseOperationLock(sandbox.record.data, "destroy", (signal, retain) =>
        Effect.gen(function* () {
          if (sandbox.record.data.status === "destroyed") return sandbox.record;
          if (sandbox.record.data.status === "releasing") {
            const current = yield* fromDatabase(() =>
              sandboxHostPersistence.read(
                database,
                "execution",
                { pk: sandbox.record.pk, sk: sandbox.record.sk },
                true,
              ),
            );
            if (current === undefined || current.itemType !== "sandbox-lease") {
              return yield* Effect.fail(
                new SandboxRecordError({
                  cause: current,
                  message: "Sandbox destroy state is unavailable; reload before retrying.",
                }),
              );
            }
            if (!isDeepStrictEqual(current, sandbox.record)) {
              if (current.data.status === "destroyed") return current;
              if (current.data.status === "releasing" && current.data.destroyCompletedAt) {
                return yield* terminalTransition(
                  current,
                  { status: "destroyed" },
                  "sandbox.destroyed",
                  {
                    completedAt: Date.parse(current.data.destroyCompletedAt),
                    removeFields: ["destroyCompletedAt"],
                  },
                );
              }
              return yield* Effect.fail(
                new SandboxRecordError({
                  cause: current,
                  message: "Sandbox destroy state changed; reload before retrying.",
                }),
              );
            }
          }
          const lease = yield* requireLifecycleState(sandbox, "destroy", [
            "checkpointing",
            "creating",
            "error",
            "ready",
            "releasing",
            "resuming",
            "suspended",
          ]);
          const releasing =
            sandbox.record.data.status === "releasing"
              ? sandbox.record
              : yield* transition(sandbox.record, { status: "releasing" }, "sandbox.releasing", [
                  "failureReason",
                ]);
          if (releasing.data.destroyCompletedAt) {
            return yield* terminalTransition(
              releasing,
              { status: "destroyed" },
              "sandbox.destroyed",
              {
                completedAt: Date.parse(releasing.data.destroyCompletedAt),
                removeFields: ["destroyCompletedAt"],
              },
            );
          }
          const result = yield* Effect.result(
            unlockedProviderMutation(
              "destroy",
              releasing.data.id,
              (combinedSignal) => provider.destroy({ lease, signal: combinedSignal }),
              signal,
            ),
          );
          if (result._tag === "Failure") {
            const mayHaveCompleted = destroyOutcomeMayHaveCompleted(result.failure);
            if (mayHaveCompleted) retain();
            yield* terminalTransition(
              releasing,
              {
                failureReason: mayHaveCompleted
                  ? "provider-destroy-outcome-unknown"
                  : "provider-destroy-failed",
                status: "error",
              },
              "sandbox.failed",
            );
            return yield* Effect.fail(result.failure);
          }
          const completedAt = now();
          const completedResult = yield* Effect.result(
            commitDestroyCompletion(releasing, completedAt),
          );
          if (completedResult._tag === "Failure") {
            if (isPersistenceUnknown(completedResult.failure)) {
              return yield* Effect.fail(completedResult.failure);
            }
            return yield* Effect.fail(
              new SandboxOperationError({
                cause: completedResult.failure,
                leaseId: releasing.data.id,
                message: `Sandbox destroy completion persistence failed for provider ${provider.name}.`,
                operation: "destroy-completion-persistence",
                provider: provider.name,
              }),
            );
          }
          const completed = completedResult.success;
          const terminal = yield* Effect.result(
            prepareTerminalTransition(completed, { status: "destroyed" }, "sandbox.destroyed", {
              completedAt,
              removeFields: ["destroyCompletedAt"],
              transitionAt: completedAt,
            }).pipe(
              Effect.flatMap((prepared) => commitPreparedTransitionWithRetry(prepared.commit)),
            ),
          );
          if (terminal._tag === "Success") return terminal.success;
          if (isPersistenceUnknown(terminal.failure)) {
            return yield* Effect.fail(terminal.failure);
          }
          return yield* Effect.fail(
            new SandboxOperationError({
              cause: terminal.failure,
              leaseId: releasing.data.id,
              message: `Sandbox destroy persistence failed for provider ${provider.name}.`,
              operation: "destroy-persistence",
              provider: provider.name,
            }),
          );
        }),
      ),
    download: (input) => {
      const leaseId = input.sandbox.record.data.id;
      let transferred = false;
      return Effect.acquireUseRelease(
        acquireLeaseOperationGuard(input.sandbox.record.data, "download"),
        (guard) =>
          requireReady(input.sandbox).pipe(
            Effect.flatMap(() =>
              unlockedProviderCall(
                "download",
                leaseId,
                (combinedSignal) =>
                  provider.download({
                    lease: input.sandbox.lease,
                    path: input.path,
                    signal: combinedSignal,
                  }),
                guard.signal,
                input.signal,
              ),
            ),
            Effect.flatMap((stream) =>
              Effect.try({
                catch: (cause) => operationError(provider, "download-stream", cause, leaseId),
                try: () => {
                  const guarded = guardedDownloadStream(stream, guard, input.signal);
                  transferred = true;
                  return guarded;
                },
              }),
            ),
          ),
        (guard, _exit) =>
          transferred
            ? Effect.void
            : releaseLeaseOperationGuard(guard, "download", leaseId, guard.signal.aborted),
      );
    },
    exec: (input) => {
      let mutationDispatched = false;
      return withLeaseOperationLock(
        input.sandbox.record.data,
        "exec",
        (signal, retain) =>
          requireReady(input.sandbox).pipe(
            Effect.flatMap(() =>
              unlockedProviderCall(
                "exec",
                input.sandbox.record.data.id,
                (combinedSignal) =>
                  provider.exec({
                    command: input.command,
                    lease: input.sandbox.lease,
                    onMutationDispatch: () => {
                      mutationDispatched = true;
                    },
                    signal: combinedSignal,
                    ...(input.cwd ? { cwd: input.cwd } : {}),
                    ...(input.env ? { env: input.env } : {}),
                    ...(input.network ? { network: input.network } : {}),
                    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
                  }),
                signal,
                input.signal,
              ).pipe(
                Effect.tapError((error) =>
                  dataPlaneOutcomeMayBeInFlight(error) ||
                  (mutationDispatched && input.signal?.aborted)
                    ? Effect.sync(retain)
                    : Effect.void,
                ),
                Effect.flatMap((result) => {
                  if (!("operationId" in result)) return Effect.succeed(result);
                  retain();
                  return Effect.fail(
                    new SandboxOperationError({
                      cause: result,
                      leaseId: input.sandbox.record.data.id,
                      message:
                        "Managed sandbox exec cannot release its operation lease for an asynchronous provider command.",
                      operation: "exec-async-unsupported",
                      provider: provider.name,
                    }),
                  );
                }),
              ),
            ),
          ),
        () => mutationDispatched,
      );
    },
    reconcileCreate,
    reconcileCreateWithCleanup,
    reconcileCreateWithLease,
    reconcileCheckpoint,
    reconcileCheckpointWithResult,
    reconcileResume,
    reconcileResumeWithLease,
    resume: (sandbox) => {
      let mutationDispatched = false;
      return withLeaseOperationLock(
        sandbox.record.data,
        "resume",
        (signal, retain, guard) =>
          Effect.gen(function* () {
            if (
              sandbox.record.data.status === "error" &&
              !RECOVERABLE_RESUME_FAILURES.has(sandbox.record.data.failureReason ?? "")
            ) {
              return yield* Effect.fail(
                new SandboxRecordError({
                  cause: sandbox.record,
                  message: "Sandbox error state is cleanup-only and cannot be resumed.",
                }),
              );
            }
            const lease = yield* requireLifecycleState(sandbox, "resume", ["suspended", "error"]);
            const resumeRequestedAt = now();
            if (lease.leaseExpiresAt !== undefined && lease.leaseExpiresAt <= resumeRequestedAt) {
              return yield* Effect.fail(
                new SandboxRecordError({
                  cause: lease,
                  message: "Expired sandbox leases cannot be resumed.",
                }),
              );
            }
            const resuming = yield* updateLeaseRecord(
              sandbox.record,
              {
                resumeRequestedAt: timestamp(resumeRequestedAt),
                status: "resuming",
              },
              resumeRequestedAt,
              ["failureReason"],
            ).pipe(
              Effect.flatMap((record) =>
                commitHoldingTransitionRetryingAfterStaleHolderDestroy(
                  sandbox.record,
                  record,
                  "sandbox.resuming",
                ),
              ),
            );
            const resumeAttemptedAt = timestamp(now());
            const result = yield* Effect.result(
              unlockedProviderCall(
                "resume",
                resuming.data.id,
                (combinedSignal) =>
                  provider.resume({
                    lease,
                    onMutationDispatch: () => {
                      mutationDispatched = true;
                    },
                    signal: combinedSignal,
                  }),
                signal,
              ),
            );
            if (result._tag === "Failure") {
              const mayBeActive = resumeOutcomeMayBeActive(result.failure);
              if (mayBeActive) retain();
              const activeSegmentStartedAt = resuming.data.computeUsageActive
                ? undefined
                : resumeAttemptedAt;
              yield* terminalTransition(
                resuming,
                {
                  failureReason: mayBeActive
                    ? "provider-resume-outcome-unknown"
                    : "provider-resume-failed",
                  status: mayBeActive ? "resuming" : "error",
                },
                mayBeActive ? "sandbox.resuming" : "sandbox.failed",
                mayBeActive
                  ? {
                      ...(activeSegmentStartedAt ? { activeSegmentStartedAt } : {}),
                      nextComputeUsageActive: true,
                    }
                  : { removeFields: ["resumeRequestedAt"] },
              );
              return yield* Effect.fail(result.failure);
            }
            const resumedAt = timestamp(now());
            const reconciled = yield* Effect.result(
              Effect.try({
                catch: (cause) =>
                  cause instanceof SandboxRecordError
                    ? cause
                    : new SandboxRecordError({
                        cause,
                        message: "Invalid resumed sandbox lease.",
                      }),
                try: () => {
                  assertResumedLeaseMatches(lease, result.success, provider);
                  return reconcileResumedLease(lease, result.success, Date.parse(resumedAt));
                },
              }),
            );
            if (reconciled._tag === "Failure") {
              const activeSegmentStartedAt = resuming.data.computeUsageActive
                ? undefined
                : resumedAt;
              yield* terminalTransition(
                resuming,
                {
                  failureReason: "provider-resume-identity-mismatch",
                  status: "error",
                },
                "sandbox.failed",
                {
                  ...(activeSegmentStartedAt ? { activeSegmentStartedAt } : {}),
                  nextComputeUsageActive: true,
                  removeFields: ["resumeRequestedAt"],
                },
              );
              return yield* Effect.fail(reconciled.failure);
            }
            const resumedLease = reconciled.success;
            const readyAt = Date.parse(resumedAt);
            if (resuming.data.computeUsageActive) {
              const readyTransition = yield* prepareTerminalTransition(
                resuming,
                {
                  checkpointRef: resumedLease.checkpointRef,
                  lastHeartbeatAt: timestamp(readyAt),
                  leaseExpiresAt:
                    resumedLease.leaseExpiresAt === undefined
                      ? undefined
                      : timestamp(resumedLease.leaseExpiresAt),
                  readyAt: timestamp(readyAt),
                  region: resumedLease.region,
                  reservedMemoryMiB: resumedLease.reservedMemoryMiB,
                  reservedVcpu: resumedLease.reservedVcpu,
                  status: "ready",
                },
                "sandbox.resumed",
                {
                  completedAt: readyAt,
                  nextComputeUsageActive: true,
                  removeFields: ["failureReason", "resumeRequestedAt"],
                  transitionAt: readyAt,
                },
              );
              const readyCommit = yield* Effect.result(readyTransition.commit);
              if (readyCommit._tag === "Failure") {
                if (isPersistenceUnknown(readyCommit.failure)) {
                  return yield* Effect.fail(readyCommit.failure);
                }
                return yield* compensateResumedLease(
                  readyTransition.previous,
                  resumedLease,
                  resumedAt,
                  readyCommit.failure,
                  guard,
                );
              }
              return {
                lease: leaseFromRecord(readyTransition.record),
                record: readyTransition.record,
              };
            }
            const ready = yield* updateLeaseRecord(
              resuming,
              {
                checkpointRef: resumedLease.checkpointRef,
                computeUsageActive: true,
                lastHeartbeatAt: timestamp(readyAt),
                leaseExpiresAt:
                  resumedLease.leaseExpiresAt === undefined
                    ? undefined
                    : timestamp(resumedLease.leaseExpiresAt),
                readyAt: timestamp(readyAt),
                region: resumedLease.region,
                reservedMemoryMiB: resumedLease.reservedMemoryMiB,
                reservedVcpu: resumedLease.reservedVcpu,
                status: "ready",
                usageAccountedThrough: resumedAt,
              },
              readyAt,
              ["failureReason", "resumeRequestedAt"],
            );
            const readyCommit = yield* Effect.result(
              commitTransition(resuming, ready, "sandbox.resumed"),
            );
            if (readyCommit._tag === "Failure") {
              if (isPersistenceUnknown(readyCommit.failure)) {
                return yield* Effect.fail(readyCommit.failure);
              }
              return yield* compensateResumedLease(
                resuming,
                resumedLease,
                resumedAt,
                readyCommit.failure,
                guard,
              );
            }
            return { lease: leaseFromRecord(ready), record: ready };
          }),
        () => mutationDispatched,
      );
    },
    resolveCreateAsNotAllocated,
    upload: (input) => {
      let mutationDispatched = false;
      return withLeaseOperationLock(
        input.sandbox.record.data,
        "upload",
        (signal, retain) =>
          requireReady(input.sandbox).pipe(
            Effect.flatMap(() =>
              unlockedProviderCall(
                "upload",
                input.sandbox.record.data.id,
                (combinedSignal) =>
                  provider.upload({
                    content: input.content,
                    lease: input.sandbox.lease,
                    onMutationDispatch: () => {
                      mutationDispatched = true;
                    },
                    path: input.path,
                    signal: combinedSignal,
                  }),
                signal,
                input.signal,
              ).pipe(
                Effect.tapError((error) =>
                  dataPlaneOutcomeMayBeInFlight(error) ||
                  (mutationDispatched && input.signal?.aborted)
                    ? Effect.sync(retain)
                    : Effect.void,
                ),
              ),
            ),
          ),
        () => mutationDispatched,
      );
    },
  };
}
