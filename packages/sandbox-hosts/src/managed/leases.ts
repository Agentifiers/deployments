import { MAX_SANDBOX_RESERVED_MEMORY_MIB, MAX_SANDBOX_RESERVED_VCPU } from "@deployments-ai/db";
import type { CreateSandboxInput, SandboxLease, SandboxProvider } from "../types.ts";
import {
  DEFAULT_SANDBOX_RESERVED_MEMORY_MIB,
  DEFAULT_SANDBOX_RESERVED_VCPU,
  SandboxAllocationCleanupError,
  SandboxAllocationLeaseError,
  SandboxAllocationUnknownError,
  SandboxCheckpointUnknownError,
  SandboxDataPlaneUnknownError,
  SandboxDestroyUnknownError,
  SandboxResumeUnknownError,
  isValidEpochMilliseconds,
} from "../types.ts";
import { SandboxRecordError, type SandboxLeaseRecordValue } from "./contracts.ts";
import { positiveReservation } from "./records.ts";

export function leaseFromRecord(record: SandboxLeaseRecordValue): SandboxLease {
  const externalSandboxId = record.data.externalSandboxId;
  if (!externalSandboxId) {
    throw new SandboxRecordError({
      cause: record,
      message: "Sandbox lease has no external sandbox identifier.",
    });
  }
  return {
    executionTargetId: record.data.executionTargetId,
    executionTargetKind: record.data.executionTargetKind,
    environmentId: record.data.environmentId,
    externalSandboxId,
    isolationMode: record.data.isolationMode,
    organizationId: record.data.organizationId,
    projectId: record.data.projectId,
    provider: record.data.provider,
    status: record.data.status,
    ...(record.data.accessPolicyRef ? { accessPolicyRef: record.data.accessPolicyRef } : {}),
    ...(record.data.checkpointRef ? { checkpointRef: record.data.checkpointRef } : {}),
    ...(record.data.imageRef ? { imageRef: record.data.imageRef } : {}),
    ...(record.data.leaseExpiresAt
      ? { leaseExpiresAt: Date.parse(record.data.leaseExpiresAt) }
      : {}),
    ...(record.data.poolKey ? { poolKey: record.data.poolKey } : {}),
    ...(record.data.providerRouteKey ? { providerRouteKey: record.data.providerRouteKey } : {}),
    ...(record.data.region ? { region: record.data.region } : {}),
    ...(record.data.reservedMemoryMiB ? { reservedMemoryMiB: record.data.reservedMemoryMiB } : {}),
    ...(record.data.reservedVcpu ? { reservedVcpu: record.data.reservedVcpu } : {}),
    ...(record.data.runId ? { runId: record.data.runId } : {}),
    ...(record.data.workspaceId ? { workspaceId: record.data.workspaceId } : {}),
  };
}

export function assertLeaseIdentityMatches(
  input: CreateSandboxInput,
  lease: SandboxLease,
  provider: SandboxProvider,
) {
  if (
    lease.provider !== provider.name ||
    lease.organizationId !== input.organizationId ||
    lease.projectId !== input.projectId ||
    lease.environmentId !== input.environmentId ||
    lease.executionTargetId !== input.executionTargetId ||
    lease.executionTargetKind !== input.executionTargetKind ||
    lease.runId !== input.runId ||
    lease.workspaceId !== input.workspaceId ||
    lease.isolationMode !== input.isolationMode ||
    lease.poolKey !== input.poolKey
  ) {
    throw new SandboxRecordError({
      cause: lease,
      message: "Sandbox provider returned a lease outside the requested tenant or run scope.",
    });
  }
}

