import {
  IdGenerationError,
  type IdGeneratorService,
  MAX_SANDBOX_RESERVED_MEMORY_MIB,
  MAX_SANDBOX_RESERVED_VCPU,
  RuntimeLeaseRecord,
  type PlatformRecord,
  type TransactionOperation,
  UNIQUE_CLAIM_CONDITION,
  type Ulid,
  decodePlatformRecord,
  internalSemanticEventPayload,
  makeUniqueClaimRecord,
  uniqueClaimRequirements,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { makeSemanticEventRecord } from "@deployments-ai/events";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { CreateSandboxInput, SandboxLease, SandboxProvider } from "../types.ts";
import {
  DEFAULT_SANDBOX_RESERVED_MEMORY_MIB,
  DEFAULT_SANDBOX_RESERVED_VCPU,
  isValidEpochMilliseconds,
} from "../types.ts";
import { SandboxRecordError, type SandboxLeaseRecordValue } from "./contracts.ts";

export type RuntimeLeaseRecordValue = typeof RuntimeLeaseRecord.Type;
export type ScopedRuntimeLeaseRecordValue = Omit<RuntimeLeaseRecordValue, "data"> & {
  readonly data: Omit<
    RuntimeLeaseRecordValue["data"],
    "environmentId" | "organizationId" | "projectId"
  > & {
    readonly environmentId: Exclude<RuntimeLeaseRecordValue["data"]["environmentId"], undefined>;
    readonly organizationId: Exclude<RuntimeLeaseRecordValue["data"]["organizationId"], undefined>;
    readonly projectId: Exclude<RuntimeLeaseRecordValue["data"]["projectId"], undefined>;
  };
};

export function hasRuntimeLeaseScope(
  record: RuntimeLeaseRecordValue,
): record is ScopedRuntimeLeaseRecordValue {
  return (
    record.data.environmentId !== undefined &&
    record.data.organizationId !== undefined &&
    record.data.projectId !== undefined
  );
}

export function timestamp(milliseconds: number) {
  return new Date(milliseconds).toISOString();
}

/** Lifts the sync id generator into the managed Effect error channel as `IdGenerationError`. */
export function generateId(ids: IdGeneratorService) {
  return Effect.try({
    catch: (cause) =>
      cause instanceof IdGenerationError
        ? cause
        : new IdGenerationError({ cause, message: "Failed to generate a platform ULID." }),
    try: () => ids.generate(),
  });
}

function decodeSandboxLeaseRecord(input: unknown) {
  return decodePlatformRecord(input).pipe(
    Effect.flatMap((record) =>
      record.itemType === "sandbox-lease"
        ? Effect.succeed(record)
        : Effect.fail(
            new SandboxRecordError({
              cause: record,
              message: "Expected a sandbox lease record.",
            }),
          ),
    ),
  );
}

function decodeRuntimeLeaseRecord(input: unknown) {
  return decodePlatformRecord(input).pipe(
    Effect.flatMap((record) =>
      record.itemType === "runtime-lease"
        ? Effect.succeed(record)
        : Effect.fail(
            new SandboxRecordError({
              cause: record,
              message: "Expected a runtime lease record.",
            }),
          ),
    ),
  );
}

export function createRuntimeLeaseRecord(input: {
  readonly acquiredAt: number;
  readonly environmentId: Ulid;
  readonly expiresAt: number;
  readonly id: Ulid;
  readonly leaseKey: string;
  readonly organizationId: Ulid;
  readonly owner: string;
  readonly projectId: Ulid;
  readonly renewedAt?: number;
  readonly version: number;
}) {
  return decodeRuntimeLeaseRecord(
    withCanonicalRecordKeys({
      data: {
        acquiredAt: timestamp(input.acquiredAt),
        environmentId: input.environmentId,
        expiresAt: timestamp(input.expiresAt),
        id: input.id,
        leaseKey: input.leaseKey,
        organizationId: input.organizationId,
        owner: input.owner,
        projectId: input.projectId,
        version: input.version,
        ...(input.renewedAt === undefined ? {} : { renewedAt: timestamp(input.renewedAt) }),
      },
      itemType: "runtime-lease" as const,
    }),
  ).pipe(
    Effect.flatMap((record) =>
      hasRuntimeLeaseScope(record)
        ? Effect.succeed(record)
        : Effect.fail(
            new SandboxRecordError({
              cause: record,
              message: "Runtime lease tenant scope was not preserved.",
            }),
          ),
    ),
  );
}

export function createLeaseRecord(
  input: CreateSandboxInput,
  id: Ulid,
  provider: SandboxProvider,
  now: number,
  providerConfigFingerprint?: string,
) {
  const occurredAt = timestamp(now);
  return Effect.try({
    catch: (cause) =>
      cause instanceof SandboxRecordError
        ? cause
        : new SandboxRecordError({
            cause,
            message: "Invalid sandbox reservation request.",
          }),
    try: () => {
      if (input.runId !== undefined && input.observability === undefined) {
        throw new SandboxRecordError({
          cause: { runId: input.runId },
          message: "A run-owned sandbox requires the run's immutable trace context.",
        });
      }
      const requestedMemoryMiB = positiveReservation(
        input.minMemoryMiB,
        DEFAULT_SANDBOX_RESERVED_MEMORY_MIB,
        "minMemoryMiB",
        MAX_SANDBOX_RESERVED_MEMORY_MIB,
      );
      const requestedVcpu = positiveReservation(
        input.minVcpu,
        DEFAULT_SANDBOX_RESERVED_VCPU,
        "minVcpu",
        MAX_SANDBOX_RESERVED_VCPU,
      );
      const providerReservation = provider.provisioningReservation?.(input);
      const reservedMemoryMiB = positiveReservation(
        providerReservation?.reservedMemoryMiB,
        requestedMemoryMiB,
        "reservedMemoryMiB",
        MAX_SANDBOX_RESERVED_MEMORY_MIB,
      );
      const reservedVcpu = positiveReservation(
        providerReservation?.reservedVcpu,
        requestedVcpu,
        "reservedVcpu",
        MAX_SANDBOX_RESERVED_VCPU,
      );
      if (reservedMemoryMiB < requestedMemoryMiB || reservedVcpu < requestedVcpu) {
        throw new SandboxRecordError({
          cause: providerReservation,
          message: "Sandbox provider reservation is smaller than the requested minimum.",
        });
      }
      return withCanonicalRecordKeys({
        data: {
          computeUsageActive: true,
          createdAt: occurredAt,
          executionTargetId: input.executionTargetId,
          executionTargetKind: input.executionTargetKind,
          environmentId: input.environmentId,
          id,
          isolationMode: input.isolationMode,
          organizationId: input.organizationId,
          ...(input.observability ? { observability: input.observability } : {}),
          projectId: input.projectId,
          provider: provider.name,
          ...(providerConfigFingerprint ? { providerConfigFingerprint } : {}),
          requestedMemoryMiB,
          requestedVcpu,
          reservedMemoryMiB,
          reservedVcpu,
          status: "creating" as const,
          updatedAt: occurredAt,
          usageStartedAt: occurredAt,
          version: 0,
          ...(input.accessPolicyRef ? { accessPolicyRef: input.accessPolicyRef } : {}),
          ...(input.imageRef ? { imageRef: input.imageRef } : {}),
          ...(input.poolKey ? { poolKey: input.poolKey } : {}),
          ...(input.preferredRegion ? { preferredRegion: input.preferredRegion } : {}),
          ...(input.runId ? { runId: input.runId } : {}),
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        },
        itemType: "sandbox-lease" as const,
      });
    },
  }).pipe(Effect.flatMap(decodeSandboxLeaseRecord));
}

export function createInputFromRecord(record: SandboxLeaseRecordValue): CreateSandboxInput {
  const preferredRegion = record.data.preferredRegion ?? record.data.region;
  const requestedMemoryMiB = record.data.requestedMemoryMiB ?? record.data.reservedMemoryMiB;
  const requestedVcpu = record.data.requestedVcpu ?? record.data.reservedVcpu;
  return {
    allocationId: record.data.id,
    executionTargetId: record.data.executionTargetId,
    executionTargetKind: record.data.executionTargetKind,
    environmentId: record.data.environmentId,
    isolationMode: record.data.isolationMode,
    organizationId: record.data.organizationId,
    ...(record.data.observability ? { observability: record.data.observability } : {}),
    projectId: record.data.projectId,
    ...(record.data.accessPolicyRef ? { accessPolicyRef: record.data.accessPolicyRef } : {}),
    ...(record.data.imageRef ? { imageRef: record.data.imageRef } : {}),
    ...(requestedMemoryMiB ? { minMemoryMiB: requestedMemoryMiB } : {}),
    ...(requestedVcpu ? { minVcpu: requestedVcpu } : {}),
    ...(record.data.poolKey ? { poolKey: record.data.poolKey } : {}),
    ...(preferredRegion ? { preferredRegion } : {}),
    ...(record.data.runId ? { runId: record.data.runId } : {}),
    ...(record.data.workspaceId ? { workspaceId: record.data.workspaceId } : {}),
  };
}

export function positiveReservation(
  value: number | undefined,
  fallback: number,
  field: string,
  maximum: number,
) {
  const reservation = value ?? fallback;
  if (!Number.isFinite(reservation) || reservation <= 0) {
    throw new SandboxRecordError({
      cause: value,
      message: `Sandbox ${field} must be a positive finite number.`,
    });
  }
  if (reservation > maximum) {
    throw new SandboxRecordError({
      cause: value,
      message: `Sandbox ${field} must be no greater than ${maximum}.`,
    });
  }
  return reservation;
}

export function allocationUpdates(
  input: CreateSandboxInput,
  lease: SandboxLease,
  provisioningReservation?: {
    readonly reservedMemoryMiB?: number | undefined;
    readonly reservedVcpu?: number | undefined;
  },
) {
  if (!lease.externalSandboxId.trim()) {
    throw new SandboxRecordError({
      cause: lease,
      message: "Sandbox provider returned an empty external sandbox identifier.",
    });
  }
  return {
    externalSandboxId: lease.externalSandboxId,
    imageRef: lease.imageRef ?? input.imageRef,
    leaseExpiresAt:
      lease.leaseExpiresAt !== undefined && isValidEpochMilliseconds(lease.leaseExpiresAt)
        ? timestamp(lease.leaseExpiresAt)
        : undefined,
    poolKey: lease.poolKey ?? input.poolKey,
    providerRouteKey: lease.providerRouteKey,
    reservedMemoryMiB:
      lease.reservedMemoryMiB !== undefined &&
      Number.isFinite(lease.reservedMemoryMiB) &&
      lease.reservedMemoryMiB > 0 &&
      lease.reservedMemoryMiB <= MAX_SANDBOX_RESERVED_MEMORY_MIB
        ? lease.reservedMemoryMiB
        : (provisioningReservation?.reservedMemoryMiB ??
          input.minMemoryMiB ??
          DEFAULT_SANDBOX_RESERVED_MEMORY_MIB),
    reservedVcpu:
      lease.reservedVcpu !== undefined &&
      Number.isFinite(lease.reservedVcpu) &&
      lease.reservedVcpu > 0 &&
      lease.reservedVcpu <= MAX_SANDBOX_RESERVED_VCPU
        ? lease.reservedVcpu
        : (provisioningReservation?.reservedVcpu ?? input.minVcpu ?? DEFAULT_SANDBOX_RESERVED_VCPU),
    ...(lease.accessPolicyRef ? { accessPolicyRef: lease.accessPolicyRef } : {}),
    ...(lease.region ? { region: lease.region } : {}),
  };
}

export function recoveryMetadataUpdates(updates: Readonly<Record<string, unknown>>) {
  const { externalSandboxId: _externalSandboxId, ...metadata } = updates;
  return metadata;
}

export function updateLeaseRecord(
  previous: SandboxLeaseRecordValue,
  updates: Readonly<Record<string, unknown>>,
  now: number,
  removeFields: readonly string[] = [],
) {
  const definedUpdates = Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined),
  );
  const data: Record<string, unknown> = {
    ...previous.data,
    ...definedUpdates,
    updatedAt: timestamp(now),
    version: previous.data.version + 1,
  };
  for (const field of removeFields) delete data[field];
  return decodeSandboxLeaseRecord(
    withCanonicalRecordKeys({
      ...previous,
      data,
    }),
  );
}

