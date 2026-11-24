import { fromDatabase, sandboxHostPersistence } from "@deployments-ai/db";
import { isDeepStrictEqual } from "node:util";
import { Effect } from "effect";
import type { SandboxLease } from "../types.ts";
import { isValidEpochMilliseconds } from "../types.ts";
import {
  SandboxRecordError,
  type ManagerBase,
  type SandboxLeaseRecordValue,
  type SandboxManagerService,
  type SandboxOperationGuard,
} from "./contracts.ts";
import {
  assertLeaseIdentityMatches,
  assertLeaseReady,
  destroyOutcomeMayHaveCompleted,
  leaseFromRecord,
} from "./leases.ts";
import {
  allocationUpdates,
  createInputFromRecord,
  timestamp,
  updateLeaseRecord,
} from "./records.ts";
import type { AllocationRuntime } from "./allocation.ts";
import type { OperationRuntime } from "./operations.ts";
import type { StateRuntime } from "./state.ts";
import type { TransitionRuntime } from "./transitions.ts";

export function createCreateReconciliationRuntime(
  context: ManagerBase & TransitionRuntime & OperationRuntime & StateRuntime & AllocationRuntime,
) {
  const {
    provider,
    database,
    now,
    transition,
    terminalTransition,
    commitTransition,
    commitDestroyCompletion,
    unlockedProviderCall,
    unlockedProviderMutation,
    providerMutationCall,
    providerRoutedLease,
    withLeaseOperationLock,
    allocateCreating,
  } = context;
  function requireManualCreateRecord(record: SandboxLeaseRecordValue) {
    return Effect.gen(function* () {
      if (record.data.provider !== provider.name || record.data.status !== "creating") {
        return yield* Effect.fail(
          new SandboxRecordError({
            cause: record,
            message: "Manual allocation reconciliation requires a creating lease.",
          }),
        );
      }
      const current = yield* fromDatabase(() =>
        sandboxHostPersistence.read(database, "execution", { pk: record.pk, sk: record.sk }, true),
      );
      if (
        current === undefined ||
        current.itemType !== "sandbox-lease" ||
        !isDeepStrictEqual(current, record)
      ) {
        return yield* Effect.fail(
          new SandboxRecordError({
            cause: current,
            message: "Sandbox allocation state changed; reload before manual reconciliation.",
          }),
        );
      }
      return record;
    });
  }

  function cleanupCreatingLease(
    creating: SandboxLeaseRecordValue,
    lease: SandboxLease,
    terminalFailureReason?: string,
    operationGuard?: SandboxOperationGuard,
  ) {
    return Effect.gen(function* () {
      const input = createInputFromRecord(creating);
      const routedLease = providerRoutedLease(lease);
      yield* Effect.try({
        catch: (cause) =>
          cause instanceof SandboxRecordError
            ? cause
            : new SandboxRecordError({
                cause,
                message: "Invalid cleanup sandbox lease.",
              }),
        try: () => {
          assertLeaseIdentityMatches(input, routedLease, provider);
          if (
            creating.data.recoveryExternalSandboxId !== undefined &&
            routedLease.externalSandboxId !== creating.data.recoveryExternalSandboxId
          ) {
            throw new SandboxRecordError({
              cause: routedLease,
              message: "Cleanup sandbox identity does not match the persisted recovery identity.",
            });
          }
          if (provider.validateLeaseRoute && !routedLease.providerRouteKey) {
            throw new SandboxRecordError({
              cause: routedLease,
              message: "Cleanup sandbox lease is missing provider route identity.",
            });
          }
          provider.validateLeaseRoute?.(routedLease);
        },
      });
      const releasing = yield* transition(
        creating,
        {
          ...allocationUpdates(input, routedLease, creating.data),
          status: "releasing",
        },
        "sandbox.releasing",
        ["failureReason", "recoveryExternalSandboxId"],
      );
      const cleanup = yield* Effect.result(
        operationGuard
          ? unlockedProviderMutation(
              "destroy-after-create-recovery",
              releasing.data.id,
              (signal) => provider.destroy({ lease: routedLease, signal }),
              operationGuard.signal,
            )
          : providerMutationCall("destroy-after-create-recovery", releasing.data, (signal) =>
              provider.destroy({ lease: routedLease, signal }),
            ),
      );
      if (cleanup._tag === "Failure") {
        const cleanupMayHaveCompleted = destroyOutcomeMayHaveCompleted(cleanup.failure);
        if (cleanupMayHaveCompleted) operationGuard?.retain();
        yield* terminalTransition(
          releasing,
          { failureReason: "provider-destroy-failed", status: "error" },
          "sandbox.failed",
        );
        return yield* Effect.fail(cleanup.failure);
      }
      const completedAt = now();
      const completed = yield* commitDestroyCompletion(releasing, completedAt);
      return yield* terminalTransition(
        completed,
        {
          ...(terminalFailureReason ? { failureReason: terminalFailureReason } : {}),
          status: "destroyed",
        },
        "sandbox.destroyed",
        {
          completedAt,
          removeFields: ["destroyCompletedAt"],
          transitionAt: completedAt,
        },
      );
    });
  }

  function reconcileCreateUnlocked(
    record: SandboxLeaseRecordValue,
    operationGuard: SandboxOperationGuard,
  ) {
    return Effect.gen(function* () {
      if (
        record.data.provider !== provider.name ||
        record.data.status !== "creating" ||
        (record.data.failureReason !== undefined &&
          record.data.failureReason !== "provider-create-outcome-unknown")
      ) {
        return yield* Effect.fail(
          new SandboxRecordError({
            cause: record,
            message: "Sandbox allocation reconciliation requires an unknown creating lease.",
          }),
        );
      }
      const current = yield* fromDatabase(() =>
        sandboxHostPersistence.read(database, "execution", { pk: record.pk, sk: record.sk }, true),
      );
      if (
        current === undefined ||
        current.itemType !== "sandbox-lease" ||
        !isDeepStrictEqual(current, record)
      ) {
        return yield* Effect.fail(
          new SandboxRecordError({
            cause: current,
            message: "Sandbox allocation state changed; reload before reconciliation.",
          }),
        );
      }
      if (record.data.externalSandboxId) {
        const reconciliationStartedAt = now();
        const recoveredLease = leaseFromRecord(record);
        if (provider.validateLeaseRoute) {
          yield* unlockedProviderCall(
            "validate-route",
            record.data.id,
            async () => provider.validateLeaseRoute?.(recoveredLease),
            operationGuard.signal,
          );
        }
        const expiresAt = record.data.leaseExpiresAt
          ? Date.parse(record.data.leaseExpiresAt)
          : undefined;
        if (expiresAt !== undefined && expiresAt <= reconciliationStartedAt) {
          yield* cleanupCreatingLease(
            record,
            recoveredLease,
            "provider-lease-expired-before-ready-reconciliation",
            operationGuard,
          );
          return yield* Effect.fail(
            new SandboxRecordError({
              cause: record,
              message: "Sandbox allocation expired before ready reconciliation.",
            }),
          );
        }
        if (!provider.validateReadyLease) {
          return yield* Effect.fail(
            new SandboxRecordError({
              cause: record,
              message: "Sandbox provider requires manual ready-lease reconciliation.",
            }),
          );
        }
        const input = createInputFromRecord(record);
        const validatedLease = yield* unlockedProviderCall(
          "validate-ready",
          record.data.id,
          (signal) =>
            provider.validateReadyLease?.(recoveredLease, signal) as Promise<SandboxLease>,
          operationGuard.signal,
        );
        const readyAt = now();
        yield* Effect.try({
          catch: (cause) =>
            cause instanceof SandboxRecordError
              ? cause
              : new SandboxRecordError({
                  cause,
                  message: "Invalid reconciled ready sandbox lease.",
                }),
          try: () => {
            assertLeaseIdentityMatches(input, validatedLease, provider);
            if (validatedLease.externalSandboxId !== recoveredLease.externalSandboxId) {
              throw new SandboxRecordError({
                cause: validatedLease,
                message: "Reconciled sandbox identity changed during ready validation.",
              });
            }
            assertLeaseReady(validatedLease, input, readyAt);
            provider.validateLeaseRoute?.(validatedLease);
          },
        });
        const ready = yield* updateLeaseRecord(
          record,
          {
            ...allocationUpdates(input, validatedLease, record.data),
            computeUsageActive: true,
            lastHeartbeatAt: timestamp(readyAt),
            readyAt: timestamp(readyAt),
            status: "ready",
          },
          readyAt,
          ["failureReason", "recoveryExternalSandboxId"],
        );
        yield* commitTransition(record, ready, "sandbox.ready");
        return { lease: leaseFromRecord(ready), record: ready };
      }
      const allocationInput = createInputFromRecord(record);
      if (!provider.automaticAllocationReconciliation || !record.data.providerConfigFingerprint) {
        return yield* Effect.fail(
          new SandboxRecordError({
            cause: record,
            message: "Sandbox provider does not support automatic allocation reconciliation.",
          }),
        );
      }
      if (
        record.data.providerConfigFingerprint !== provider.allocationFingerprint?.(allocationInput)
      ) {
        return yield* Effect.fail(
          new SandboxRecordError({
            cause: record,
            message: "Sandbox provider configuration changed; allocation requires manual recovery.",
          }),
        );
      }
      return yield* allocateCreating(
        record,
        {
          ...allocationInput,
          expectedAllocationFingerprint: record.data.providerConfigFingerprint,
        },
        true,
        operationGuard,
      );
    });
  }

  const reconcileCreate: SandboxManagerService["reconcileCreate"] = (record) =>
    withLeaseOperationLock(record.data, "reconcile-create", (_signal, _retain, guard) =>
      reconcileCreateUnlocked(record, guard),
    );

  const reconcileCreateWithLease: SandboxManagerService["reconcileCreateWithLease"] = (
    record,
    lease,
  ) =>
    withLeaseOperationLock(record.data, "reconcile-create-with-lease", () =>
      Effect.gen(function* () {
        const creating = yield* requireManualCreateRecord(record);
        const input = createInputFromRecord(creating);
        const allocationAt = now();
        const routedLease = providerRoutedLease(lease);
        yield* Effect.try({
          catch: (cause) =>
            cause instanceof SandboxRecordError
              ? cause
              : new SandboxRecordError({
                  cause,
                  message: "Invalid discovered sandbox lease.",
                }),
          try: () => {
            assertLeaseIdentityMatches(input, routedLease, provider);
            if (
              creating.data.recoveryExternalSandboxId !== undefined &&
              routedLease.externalSandboxId !== creating.data.recoveryExternalSandboxId
            ) {
              throw new SandboxRecordError({
                cause: routedLease,
                message:
                  "Discovered sandbox identity does not match the persisted recovery identity.",
              });
            }
            if (provider.validateLeaseRoute && !routedLease.providerRouteKey) {
              throw new SandboxRecordError({
                cause: routedLease,
                message: "Discovered sandbox lease is missing provider route identity.",
              });
            }
            provider.validateLeaseRoute?.(routedLease);
            assertLeaseReady(routedLease, input, allocationAt);
          },
        });
        const allocation = yield* updateLeaseRecord(
          creating,
          allocationUpdates(input, routedLease, creating.data),
          allocationAt,
          ["failureReason", "recoveryExternalSandboxId"],
        );
        yield* commitTransition(creating, allocation, "sandbox.allocated");
        const readyAt = now();
        const ready = yield* updateLeaseRecord(
          allocation,
          {
            lastHeartbeatAt: timestamp(readyAt),
            readyAt: timestamp(readyAt),
            status: "ready",
          },
          readyAt,
        );
        yield* commitTransition(allocation, ready, "sandbox.ready");
        return { lease: leaseFromRecord(ready), record: ready };
      }),
    );

  const reconcileCreateWithCleanup: SandboxManagerService["reconcileCreateWithCleanup"] = (
    record,
    lease,
  ) =>
    withLeaseOperationLock(
      record.data,
      "reconcile-create-with-cleanup",
      (_signal, _retain, guard) =>
        Effect.gen(function* () {
          const creating = yield* requireManualCreateRecord(record);
          return yield* cleanupCreatingLease(creating, lease, undefined, guard);
        }),
    );

  const resolveCreateAsNotAllocated: SandboxManagerService["resolveCreateAsNotAllocated"] = (
    record,
    confirmedAbsentAt,
  ) =>
    withLeaseOperationLock(record.data, "resolve-create-not-allocated", () =>
      Effect.gen(function* () {
        const creating = yield* requireManualCreateRecord(record);
        const startedAt = Date.parse(creating.data.usageStartedAt);
        const observedAt = now();
        if (
          !isValidEpochMilliseconds(confirmedAbsentAt) ||
          confirmedAbsentAt < startedAt ||
          confirmedAbsentAt > observedAt
        ) {
          return yield* Effect.fail(
            new SandboxRecordError({
              cause: { confirmedAbsentAt, observedAt, startedAt },
              message: "Confirmed-absent allocation time must be within the observed attempt.",
            }),
          );
        }
        return yield* terminalTransition(
          creating,
          {
            failureReason: "provider-create-manually-confirmed-absent",
            status: "destroyed",
          },
          "sandbox.destroyed",
          {
            completedAt: confirmedAbsentAt,
            nextComputeUsageActive: false,
          },
        );
      }),
    );

  return {
    reconcileCreate,
    reconcileCreateWithCleanup,
    reconcileCreateWithLease,
    resolveCreateAsNotAllocated,
  };
}

export type CreateReconciliationRuntime = ReturnType<typeof createCreateReconciliationRuntime>;
