import {
  type IdGeneratorService,
  type Ulid,
  decodePlatformRecord,
  meterEventFundingDimensions,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { Effect } from "effect";
import type { SandboxUsageCostPolicy } from "../types.ts";
import { DEFAULT_SANDBOX_RESERVED_MEMORY_MIB, DEFAULT_SANDBOX_RESERVED_VCPU } from "../types.ts";
import { SandboxRecordError, type SandboxLeaseRecordValue } from "./contracts.ts";
import { sourceFor } from "./leases.ts";
import { generateId, timestamp } from "./records.ts";

const MS_PER_HOUR = 60 * 60 * 1_000;
const MIB_PER_GIB = 1_024;

function usageCost(quantity: number, rate: number | undefined, denominator: number) {
  if (rate === undefined) return undefined;
  const match = quantity.toString().match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/iu);
  if (!match) {
    throw new SandboxRecordError({
      cause: { quantity, rate },
      message: "Sandbox usage cost cannot be represented exactly.",
    });
  }
  const fractionalDigits = match[2]?.length ?? 0;
  const exponent = Number(match[3] ?? 0);
  let quantityNumerator = BigInt(`${match[1]}${match[2] ?? ""}`);
  let quantityDenominator = 1n;
  const scale = fractionalDigits - exponent;
  if (scale > 0) quantityDenominator = 10n ** BigInt(scale);
  else if (scale < 0) quantityNumerator *= 10n ** BigInt(-scale);
  const costDenominator = quantityDenominator * BigInt(denominator);
  const costNumerator = quantityNumerator * BigInt(rate);
  const exactCost = (costNumerator + costDenominator / 2n) / costDenominator;
  if (exactCost > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SandboxRecordError({
      cause: { quantity, rate },
      message: "Sandbox usage cost exceeds the supported safe-integer range.",
    });
  }
  return Number(exactCost);
}

function meteredQuantity(quantity: number, metric: string) {
  if (
    !Number.isFinite(quantity) ||
    (Number.isInteger(quantity) && !Number.isSafeInteger(quantity))
  ) {
    throw new SandboxRecordError({
      cause: quantity,
      message: `Sandbox ${metric} quantity exceeds the supported numeric range.`,
    });
  }
  return quantity;
}

function meterEvent(
  record: SandboxLeaseRecordValue,
  dimensionsRecord: SandboxLeaseRecordValue,
  id: Ulid,
  metric: string,
  quantity: number,
  unit: string,
  segmentStartedAt: string,
  segmentEndedAt: string,
  occurredAt: string,
  costUsdMicros?: number,
) {
  return decodePlatformRecord(
    withCanonicalRecordKeys({
      data: {
        dimensions: {
          ...(costUsdMicros === undefined
            ? {}
            : { costUsdMicros, ...meterEventFundingDimensions({ kind: "operator" }) }),
          executionTargetId: dimensionsRecord.data.executionTargetId,
          executionTargetKind: dimensionsRecord.data.executionTargetKind,
          ...(dimensionsRecord.data.externalSandboxId
            ? { externalSandboxId: dimensionsRecord.data.externalSandboxId }
            : {}),
          leaseId: dimensionsRecord.data.id,
          ...(dimensionsRecord.data.poolKey ? { poolKey: dimensionsRecord.data.poolKey } : {}),
          provider: dimensionsRecord.data.provider,
          ...(dimensionsRecord.data.region ? { region: dimensionsRecord.data.region } : {}),
          segmentEndedAt,
          segmentStartedAt,
        },
        environmentId: record.data.environmentId,
        id,
        idempotencyKey: `${record.data.id}:${metric}:v${record.data.version}`,
        metric,
        occurredAt,
        organizationId: record.data.organizationId,
        ...(record.data.observability ? { observability: record.data.observability } : {}),
        projectId: record.data.projectId,
        quantity,
        ...(record.data.runId ? { runId: record.data.runId } : {}),
        source: sourceFor(dimensionsRecord),
        unit,
        ...(record.data.workspaceId ? { workspaceId: record.data.workspaceId } : {}),
      },
      itemType: "meter-event" as const,
    }),
  ).pipe(
    Effect.flatMap((decoded) =>
      decoded.itemType === "meter-event"
        ? Effect.succeed(decoded)
        : Effect.fail(
            new SandboxRecordError({
              cause: decoded,
              message: "Expected a meter event record.",
            }),
          ),
    ),
  );
}

