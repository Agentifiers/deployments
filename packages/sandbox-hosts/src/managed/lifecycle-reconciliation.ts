import { fromDatabase, sandboxHostPersistence } from "@deployments-ai/db";
import { isDeepStrictEqual } from "node:util";
import { Effect } from "effect";
import type { CheckpointReconciliation, SandboxLease } from "../types.ts";
import {
  SandboxRecordError,
  type ManagerBase,
  type SandboxLeaseRecordValue,
  type SandboxManagerService,
} from "./contracts.ts";
import { assertResumedLeaseMatches, leaseFromRecord, reconcileResumedLease } from "./leases.ts";
import { managedSandboxFromRecord } from "./public.ts";
import { timestamp, updateLeaseRecord } from "./records.ts";
import type { OperationRuntime } from "./operations.ts";
import type { TransitionRuntime } from "./transitions.ts";

export function createLifecycleReconciliationRuntime(
  context: ManagerBase & TransitionRuntime & OperationRuntime,
) {
  const {
    provider,
    database,
    now,
    transition,
    terminalTransition,
    commitTransition,
    unlockedProviderCall,
    withLeaseOperationLock,
  } = context;
  function requireCheckpointingRecord(record: SandboxLeaseRecordValue) {
    return Effect.gen(function* () {
      if (record.data.provider !== provider.name || record.data.status !== "checkpointing") {
        return yield* Effect.fail(
          new SandboxRecordError({
            cause: record,
            message: "Checkpoint reconciliation requires a checkpointing lease.",
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
            message: "Sandbox checkpoint state changed; reload before reconciliation.",
          }),
        );
      }
      return record;
    });
  }

  function commitReconciledCheckpoint(
    checkpointing: SandboxLeaseRecordValue,
    reconciliation: CheckpointReconciliation,
  ) {
    return Effect.gen(function* () {
      const currentLease = leaseFromRecord(checkpointing);
      const expectedStatus = reconciliation.lease.status === "suspended" ? "suspended" : "ready";
      yield* Effect.try({
        catch: (cause) =>
          cause instanceof SandboxRecordError
            ? cause
            : new SandboxRecordError({
                cause,
                message: "Invalid reconciled checkpoint state.",
              }),
        try: () => {
          assertResumedLeaseMatches(currentLease, reconciliation.lease, provider, expectedStatus);
          provider.validateLeaseRoute?.(reconciliation.lease);
        },
      });
      const reconciledAt = now();
      const reconciledLease = yield* Effect.try({
        catch: (cause) =>
          cause instanceof SandboxRecordError
            ? cause
            : new SandboxRecordError({
                cause,
                message: "Invalid reconciled checkpoint state.",
              }),
        try: () =>
          reconcileResumedLease(
            currentLease,
            reconciliation.lease,
            reconciliation.lease.status === "ready" ? reconciledAt : undefined,
          ),
      });
      const updates = {
        lastHeartbeatAt: timestamp(reconciledAt),
        leaseExpiresAt:
          reconciledLease.leaseExpiresAt === undefined
            ? undefined
            : timestamp(reconciledLease.leaseExpiresAt),
        region: reconciledLease.region,
        reservedMemoryMiB: reconciledLease.reservedMemoryMiB,
        reservedVcpu: reconciledLease.reservedVcpu,
      };
      if (reconciliation.lease.status === "ready") {
        const ready = yield* terminalTransition(
          checkpointing,
          { ...updates, status: "ready" },
          "sandbox.ready",
          {
            completedAt: reconciledAt,
            nextComputeUsageActive: true,
            removeFields: ["checkpointRequestedAt", "failureReason", "usagePendingThrough"],
            transitionAt: reconciledAt,
          },
        );
        return managedSandboxFromRecord(ready);
      }
      if (!reconciliation.checkpoint) {
        return yield* Effect.fail(
          new SandboxRecordError({
            cause: reconciliation,
            message: "Suspended checkpoint reconciliation requires a checkpoint reference.",
          }),
        );
      }
      if (reconciliation.checkpoint.provider !== provider.name) {
        return yield* Effect.fail(
          new SandboxRecordError({
            cause: reconciliation,
            message: "Checkpoint reconciliation returned the wrong provider.",
          }),
        );
      }
      const minimumCheckpointAt = Math.max(
        Date.parse(checkpointing.data.checkpointRequestedAt ?? checkpointing.data.updatedAt),
        Date.parse(checkpointing.data.usageAccountedThrough ?? checkpointing.data.usageStartedAt),
      );
      if (
        !Number.isFinite(reconciliation.checkpoint.createdAt) ||
        reconciliation.checkpoint.createdAt < minimumCheckpointAt ||
        reconciliation.checkpoint.createdAt > reconciledAt
      ) {
        return yield* Effect.fail(
          new SandboxRecordError({
            cause: reconciliation.checkpoint,
            message: "Checkpoint reconciliation returned an invalid suspension timestamp.",
          }),
        );
      }
      const suspended = yield* terminalTransition(
        checkpointing,
        {
          ...updates,
          checkpointRef: reconciliation.checkpoint.checkpointRef,
          status: "suspended",
        },
        "sandbox.suspended",
        {
          completedAt: reconciliation.checkpoint.createdAt,
          nextComputeUsageActive: false,
          transitionAt: reconciledAt,
        },
      );
      return managedSandboxFromRecord(suspended);
    });
  }

  const reconcileCheckpointWithResult: SandboxManagerService["reconcileCheckpointWithResult"] = (
    record,
    reconciliation,
  ) =>
    withLeaseOperationLock(record.data, "reconcile-checkpoint", () =>
      Effect.gen(function* () {
        const checkpointing = yield* requireCheckpointingRecord(record);
        return yield* commitReconciledCheckpoint(checkpointing, reconciliation);
      }),
    );

  const reconcileCheckpoint: SandboxManagerService["reconcileCheckpoint"] = (record) =>
    withLeaseOperationLock(record.data, "reconcile-checkpoint", (signal) =>
      Effect.gen(function* () {
        const checkpointing = yield* requireCheckpointingRecord(record);
        if (!provider.reconcileCheckpoint) {
          return yield* Effect.fail(
            new SandboxRecordError({
              cause: record,
              message: "Sandbox provider requires manual checkpoint reconciliation.",
            }),
          );
        }
        const reconciliation = yield* unlockedProviderCall(
          "reconcile-checkpoint",
          checkpointing.data.id,
          (combinedSignal) =>
            provider.reconcileCheckpoint?.({
              lease: leaseFromRecord(checkpointing),
              requestedAt: Date.parse(
                checkpointing.data.checkpointRequestedAt ?? checkpointing.data.updatedAt,
              ),
              signal: combinedSignal,
            }) as Promise<CheckpointReconciliation>,
          signal,
        );
        return yield* commitReconciledCheckpoint(checkpointing, reconciliation);
      }),
    );

  function requireResumingRecord(record: SandboxLeaseRecordValue) {
    return Effect.gen(function* () {
      if (record.data.provider !== provider.name || record.data.status !== "resuming") {
        return yield* Effect.fail(
          new SandboxRecordError({
            cause: record,
            message: "Resume reconciliation requires a resuming lease.",
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
            message: "Sandbox resume state changed; reload before reconciliation.",
          }),
        );
      }
      return record;
    });
  }

  function commitReconciledResume(resuming: SandboxLeaseRecordValue, providerLease: SandboxLease) {
    return Effect.gen(function* () {
      const currentLease = leaseFromRecord(resuming);
      const expectedStatus = providerLease.status === "suspended" ? "suspended" : "ready";
      yield* Effect.try({
        catch: (cause) =>
          cause instanceof SandboxRecordError
            ? cause
            : new SandboxRecordError({
                cause,
                message: "Invalid reconciled sandbox lease.",
              }),
        try: () => {
          assertResumedLeaseMatches(currentLease, providerLease, provider, expectedStatus);
          provider.validateLeaseRoute?.(providerLease);
        },
      });
      const reconciledAt = now();
      const reconciledLease = yield* Effect.try({
        catch: (cause) =>
          cause instanceof SandboxRecordError
            ? cause
            : new SandboxRecordError({
                cause,
                message: "Invalid reconciled sandbox lease.",
              }),
        try: () =>
          reconcileResumedLease(
            currentLease,
            providerLease,
            providerLease.status === "ready" ? reconciledAt : undefined,
          ),
      });
      const updates = {
        checkpointRef: reconciledLease.checkpointRef,
        lastHeartbeatAt: timestamp(reconciledAt),
        leaseExpiresAt:
          reconciledLease.leaseExpiresAt === undefined
            ? undefined
            : timestamp(reconciledLease.leaseExpiresAt),
        region: reconciledLease.region,
        reservedMemoryMiB: reconciledLease.reservedMemoryMiB,
        reservedVcpu: reconciledLease.reservedVcpu,
      };
      if (providerLease.status === "suspended") {
        const usageCutoff = Date.parse(
          resuming.data.usageAccountedThrough ??
            resuming.data.resumeRequestedAt ??
            resuming.data.updatedAt,
        );
        const suspended = resuming.data.computeUsageActive
          ? yield* terminalTransition(
              resuming,
              { ...updates, status: "suspended" },
              "sandbox.suspended",
              {
                completedAt: usageCutoff,
                nextComputeUsageActive: false,
                removeFields: ["resumeRequestedAt"],
                transitionAt: reconciledAt,
              },
            )
          : yield* transition(
              resuming,
              { ...updates, computeUsageActive: false, status: "suspended" },
              "sandbox.suspended",
              ["resumeRequestedAt"],
            );
        return managedSandboxFromRecord(suspended);
      }
      const resumedAt = timestamp(reconciledAt);
      if (resuming.data.computeUsageActive) {
        const ready = yield* terminalTransition(
          resuming,
          { ...updates, readyAt: resumedAt, status: "ready" },
          "sandbox.resumed",
          {
            completedAt: reconciledAt,
            nextComputeUsageActive: true,
            removeFields: ["failureReason", "resumeRequestedAt"],
            transitionAt: reconciledAt,
          },
        );
        return { lease: leaseFromRecord(ready), record: ready };
      }
      const ready = yield* updateLeaseRecord(
        resuming,
        {
          ...updates,
          computeUsageActive: true,
          readyAt: resumedAt,
          status: "ready",
          usageAccountedThrough: resumedAt,
        },
        reconciledAt,
        ["failureReason", "resumeRequestedAt"],
      );
      yield* commitTransition(resuming, ready, "sandbox.resumed");
      return { lease: leaseFromRecord(ready), record: ready };
    });
  }

  const reconcileResumeWithLease: SandboxManagerService["reconcileResumeWithLease"] = (
    record,
    lease,
  ) =>
    withLeaseOperationLock(record.data, "reconcile-resume", () =>
      Effect.gen(function* () {
        const resuming = yield* requireResumingRecord(record);
        return yield* commitReconciledResume(resuming, lease);
      }),
    );

  const reconcileResume: SandboxManagerService["reconcileResume"] = (record) =>
    withLeaseOperationLock(record.data, "reconcile-resume", (signal) =>
      Effect.gen(function* () {
        const resuming = yield* requireResumingRecord(record);
        if (!provider.reconcileResume) {
          return yield* Effect.fail(
            new SandboxRecordError({
              cause: record,
              message: "Sandbox provider requires manual resume reconciliation.",
            }),
          );
        }
        const lease = yield* unlockedProviderCall(
          "reconcile-resume",
          resuming.data.id,
          (combinedSignal) =>
            provider.reconcileResume?.({
              lease: leaseFromRecord(resuming),
              requestedAt: Date.parse(resuming.data.resumeRequestedAt ?? resuming.data.updatedAt),
              signal: combinedSignal,
            }) as Promise<SandboxLease>,
          signal,
        );
        return yield* commitReconciledResume(resuming, lease);
      }),
    );
  return {
    reconcileCheckpoint,
    reconcileCheckpointWithResult,
    reconcileResume,
    reconcileResumeWithLease,
  };
}

export type LifecycleReconciliationRuntime = ReturnType<
  typeof createLifecycleReconciliationRuntime
>;