export function leaseRecordWithUpdates(
  previous: SandboxLeaseRecordValue,
  updates: Readonly<Record<string, unknown>>,
) {
  return decodeSandboxLeaseRecord(
    withCanonicalRecordKeys({
      ...previous,
      data: {
        ...previous.data,
        ...Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== undefined)),
      },
    }),
  );
}

function eventPayload(record: SandboxLeaseRecordValue) {
  return {
    ...(record.data.checkpointRef ? { checkpointRef: record.data.checkpointRef } : {}),
    executionTargetId: record.data.executionTargetId,
    executionTargetKind: record.data.executionTargetKind,
    ...(record.data.destroyCompletedAt
      ? { destroyCompletedAt: record.data.destroyCompletedAt }
      : {}),
    ...(record.data.externalSandboxId ? { externalSandboxId: record.data.externalSandboxId } : {}),
    ...(record.data.failureReason ? { failureReason: record.data.failureReason } : {}),
    ...(record.data.imageRef ? { imageRef: record.data.imageRef } : {}),
    isolationMode: record.data.isolationMode,
    leaseId: record.data.id,
    ...(record.data.poolKey ? { poolKey: record.data.poolKey } : {}),
    ...(record.data.providerRouteKey ? { providerRouteKey: record.data.providerRouteKey } : {}),
    provider: record.data.provider,
    ...(record.data.runId ? { runId: record.data.runId } : {}),
    status: record.data.status,
  };
}

