import { Effect } from "effect";
import type { CreateSandboxInput, SandboxLease } from "../types.ts";
import {
  SandboxOperationError,
  SandboxRecordError,
  type ManagerBase,
  type SandboxLeaseRecordValue,
  type SandboxOperationGuard,
  type SandboxManagerService,
} from "./contracts.ts";
import {
  allocatedLeaseFromFailure,
  allocationOutcomeUnknown,
  assertLeaseIdentityMatches,
  assertLeaseReady,
} from "./leases.ts";
import {
  allocationUpdates,
  generateId,
  createLeaseRecord,
  leaseRecordWithUpdates,
  recoveryMetadataUpdates,
  timestamp,
  updateLeaseRecord,
} from "./records.ts";
import type { CapacityRuntime } from "./capacity.ts";
import type { CompensationRuntime } from "./compensation.ts";
import type { OperationRuntime } from "./operations.ts";
import type { StateRuntime } from "./state.ts";
import type { TransitionRuntime } from "./transitions.ts";

function isPersistenceUnknown(error: { readonly _tag: string }) {
  return error._tag === "SandboxPersistenceUnknownError";
}

export function createAllocationRuntime(
  context: ManagerBase &
    TransitionRuntime &
    OperationRuntime &
    StateRuntime &
    CapacityRuntime &
    CompensationRuntime,
) {
  const {
    provider,
    ids,
    now,
    transition,
    terminalTransition,
    commitTransition,
    commitHoldingTransitionRetryingAfterStaleHolderDestroy,
    providerIdentityOwnership,
    unlockedProviderMutation,
    providerMutationCall,
    withLeaseOperationLock,
    compensateCreatedLease,
  } = context;
  function allocateCreating(
    creating: SandboxLeaseRecordValue,
    input: CreateSandboxInput,
    preserveUnknownOnFailure = false,
    operationGuard?: SandboxOperationGuard,
  ) {
    return Effect.gen(function* () {
      const result = yield* Effect.result(
        operationGuard
          ? unlockedProviderMutation(
              "create",
              creating.data.id,
              (signal) =>
                provider.create({
                  ...input,
                  allocationId: creating.data.id,
                  signal,
                }),
              operationGuard.signal,
              input.signal,
            )
          : providerMutationCall(
              "create",
              creating.data,
              (signal) =>
                provider.create({
                  ...input,
                  allocationId: creating.data.id,
                  signal,
                }),
              input.signal,
            ),
      );
      const releaseFailure =
        result._tag === "Failure" &&
        result.failure instanceof SandboxOperationError &&
        result.failure.operation === "create-lease-release" &&
        result.failure.successfulResult !== undefined
          ? result.failure
          : undefined;
      if (result._tag === "Failure" && !releaseFailure) {
        const failedAllocation = allocatedLeaseFromFailure(result.failure);
        if (failedAllocation) {
          const allocatedLease = failedAllocation.lease;
          if (!failedAllocation.identityVerified) {
            const identityFailure = new SandboxRecordError({
              cause: allocatedLease,
              message: "Sandbox provider returned an unverified external sandbox identity.",
            });
            yield* transition(
              creating,
              {
                failureReason: "provider-lease-identity-mismatch",
                recoveryExternalSandboxId: allocatedLease.externalSandboxId,
              },
              "sandbox.failed",
            );
            return yield* Effect.fail(identityFailure);
          }
          const identityValidation = yield* Effect.result(
            Effect.try({
              catch: (cause) =>
                cause instanceof SandboxRecordError
                  ? cause
                  : new SandboxRecordError({
                      cause,
                      message: "Invalid failed sandbox lease identity.",
                    }),
              try: () => assertLeaseIdentityMatches(input, allocatedLease, provider),
            }),
          );
          if (identityValidation._tag === "Failure") {
            yield* transition(
              creating,
              {
                failureReason: "provider-lease-identity-mismatch",
                recoveryExternalSandboxId: allocatedLease.externalSandboxId,
              },
              "sandbox.failed",
            );
            return yield* Effect.fail(identityValidation.failure);
          }
          const recovery = yield* Effect.result(
            Effect.try({
              catch: (cause) =>
                cause instanceof SandboxRecordError
                  ? cause
                  : new SandboxRecordError({
                      cause,
                      message: "Invalid failed sandbox allocation response.",
                    }),
              try: () => allocationUpdates(input, allocatedLease, creating.data),
            }),
          );
          const recoveryUpdates =
            recovery._tag === "Success"
              ? recovery.success
              : { externalSandboxId: allocatedLease.externalSandboxId };
          if (failedAllocation.cleanupCompletedAt !== undefined) {
            const usageDimensionsRecord = yield* leaseRecordWithUpdates(creating, recoveryUpdates);
            const usageReservation =
              recovery._tag === "Success"
                ? {
                    reservedMemoryMiB: recovery.success.reservedMemoryMiB,
                    reservedVcpu: recovery.success.reservedVcpu,
                  }
                : undefined;
            const persisted = yield* Effect.result(
              terminalTransition(
                creating,
                {
                  ...recoveryUpdates,
                  failureReason: "provider-create-cleaned",
                  status: "destroyed",
                },
                "sandbox.destroyed",
                {
                  completedAt: failedAllocation.cleanupCompletedAt,
                  nextComputeUsageActive: false,
                  usageDimensionsRecord,
                  ...(usageReservation ? { usageReservation } : {}),
                },
              ),
            );
            if (persisted._tag === "Failure") {
              return yield* Effect.fail(
                new SandboxOperationError({
                  cause: {
                    originalFailure: result.failure,
                    persistenceFailure: persisted.failure,
                  },
                  leaseId: creating.data.id,
                  message: `Cleaned sandbox allocation persistence failed for provider ${provider.name}.`,
                  operation: "create-cleaned-persistence",
                  provider: provider.name,
                }),
              );
            }
            return yield* Effect.fail(result.failure);
          }
          return yield* compensateCreatedLease(
            creating,
            allocatedLease,
            recoveryUpdates,
            "provider-create-cleanup-failed",
            result.failure,
            operationGuard,
          );
        }
        const unknownAllocation = allocationOutcomeUnknown(result.failure);
        if (unknownAllocation) {
          operationGuard?.retain();
          yield* transition(
            creating,
            {
              failureReason: unknownAllocation.automaticReconciliation
                ? "provider-create-outcome-unknown"
                : "provider-create-outcome-manual-reconciliation",
            },
            "sandbox.failed",
          );
          return yield* Effect.fail(result.failure);
        }
        if (preserveUnknownOnFailure) {
          yield* transition(
            creating,
            { failureReason: "provider-create-outcome-unknown" },
            "sandbox.failed",
          );
          return yield* Effect.fail(result.failure);
        }
        yield* terminalTransition(
          creating,
          { failureReason: "provider-create-failed", status: "error" },
          "sandbox.failed",
          { nextComputeUsageActive: false },
        );
        return yield* Effect.fail(result.failure);
      }

      const lease =
        result._tag === "Success"
          ? result.success
          : (releaseFailure?.successfulResult as SandboxLease);
      const identityValidation = yield* Effect.result(
        Effect.try({
          catch: (cause) =>
            cause instanceof SandboxRecordError
              ? cause
              : new SandboxRecordError({
                  cause,
                  message: "Invalid sandbox lease identity.",
                }),
          try: () => assertLeaseIdentityMatches(input, lease, provider),
        }),
      );
      if (identityValidation._tag === "Failure") {
        yield* transition(
          creating,
          {
            failureReason: "provider-lease-identity-mismatch",
            recoveryExternalSandboxId: lease.externalSandboxId,
          },
          "sandbox.failed",
        );
        return yield* Effect.fail(identityValidation.failure);
      }

      const allocationAt = now();
      const readinessValidation = yield* Effect.result(
        Effect.try({
          catch: (cause) =>
            cause instanceof SandboxRecordError
              ? cause
              : new SandboxRecordError({
                  cause,
                  message: "Invalid sandbox lease readiness.",
                }),
          try: () => assertLeaseReady(lease, input, allocationAt),
        }),
      );
      if (readinessValidation._tag === "Failure") {
        const recovery = yield* Effect.result(
          Effect.try({
            catch: (cause) =>
              cause instanceof SandboxRecordError
                ? cause
                : new SandboxRecordError({
                    cause,
                    message: "Invalid sandbox allocation.",
                  }),
            try: () => allocationUpdates(input, lease, creating.data),
          }),
        );
        return yield* compensateCreatedLease(
          creating,
          lease,
          recovery._tag === "Success"
            ? recovery.success
            : { externalSandboxId: lease.externalSandboxId },
          "provider-lease-not-ready",
          readinessValidation.failure,
          operationGuard,
        );
      }

      const allocationRecord = yield* Effect.result(
        Effect.try({
          catch: (cause) =>
            cause instanceof SandboxRecordError
              ? cause
              : new SandboxRecordError({
                  cause,
                  message: "Invalid sandbox allocation response.",
                }),
          try: () => allocationUpdates(input, lease, creating.data),
        }).pipe(
          Effect.flatMap((updates) =>
            updateLeaseRecord(creating, updates, allocationAt, [
              "failureReason",
              "recoveryExternalSandboxId",
            ]),
          ),
        ),
      );
      if (allocationRecord._tag === "Failure") {
        return yield* compensateCreatedLease(
          creating,
          lease,
          { externalSandboxId: lease.externalSandboxId },
          "allocation-persistence-failed",
          allocationRecord.failure,
          operationGuard,
        );
      }
      const allocation = yield* Effect.result(
        commitTransition(creating, allocationRecord.success, "sandbox.allocated"),
      );
      if (allocation._tag === "Failure") {
        if (isPersistenceUnknown(allocation.failure)) {
          return yield* Effect.fail(allocation.failure);
        }
        const identityOwnership = yield* Effect.result(
          providerIdentityOwnership(allocationRecord.success),
        );
        if (identityOwnership._tag === "Failure") {
          const recoveryMetadata = recoveryMetadataUpdates(
            allocationUpdates(input, lease, creating.data),
          );
          const persistence = yield* Effect.result(
            transition(
              creating,
              {
                ...recoveryMetadata,
                failureReason: "provider-identity-ownership-unavailable",
                recoveryExternalSandboxId: lease.externalSandboxId,
              },
              "sandbox.failed",
            ),
          );
          return yield* Effect.fail(
            new SandboxOperationError({
              cause: {
                allocationFailure: allocation.failure,
                ownershipFailure: identityOwnership.failure,
                persistenceFailure:
                  persistence._tag === "Failure" ? persistence.failure : undefined,
              },
              leaseId: creating.data.id,
              message: `Sandbox provider identity ownership could not be verified for ${provider.name}.`,
              operation: "allocation-identity-reconciliation",
              provider: provider.name,
            }),
          );
        }
        if (identityOwnership.success !== "available") {
          const conflict = new SandboxRecordError({
            cause: allocation.failure,
            message:
              identityOwnership.success === "conflicting"
                ? "Sandbox provider returned an external identity owned by another lease."
                : "Sandbox allocation ownership is inconsistent with its persisted record.",
          });
          yield* terminalTransition(
            creating,
            {
              failureReason: "provider-sandbox-identity-conflict",
              status: "error",
            },
            "sandbox.failed",
            { nextComputeUsageActive: false },
          );
          return yield* Effect.fail(conflict);
        }
        return yield* compensateCreatedLease(
          creating,
          lease,
          { externalSandboxId: lease.externalSandboxId },
          "allocation-persistence-failed",
          allocation.failure,
          operationGuard,
        );
      }
      const allocated = allocation.success;

      const readyAt = now();
      const ready = yield* updateLeaseRecord(
        allocated,
        {
          lastHeartbeatAt: timestamp(readyAt),
          readyAt: timestamp(readyAt),
          status: "ready",
        },
        readyAt,
      );
      const readyCommit = yield* Effect.result(commitTransition(allocated, ready, "sandbox.ready"));
      if (readyCommit._tag === "Failure") {
        if (isPersistenceUnknown(readyCommit.failure)) {
          return yield* Effect.fail(readyCommit.failure);
        }
        return yield* compensateCreatedLease(
          allocated,
          lease,
          {},
          "ready-persistence-failed",
          readyCommit.failure,
          operationGuard,
        );
      }
      if (releaseFailure) return yield* Effect.fail(releaseFailure);
      return { lease, record: ready };
    });
  }

  const create: SandboxManagerService["create"] = (input) =>
    Effect.gen(function* () {
      const leaseId = input.allocationId ?? (yield* generateId(ids));
      const fingerprintInput = { ...input, allocationId: leaseId };
      const providerConfigFingerprint = provider.allocationFingerprint?.(fingerprintInput);
      const allocationInput = {
        ...fingerprintInput,
        ...(providerConfigFingerprint
          ? { expectedAllocationFingerprint: providerConfigFingerprint }
          : {}),
      };
      const createdAt = now();
      const creating = yield* createLeaseRecord(
        allocationInput,
        leaseId,
        provider,
        createdAt,
        providerConfigFingerprint,
      );
      return yield* withLeaseOperationLock(creating.data, "create", (_signal, _retain, guard) =>
        Effect.gen(function* () {
          const slotted = yield* commitHoldingTransitionRetryingAfterStaleHolderDestroy(
            undefined,
            creating,
            "sandbox.provisioning-started",
          );
          return yield* allocateCreating(slotted, allocationInput, false, guard);
        }),
      );
    });
  return { allocateCreating, create };
}

export type AllocationRuntime = ReturnType<typeof createAllocationRuntime>;