export function usageRecords(
  previous: SandboxLeaseRecordValue,
  record: SandboxLeaseRecordValue,
  completedAt: number,
  ids: IdGeneratorService,
  costPolicy: SandboxUsageCostPolicy | undefined,
  activeSegmentStartedAt?: string,
  usageReservation?: {
    readonly reservedMemoryMiB?: number;
    readonly reservedVcpu?: number;
  },
  usageDimensionsRecord: SandboxLeaseRecordValue = previous,
) {
  const computeUsageActive =
    activeSegmentStartedAt !== undefined ||
    previous.data.computeUsageActive ||
    previous.data.usagePendingThrough !== undefined;
  const requestedSegmentStartedAt =
    activeSegmentStartedAt ??
    (computeUsageActive
      ? (previous.data.usageAccountedThrough ?? previous.data.usageStartedAt)
      : timestamp(completedAt));
  const authoritativeLeaseExpiresAt = record.data.leaseExpiresAt ?? previous.data.leaseExpiresAt;
  const leaseExpiresAt = authoritativeLeaseExpiresAt
    ? Date.parse(authoritativeLeaseExpiresAt)
    : undefined;
  const pendingThrough = previous.data.usagePendingThrough
    ? Date.parse(previous.data.usagePendingThrough)
    : undefined;
  const segmentEndedAtMs = Math.min(
    completedAt,
    leaseExpiresAt ?? completedAt,
    pendingThrough ?? completedAt,
  );
  const segmentStartedAtMs = computeUsageActive
    ? Math.min(Date.parse(requestedSegmentStartedAt), segmentEndedAtMs)
    : segmentEndedAtMs;
  const segmentStartedAt = timestamp(segmentStartedAtMs);
  const segmentEndedAt = timestamp(segmentEndedAtMs);
  const durationMs = computeUsageActive
    ? Math.max(0, Math.round(segmentEndedAtMs - segmentStartedAtMs))
    : 0;
  const reservedVcpu =
    usageReservation?.reservedVcpu ?? previous.data.reservedVcpu ?? DEFAULT_SANDBOX_RESERVED_VCPU;
  const reservedMemoryMiB =
    usageReservation?.reservedMemoryMiB ??
    previous.data.reservedMemoryMiB ??
    DEFAULT_SANDBOX_RESERVED_MEMORY_MIB;
  const vcpuMs = meteredQuantity(durationMs * reservedVcpu, "vCPU usage");
  const memoryMiBMs = meteredQuantity(durationMs * reservedMemoryMiB, "memory usage");
  const occurredAt = timestamp(completedAt);
  const metrics = [
    {
      cost: usageCost(durationMs, costPolicy?.baseHourUsdMicros, MS_PER_HOUR),
      metric: "sandbox_ms",
      quantity: durationMs,
      unit: "ms",
    },
    {
      cost: usageCost(vcpuMs, costPolicy?.vcpuHourUsdMicros, MS_PER_HOUR),
      metric: "sandbox_vcpu_ms",
      quantity: vcpuMs,
      unit: "vcpu-ms",
    },
    {
      cost: usageCost(memoryMiBMs, costPolicy?.memoryGiBHourUsdMicros, MIB_PER_GIB * MS_PER_HOUR),
      metric: "sandbox_memory_mib_ms",
      quantity: memoryMiBMs,
      unit: "MiB-ms",
    },
  ] as const;
  return Effect.forEach(metrics, (metric) =>
    generateId(ids).pipe(
      Effect.flatMap((id) =>
        meterEvent(
          record,
          usageDimensionsRecord,
          id,
          metric.metric,
          metric.quantity,
          metric.unit,
          segmentStartedAt,
          segmentEndedAt,
          occurredAt,
          metric.cost,
        ),
      ),
    ),
  );
}