export function semanticEvent(record: SandboxLeaseRecordValue, eventId: Ulid, eventType: string) {
  return makeSemanticEventRecord({
    aggregateId: record.data.id,
    aggregateType: "sandbox-lease",
    aggregateVersion: record.data.version + 1,
    environmentId: record.data.environmentId,
    eventId,
    eventType,
    occurredAt: record.data.updatedAt,
    organizationId: record.data.organizationId,
    // Sandboxes of preview/evaluation executions are audit-only, like their other semantic events.
    payload:
      record.data.executionTargetKind === "agent-deployment"
        ? eventPayload(record)
        : internalSemanticEventPayload(eventPayload(record)),
    projectId: record.data.projectId,
  });
}

export function transitionRequestToken(
  record: SandboxLeaseRecordValue,
  event: ReturnType<typeof semanticEvent>,
) {
  const digest = createHash("sha256")
    .update(JSON.stringify({ event, record }))
    .digest("hex")
    .slice(0, 32);
  return `sbx-${digest}`;
}

export function newSandboxIdentityClaimOperations(
  previous: SandboxLeaseRecordValue | undefined,
  record: SandboxLeaseRecordValue,
) {
  const previousClaims = previous ? uniqueClaimRequirements(previous) : [];
  const additions = uniqueClaimRequirements(record).filter(
    (claim) =>
      !previousClaims.some(
        (previousClaim) =>
          previousClaim.namespace === claim.namespace && previousClaim.value === claim.value,
      ),
  );
  return Effect.forEach(additions, (claim) =>
    decodePlatformRecord(makeUniqueClaimRecord(claim, record.data.updatedAt)).pipe(
      Effect.map(
        (claimRecord): TransactionOperation => ({
          conditionExpression: UNIQUE_CLAIM_CONDITION,
          kind: "put",
          record: claimRecord,
        }),
      ),
    ),
  );
}

export function put(previousRecord: SandboxLeaseRecordValue | undefined, record: PlatformRecord) {
  return {
    kind: "put" as const,
    ...(previousRecord ? { previousRecord } : {}),
    record,
  } satisfies TransactionOperation;
}