export function assertLeaseReady(
  lease: SandboxLease,
  input: CreateSandboxInput,
  observedAt: number,
) {
  if (
    lease.status !== "ready" ||
    (input.accessPolicyRef !== undefined && lease.accessPolicyRef !== input.accessPolicyRef) ||
    (input.imageRef !== undefined && lease.imageRef !== input.imageRef)
  ) {
    throw new SandboxRecordError({
      cause: lease,
      message: "Sandbox provider returned a lease with invalid readiness, policy, or image.",
    });
  }
  if (
    lease.leaseExpiresAt !== undefined &&
    (!isValidEpochMilliseconds(lease.leaseExpiresAt) || lease.leaseExpiresAt <= observedAt)
  ) {
    throw new SandboxRecordError({
      cause: lease,
      message: "Sandbox provider returned an expired ready lease.",
    });
  }
  const reservedMemoryMiB = positiveReservation(
    lease.reservedMemoryMiB,
    input.minMemoryMiB ?? DEFAULT_SANDBOX_RESERVED_MEMORY_MIB,
    "reservedMemoryMiB",
    MAX_SANDBOX_RESERVED_MEMORY_MIB,
  );
  const reservedVcpu = positiveReservation(
    lease.reservedVcpu,
    input.minVcpu ?? DEFAULT_SANDBOX_RESERVED_VCPU,
    "reservedVcpu",
    MAX_SANDBOX_RESERVED_VCPU,
  );
  if (
    reservedMemoryMiB < (input.minMemoryMiB ?? DEFAULT_SANDBOX_RESERVED_MEMORY_MIB) ||
    reservedVcpu < (input.minVcpu ?? DEFAULT_SANDBOX_RESERVED_VCPU)
  ) {
    throw new SandboxRecordError({
      cause: lease,
      message: "Sandbox provider returned fewer resources than requested.",
    });
  }
}

export function allocatedLeaseFromFailure(error: unknown):
  | {
      readonly cleanupCompletedAt?: number;
      readonly identityVerified: boolean;
      readonly lease: SandboxLease;
    }
  | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof SandboxAllocationCleanupError) {
      return { identityVerified: true, lease: current.lease };
    }
    if (current instanceof SandboxAllocationLeaseError) {
      return {
        identityVerified: current.identityVerified,
        lease: current.lease,
        ...(current.cleanupCompletedAt !== undefined
          ? { cleanupCompletedAt: current.cleanupCompletedAt }
          : {}),
      };
    }
    current = (current as Readonly<Record<string, unknown>>).cause;
  }
  return undefined;
}

export function allocationOutcomeUnknown(error: unknown) {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof SandboxAllocationUnknownError) return current;
    current = (current as Readonly<Record<string, unknown>>).cause;
  }
  return undefined;
}

export function resumeOutcomeMayBeActive(error: unknown) {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof SandboxResumeUnknownError) return true;
    current = (current as Readonly<Record<string, unknown>>).cause;
  }
  return false;
}

export function checkpointOutcomeMayBeSuspended(error: unknown) {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof SandboxCheckpointUnknownError) return true;
    current = (current as Readonly<Record<string, unknown>>).cause;
  }
  return false;
}

export function destroyOutcomeMayHaveCompleted(error: unknown) {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof SandboxDestroyUnknownError) return true;
    current = (current as Readonly<Record<string, unknown>>).cause;
  }
  return false;
}

export function dataPlaneOutcomeMayBeInFlight(error: unknown) {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof SandboxDataPlaneUnknownError) return true;
    current = (current as Readonly<Record<string, unknown>>).cause;
  }
  return false;
}

export function assertResumedLeaseMatches(
  current: SandboxLease,
  resumed: SandboxLease,
  provider: SandboxProvider,
  expectedStatus: "ready" | "suspended" = "ready",
) {
  if (
    resumed.provider !== provider.name ||
    resumed.provider !== current.provider ||
    resumed.organizationId !== current.organizationId ||
    resumed.projectId !== current.projectId ||
    resumed.environmentId !== current.environmentId ||
    resumed.executionTargetId !== current.executionTargetId ||
    resumed.executionTargetKind !== current.executionTargetKind ||
    resumed.runId !== current.runId ||
    resumed.workspaceId !== current.workspaceId ||
    resumed.isolationMode !== current.isolationMode ||
    resumed.externalSandboxId !== current.externalSandboxId ||
    resumed.poolKey !== current.poolKey ||
    resumed.providerRouteKey !== current.providerRouteKey ||
    resumed.accessPolicyRef !== current.accessPolicyRef ||
    resumed.imageRef !== current.imageRef ||
    resumed.status !== expectedStatus
  ) {
    throw new SandboxRecordError({
      cause: resumed,
      message: "Sandbox provider returned a resumed lease with mismatched identity or routing.",
    });
  }
  const resumedMemoryMiB = positiveReservation(
    resumed.reservedMemoryMiB,
    current.reservedMemoryMiB ?? DEFAULT_SANDBOX_RESERVED_MEMORY_MIB,
    "reservedMemoryMiB",
    MAX_SANDBOX_RESERVED_MEMORY_MIB,
  );
  const resumedVcpu = positiveReservation(
    resumed.reservedVcpu,
    current.reservedVcpu ?? DEFAULT_SANDBOX_RESERVED_VCPU,
    "reservedVcpu",
    MAX_SANDBOX_RESERVED_VCPU,
  );
  if (
    resumedMemoryMiB < (current.reservedMemoryMiB ?? DEFAULT_SANDBOX_RESERVED_MEMORY_MIB) ||
    resumedVcpu < (current.reservedVcpu ?? DEFAULT_SANDBOX_RESERVED_VCPU)
  ) {
    throw new SandboxRecordError({
      cause: resumed,
      message: "Sandbox provider reduced resources while resuming the lease.",
    });
  }
}

