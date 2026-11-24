import { Effect } from "effect";
import type { SandboxLease } from "../types.ts";
import {
  SandboxOperationError,
  type ManagerBase,
  type SandboxLeaseRecordValue,
  type SandboxManagerError,
  type SandboxOperationGuard,
} from "./contracts.ts";
import { checkpointOutcomeMayBeSuspended, destroyOutcomeMayHaveCompleted } from "./leases.ts";
import { leaseRecordWithUpdates, recoveryMetadataUpdates } from "./records.ts";
import type { OperationRuntime } from "./operations.ts";
import type { StateRuntime } from "./state.ts";
import type { TransitionRuntime } from "./transitions.ts";

function isPersistenceUnknown(error: SandboxManagerError) {
  return error._tag === "SandboxPersistenceUnknownError";
}

export function createCompensationRuntime(
  context: ManagerBase & TransitionRuntime & OperationRuntime & StateRuntime,
) {
  const {
    provider,
    now,
    transition,
    terminalTransition,
    commitDestroyCompletion,
    providerIdentityOwnership,
    unlockedProviderMutation,
    providerMutationCall,
  } = context;
  function compensateCreatedLease(
    previous: SandboxLeaseRecordValue,
    lease: SandboxLease,
    recoveryUpdates: Readonly<Record<string, unknown>>,
    failureReason: string,
    originalFailure: SandboxManagerError,
    operationGuard?: SandboxOperationGuard,
  ): Effect.Effect<never, SandboxManagerError> {
    return Effect.gen(function* () {
      const identityRecord = yield* leaseRecordWithUpdates(previous, recoveryUpdates);
      const recoveryMetadata = recoveryMetadataUpdates(recoveryUpdates);
      let cleanupPending: SandboxLeaseRecordValue | undefined;
      let claimFailure: SandboxManagerError | undefined;
      let ownershipFailure: unknown;
      let ownershipState: "available" | "conflicting" | "owned" | "unavailable" = "unavailable";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const claimed = yield* Effect.result(
          transition(
            previous,
            {
              ...recoveryUpdates,
              failureReason,
              status: "releasing",
            },
            "sandbox.releasing",
            ["recoveryExternalSandboxId"],
          ),
        );
        if (claimed._tag === "Success") {
          cleanupPending = claimed.success;
          break;
        }
        if (isPersistenceUnknown(claimed.failure)) {
          return yield* Effect.fail(claimed.failure);
        }
        claimFailure = claimed.failure;
        const ownership = yield* Effect.result(providerIdentityOwnership(identityRecord));
        if (ownership._tag === "Failure") {
          ownershipFailure = ownership.failure;
          ownershipState = "unavailable";
        } else {
          ownershipState = ownership.success;
        }
        if (ownershipState === "conflicting") break;
      }
      if (!cleanupPending) {
        const conflicting = ownershipState === "conflicting";
        const persisted = yield* Effect.result(
          conflicting
            ? terminalTransition(
                previous,
                {
                  failureReason: `${failureReason}-identity-conflict`,
                  status: "error",
                },
                "sandbox.failed",
                { nextComputeUsageActive: false },
              )
            : transition(
                previous,
                {
                  ...recoveryMetadata,
                  failureReason: `${failureReason}-cleanup-claim-unavailable`,
                  recoveryExternalSandboxId: lease.externalSandboxId,
                },
                "sandbox.failed",
              ),
        );
        return yield* Effect.fail(
          new SandboxOperationError({
            cause: {
              claimFailure,
              lease,
              originalFailure,
              ownershipFailure,
              persistenceFailure: persisted._tag === "Failure" ? persisted.failure : undefined,
            },
            leaseId: previous.data.id,
            message: `Sandbox create compensation ownership could not be established for provider ${provider.name}.`,
            operation: "create-compensation-ownership",
            provider: provider.name,
          }),
        );
      }
      const cleanup = yield* Effect.result(
        operationGuard
          ? unlockedProviderMutation(
              "destroy-after-create",
              previous.data.id,
              (signal) => provider.destroy({ lease, signal }),
              operationGuard.signal,
            )
          : providerMutationCall("destroy-after-create", previous.data, (signal) =>
              provider.destroy({ lease, signal }),
            ),
      );
      const cleanupMayHaveCompleted =
        cleanup._tag === "Failure" && destroyOutcomeMayHaveCompleted(cleanup.failure);
      if (cleanupMayHaveCompleted) operationGuard?.retain();
      const persisted = yield* Effect.result(
        cleanup._tag === "Success"
          ? Effect.gen(function* () {
              const completedAt = now();
              const completed = yield* commitDestroyCompletion(cleanupPending, completedAt);
              return yield* terminalTransition(
                completed,
                { ...recoveryUpdates, failureReason, status: "destroyed" },
                "sandbox.destroyed",
                {
                  completedAt,
                  removeFields: ["destroyCompletedAt"],
                  transitionAt: completedAt,
                },
              );
            })
          : terminalTransition(
              cleanupPending,
              {
                ...recoveryUpdates,
                failureReason: `${failureReason}-cleanup-failed`,
                status: "error",
              },
              "sandbox.failed",
            ),
      );
      if (cleanup._tag === "Failure" || persisted._tag === "Failure") {
        return yield* Effect.fail(
          new SandboxOperationError({
            cause: {
              cleanupFailure: cleanup._tag === "Failure" ? cleanup.failure : undefined,
              originalFailure,
              persistenceFailure: persisted._tag === "Failure" ? persisted.failure : undefined,
            },
            leaseId: previous.data.id,
            message: `Sandbox create compensation failed for provider ${provider.name}.`,
            operation: "create-compensation",
            provider: provider.name,
          }),
        );
      }
      return yield* Effect.fail(originalFailure);
    });
  }

  function compensateResumedLease(
    resuming: SandboxLeaseRecordValue,
    resumedLease: SandboxLease,
    resumedAt: string,
    originalFailure: SandboxManagerError,
    operationGuard: SandboxOperationGuard,
  ): Effect.Effect<never, SandboxManagerError> {
    return Effect.gen(function* () {
      const activeSegmentStartedAt = resuming.data.computeUsageActive ? undefined : resumedAt;
      const checkpoint = yield* Effect.result(
        unlockedProviderMutation(
          "checkpoint-after-resume",
          resuming.data.id,
          (combinedSignal) =>
            provider.checkpoint({
              label: "resume-persistence-failed",
              lease: resumedLease,
              signal: combinedSignal,
            }),
          operationGuard.signal,
        ),
      );
      if (checkpoint._tag === "Success") {
        const persisted = yield* Effect.result(
          terminalTransition(
            resuming,
            {
              checkpointRef: checkpoint.success.checkpointRef,
              failureReason: "resume-persistence-failed",
              status: "suspended",
            },
            "sandbox.suspended",
            {
              ...(activeSegmentStartedAt ? { activeSegmentStartedAt } : {}),
              nextComputeUsageActive: false,
            },
          ),
        );
        if (persisted._tag === "Success") return yield* Effect.fail(originalFailure);
        return yield* Effect.fail(
          new SandboxOperationError({
            cause: { originalFailure, persistenceFailure: persisted.failure },
            leaseId: resuming.data.id,
            message: `Sandbox resume compensation failed for provider ${provider.name}.`,
            operation: "resume-compensation",
            provider: provider.name,
          }),
        );
      }

      if (checkpointOutcomeMayBeSuspended(checkpoint.failure)) {
        operationGuard.retain();
        const persisted = yield* Effect.result(
          terminalTransition(
            resuming,
            {
              failureReason: "resume-persistence-failed-checkpoint-outcome-unknown",
              status: "error",
            },
            "sandbox.failed",
            {
              ...(activeSegmentStartedAt ? { activeSegmentStartedAt } : {}),
              nextComputeUsageActive: true,
            },
          ),
        );
        return yield* Effect.fail(
          new SandboxOperationError({
            cause: {
              checkpointFailure: checkpoint.failure,
              originalFailure,
              persistenceFailure: persisted._tag === "Failure" ? persisted.failure : undefined,
            },
            leaseId: resuming.data.id,
            message: `Sandbox resume compensation outcome is unknown for provider ${provider.name}.`,
            operation: "resume-compensation",
            provider: provider.name,
          }),
        );
      }

      const releasing = yield* transition(
        resuming,
        { failureReason: "resume-persistence-failed", status: "releasing" },
        "sandbox.releasing",
      );
      const destroyed = yield* Effect.result(
        unlockedProviderMutation(
          "destroy-after-resume",
          releasing.data.id,
          (combinedSignal) => provider.destroy({ lease: resumedLease, signal: combinedSignal }),
          operationGuard.signal,
        ),
      );
      const destroyMayHaveCompleted =
        destroyed._tag === "Failure" && destroyOutcomeMayHaveCompleted(destroyed.failure);
      if (destroyMayHaveCompleted) operationGuard.retain();
      const persisted = yield* Effect.result(
        destroyed._tag === "Success"
          ? Effect.gen(function* () {
              const completedAt = now();
              const completed = yield* commitDestroyCompletion(releasing, completedAt);
              return yield* terminalTransition(
                completed,
                {
                  failureReason: "resume-persistence-failed-destroyed",
                  status: "destroyed",
                },
                "sandbox.destroyed",
                {
                  ...(activeSegmentStartedAt ? { activeSegmentStartedAt } : {}),
                  completedAt,
                  nextComputeUsageActive: false,
                  removeFields: ["destroyCompletedAt"],
                  transitionAt: completedAt,
                },
              );
            })
          : terminalTransition(
              releasing,
              {
                failureReason: "resume-persistence-failed-cleanup-failed",
                status: "error",
              },
              "sandbox.failed",
              {
                ...(activeSegmentStartedAt ? { activeSegmentStartedAt } : {}),
                nextComputeUsageActive: true,
              },
            ),
      );
      if (destroyed._tag === "Success" && persisted._tag === "Success") {
        return yield* Effect.fail(originalFailure);
      }
      return yield* Effect.fail(
        new SandboxOperationError({
          cause: {
            checkpointFailure: checkpoint.failure,
            cleanupFailure: destroyed._tag === "Failure" ? destroyed.failure : undefined,
            originalFailure,
            persistenceFailure: persisted._tag === "Failure" ? persisted.failure : undefined,
          },
          leaseId: resuming.data.id,
          message: `Sandbox resume compensation failed for provider ${provider.name}.`,
          operation: "resume-compensation",
          provider: provider.name,
        }),
      );
    });
  }
  return { compensateCreatedLease, compensateResumedLease };
}

export type CompensationRuntime = ReturnType<typeof createCompensationRuntime>;