export function reconcileResumedLease(
  current: SandboxLease,
  resumed: SandboxLease,
  readyObservedAt?: number,
): SandboxLease {
  if (resumed.leaseExpiresAt !== undefined && !isValidEpochMilliseconds(resumed.leaseExpiresAt)) {
    throw new SandboxRecordError({
      cause: resumed,
      message: "Sandbox provider returned an invalid resumed lease expiration.",
    });
  }
  const checkpointRef = resumed.checkpointRef ?? current.checkpointRef;
  const leaseExpiresAt = resumed.leaseExpiresAt ?? current.leaseExpiresAt;
  const region = resumed.region ?? current.region;
  const reservedMemoryMiB = resumed.reservedMemoryMiB ?? current.reservedMemoryMiB;
  const reservedVcpu = resumed.reservedVcpu ?? current.reservedVcpu;
  if (
    readyObservedAt !== undefined &&
    leaseExpiresAt !== undefined &&
    leaseExpiresAt <= readyObservedAt
  ) {
    throw new SandboxRecordError({
      cause: resumed,
      message: "Sandbox provider returned an expired resumed lease.",
    });
  }
  return {
    ...current,
    ...resumed,
    ...(checkpointRef === undefined ? {} : { checkpointRef }),
    ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt }),
    ...(region === undefined ? {} : { region }),
    ...(reservedMemoryMiB === undefined ? {} : { reservedMemoryMiB }),
    ...(reservedVcpu === undefined ? {} : { reservedVcpu }),
  };
}

export function validatedProviderLease(
  record: SandboxLeaseRecordValue,
  lease: SandboxLease,
  provider: SandboxProvider,
) {
  const persisted = leaseFromRecord(record);
  if (
    lease.provider !== provider.name ||
    lease.provider !== persisted.provider ||
    lease.organizationId !== persisted.organizationId ||
    lease.projectId !== persisted.projectId ||
    lease.environmentId !== persisted.environmentId ||
    lease.executionTargetId !== persisted.executionTargetId ||
    lease.executionTargetKind !== persisted.executionTargetKind ||
    lease.runId !== persisted.runId ||
    lease.workspaceId !== persisted.workspaceId ||
    lease.isolationMode !== persisted.isolationMode ||
    lease.externalSandboxId !== persisted.externalSandboxId ||
    lease.poolKey !== persisted.poolKey ||
    lease.providerRouteKey !== persisted.providerRouteKey ||
    lease.region !== persisted.region ||
    lease.checkpointRef !== persisted.checkpointRef ||
    lease.accessPolicyRef !== persisted.accessPolicyRef ||
    lease.imageRef !== persisted.imageRef ||
    lease.leaseExpiresAt !== persisted.leaseExpiresAt ||
    lease.status !== persisted.status ||
    (lease.reservedMemoryMiB !== undefined &&
      lease.reservedMemoryMiB !== persisted.reservedMemoryMiB) ||
    (lease.reservedVcpu !== undefined && lease.reservedVcpu !== persisted.reservedVcpu)
  ) {
    throw new SandboxRecordError({
      cause: lease,
      message: "Sandbox provider lease does not match its persisted lifecycle record.",
    });
  }
  if (provider.validateLeaseRoute && !persisted.providerRouteKey) {
    throw new SandboxRecordError({
      cause: record,
      message: "Sandbox lifecycle record is missing its provider route key.",
    });
  }
  provider.validateLeaseRoute?.(persisted);
  return persisted;
}

export function sourceFor(record: SandboxLeaseRecordValue) {
  return record.data.poolKey
    ? `lambda-microvm-sandbox:${record.data.poolKey}`
    : "lambda-microvm-sandbox";
}
