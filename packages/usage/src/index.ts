import {
  DeliveryDeduplicationRecord,
  IdempotencyRecord,
  UsageCounterShardRecord,
  addScopeSpend,
  meterEventFunding,
  scopeSpendShardCandidates,
  withCanonicalRecordKeys,
  type AttributionTarget,
  type DynamoDatabaseService,
  type PlatformRecord,
  type ScopeSpendShard,
  usagePersistence,
  usageScopeOf,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import {
  attributedCounterRecord,
  loadAttributedCounter,
  meterEventTokenParts,
  type AttributedCounterIncrement,
  type AttributedUsageCounter,
} from "./attributed-counters.ts";
import { addCounterQuantity } from "./counter-quantity.ts";

export type MeterEvent = Extract<PlatformRecord, { readonly itemType: "meter-event" }>;
type UsageCounter = Extract<PlatformRecord, { readonly itemType: "usage-counter-shard" }>;
type UsageUnitGuard = Extract<PlatformRecord, { readonly itemType: "idempotency" }>;

export interface MaterializeMeterEventResult {
  /**
   * The attributed counters the event advanced: its run's agent definition's and its
   * workspace's, for each it has.
   */
  readonly attributedShards: readonly AttributedUsageCounter[];
  readonly bucket: string;
  readonly duplicate: boolean;
  readonly shards: readonly UsageCounter[];
  /** Spend shards of every level of the event's scope chain, advanced for budget periods. */
  readonly spendShards: readonly ScopeSpendShard[];
}

const CONSUMER = "usage-counter-v1";
const SHARD_COUNT = 16;
const MAX_ATTEMPTS = 8;
const DEDUP_EXPIRES_AT = "9999-12-31T23:59:59.999Z";
const COST_METRIC_SUFFIX = ".cost_usd_micros";
const EXACT_COST_METRIC_SUFFIX = ".cost_usd_nanodollars";
const COST_DIMENSIONS = [
  { field: "costUsdMicros", suffix: COST_METRIC_SUFFIX, unit: "usd_micros" },
  {
    field: "costUsdNanoDollars",
    suffix: EXACT_COST_METRIC_SUFFIX,
    unit: "usd_nanodollars",
  },
] as const;

export function usageHourBucket(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("Meter event occurredAt is invalid.");
  const date = new Date(timestamp);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function shard(event: MeterEvent) {
  return createHash("sha256").update(event.data.id).digest()[0]! % SHARD_COUNT;
}

function canonicalHashValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalHashValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalHashValue(entry)]),
  );
}

function counterRecord(input: {
  readonly bucket: string;
  readonly event: MeterEvent;
  readonly metric: string;
  readonly previous?: UsageCounter;
  readonly quantity: number;
  readonly shard: number;
  readonly unit: string;
  readonly updatedAt: string;
}) {
  const quantity = addCounterQuantity(
    input.previous?.data.quantity ?? 0,
    input.quantity,
    input.metric,
  );
  return Schema.decodeUnknownSync(UsageCounterShardRecord)(
    withCanonicalRecordKeys({
      data: {
        bucket: input.bucket,
        environmentId: input.event.data.environmentId,
        metric: input.metric,
        organizationId: input.event.data.organizationId,
        projectId: input.event.data.projectId,
        quantity,
        shard: input.shard,
        unit: input.unit,
        updatedAt: input.updatedAt,
        version: (input.previous?.data.version ?? -1) + 1,
      },
      itemType: "usage-counter-shard" as const,
    }),
  );
}

function dedupRecord(event: MeterEvent, deliveredAt: string) {
  return Schema.decodeUnknownSync(DeliveryDeduplicationRecord)(
    withCanonicalRecordKeys({
      data: {
        consumer: CONSUMER,
        deliveredAt,
        eventId: event.data.id,
        expiresAt: DEDUP_EXPIRES_AT,
        resultHash: createHash("sha256")
          .update(JSON.stringify(canonicalHashValue(event.data)))
          .digest("hex"),
      },
      itemType: "delivery-deduplication" as const,
      ttl: Math.floor(Date.parse(DEDUP_EXPIRES_AT) / 1_000),
    }),
  );
}

function unitGuardRecord(
  event: MeterEvent,
  bucket: string,
  metric: string,
  unit: string,
  createdAt: string,
) {
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        CONSUMER,
        event.data.organizationId,
        event.data.projectId,
        event.data.environmentId,
        bucket,
        metric,
      ]),
    )
    .digest("hex");
  return Schema.decodeUnknownSync(IdempotencyRecord)(
    withCanonicalRecordKeys({
      data: {
        commandHash: createHash("sha256").update(unit).digest("hex"),
        createdAt,
        expiresAt: DEDUP_EXPIRES_AT,
        idempotencyKey: `${CONSUMER}:unit:${identity}`,
        organizationId: event.data.organizationId,
        resourceIds: [],
        response: {
          bucket,
          environmentId: event.data.environmentId,
          metric,
          projectId: event.data.projectId,
          unit,
        },
        status: "completed" as const,
        version: 0,
      },
      itemType: "idempotency" as const,
      ttl: Math.floor(Date.parse(DEDUP_EXPIRES_AT) / 1_000),
    }),
  );
}

async function loadCounter(database: DynamoDatabaseService, candidate: UsageCounter) {
  const value = await usagePersistence.read(
    database,
    "usage",
    { pk: candidate.pk, sk: candidate.sk },
    true,
  );
  if (!value) return undefined;
  if (value.itemType !== "usage-counter-shard") {
    throw new Error("Usage counter key resolved to an unexpected record.");
  }
  return value;
}

async function loadUnitGuard(database: DynamoDatabaseService, candidate: UsageUnitGuard) {
  const value = await usagePersistence.read(
    database,
    "events",
    { pk: candidate.pk, sk: candidate.sk },
    true,
  );
  if (!value) return undefined;
  if (value.itemType !== "idempotency") {
    throw new Error("Usage unit guard key resolved to an unexpected record.");
  }
  return value;
}

async function isDuplicate(database: DynamoDatabaseService, event: MeterEvent) {
  const candidate = dedupRecord(event, event.data.occurredAt);
  const value = await usagePersistence.read(
    database,
    "events",
    { pk: candidate.pk, sk: candidate.sk },
    true,
  );
  if (!value) return false;
  if (value.itemType !== "delivery-deduplication") {
    throw new Error("Usage deduplication key resolved to an unexpected record.");
  }
  if (value.data.resultHash !== candidate.data.resultHash) {
    throw new Error("Meter event identity was reused with different content.");
  }
  return true;
}

function assertCounterUnit(
  counter: UsageCounter | AttributedUsageCounter | undefined,
  unit: string,
  metric: string,
) {
  if (counter && counter.data.unit !== unit) {
    throw new Error(
      `Usage counter ${metric} cannot aggregate ${unit} into existing ${counter.data.unit} values.`,
    );
  }
}

function assertUnitGuard(guard: UsageUnitGuard | undefined, candidate: UsageUnitGuard) {
  if (!guard || guard.data.commandHash === candidate.data.commandHash) return;
  const existingUnit = guard.data.response?.unit;
  const candidateMetric = candidate.data.response?.metric;
  const candidateUnit = candidate.data.response?.unit;
  throw new Error(
    `Usage counter ${typeof candidateMetric === "string" ? candidateMetric : "unknown"} cannot aggregate ${typeof candidateUnit === "string" ? candidateUnit : "unknown"} into existing ${typeof existingUnit === "string" ? existingUnit : "incompatible"} values.`,
  );
}

function costQuantities(event: MeterEvent) {
  return COST_DIMENSIONS.flatMap(({ field, suffix, unit }) => {
    const value = event.data.dimensions[field];
    if (value === undefined) return [];
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
      throw new Error(`Meter event ${field} must be a non-negative safe integer.`);
    }
    return [{ quantity: Number(value), suffix, unit }];
  });
}

/**
 * USD micros a meter event adds to budget spend: the ledger's `costUsdMicros`, else its exact
 * `costUsdNanoDollars` rounded to the nearest micro.
 */
export function meterEventSpendUsdMicros(event: MeterEvent): number {
  const costs = costQuantities(event);
  const micros = costs.find(({ unit }) => unit === "usd_micros")?.quantity;
  if (micros !== undefined) return micros;
  const nanoDollars = costs.find(({ unit }) => unit === "usd_nanodollars")?.quantity;
  return nanoDollars === undefined ? 0 : Math.round(nanoDollars / 1_000);
}

async function loadScopeSpend(database: DynamoDatabaseService, candidate: ScopeSpendShard) {
  const value = await usagePersistence.read(
    database,
    "usage",
    { pk: candidate.pk, sk: candidate.sk },
    true,
  );
  if (!value) return undefined;
  if (value.itemType !== "scope-spend-shard") {
    throw new Error("Scope spend key resolved to an unexpected record.");
  }
  return value;
}

function reservedCostMetricSuffix(metric: string) {
  return COST_DIMENSIONS.find(({ suffix }) => metric.endsWith(suffix))?.suffix;
}

function costMetric(metric: string, suffix: string) {
  return `${metric}${suffix}`;
}

function costCounterCandidates(input: {
  readonly bucket: string;
  readonly event: MeterEvent;
  readonly shard: number;
  readonly updatedAt: string;
}) {
  return costQuantities(input.event).map(({ quantity, suffix, unit }) => ({
    counter: counterRecord({
      ...input,
      metric: costMetric(input.event.data.metric, suffix),
      quantity,
      unit,
    }),
    quantity,
    suffix,
    unit,
  }));
}

function assertCostCounterUnits(
  previous: readonly (UsageCounter | undefined)[],
  candidates: ReturnType<typeof costCounterCandidates>,
  metric: string,
) {
  for (const [index, candidate] of candidates.entries()) {
    assertCounterUnit(previous[index], candidate.unit, costMetric(metric, candidate.suffix));
  }
}

/** The counters an event advances for one attribution: its quantity (with token splits) and costs. */
function attributedIncrements(
  event: MeterEvent,
  target: AttributionTarget,
): readonly AttributedCounterIncrement[] {
  const parts = meterEventTokenParts(event);
  return [
    {
      metric: event.data.metric,
      ...(parts ? { parts } : {}),
      quantity: event.data.quantity,
      target,
      unit: event.data.unit,
    },
    ...costQuantities(event).map(({ quantity, suffix, unit }) => ({
      metric: costMetric(event.data.metric, suffix),
      quantity,
      target,
      unit,
    })),
  ];
}

/**
 * Folds one meter event into its hourly counters and budget spend, exactly once. In the same
 * transaction, the event also advances the counters of each attribution it has: its workspace's
 * when it names one, and with `agentDefinitionId` (the agent its run executed), that agent's.
 */
export async function materializeMeterEvent(
  database: DynamoDatabaseService,
  event: MeterEvent,
  options: { readonly agentDefinitionId?: string; readonly now?: () => Date } = {},
): Promise<MaterializeMeterEventResult> {
  if (
    !Number.isFinite(event.data.quantity) ||
    event.data.quantity < 0 ||
    (Number.isInteger(event.data.quantity) && !Number.isSafeInteger(event.data.quantity))
  ) {
    throw new Error("Meter event quantity must be non-negative and finite.");
  }
  const reservedSuffix = reservedCostMetricSuffix(event.data.metric);
  if (reservedSuffix) {
    throw new Error(`Meter event metric must not use the reserved ${reservedSuffix} suffix.`);
  }
  const bucket = usageHourBucket(event.data.occurredAt);
  const eventShard = shard(event);
  const spendUsdMicros = meterEventSpendUsdMicros(event);
  const funding = meterEventFunding(event.data.dimensions);
  const attributionTargets: readonly AttributionTarget[] = [
    ...(options.agentDefinitionId
      ? [{ attribution: "agent" as const, attributionId: options.agentDefinitionId }]
      : []),
    ...(event.data.workspaceId
      ? [{ attribution: "workspace" as const, attributionId: event.data.workspaceId }]
      : []),
  ];
  const attributedCounterIncrements = attributionTargets.flatMap((target) =>
    attributedIncrements(event, target),
  );
  const scope = usageScopeOf(event.data);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (await isDuplicate(database, event)) {
      return { attributedShards: [], bucket, duplicate: true, shards: [], spendShards: [] };
    }
    const updatedAt = (options.now?.() ?? new Date()).toISOString();
    const spendCandidates =
      spendUsdMicros > 0
        ? scopeSpendShardCandidates({
            occurredAt: event.data.occurredAt,
            scope,
            shard: eventShard,
            updatedAt,
          })
        : [];
    const quantityCandidate = counterRecord({
      bucket,
      event,
      metric: event.data.metric,
      quantity: event.data.quantity,
      shard: eventShard,
      unit: event.data.unit,
      updatedAt,
    });
    const costCandidates = costCounterCandidates({
      bucket,
      event,
      shard: eventShard,
      updatedAt,
    });
    const quantityGuardCandidate = unitGuardRecord(
      event,
      bucket,
      event.data.metric,
      event.data.unit,
      updatedAt,
    );
    const costGuardCandidates = costCandidates.map((candidate) =>
      unitGuardRecord(
        event,
        bucket,
        costMetric(event.data.metric, candidate.suffix),
        candidate.unit,
        updatedAt,
      ),
    );
    const attributedCandidates = attributedCounterIncrements.map((increment) =>
      attributedCounterRecord({
        bucket,
        event,
        increment,
        shard: eventShard,
        updatedAt,
      }),
    );
    const [
      previousQuantity,
      previousCosts,
      quantityGuard,
      costGuards,
      previousSpend,
      previousAttributed,
    ] = await Promise.all([
      loadCounter(database, quantityCandidate),
      Promise.all(costCandidates.map(({ counter }) => loadCounter(database, counter))),
      loadUnitGuard(database, quantityGuardCandidate),
      Promise.all(costGuardCandidates.map((candidate) => loadUnitGuard(database, candidate))),
      Promise.all(spendCandidates.map((candidate) => loadScopeSpend(database, candidate))),
      Promise.all(
        attributedCandidates.map((candidate) => loadAttributedCounter(database, candidate)),
      ),
    ]);
    assertCounterUnit(previousQuantity, event.data.unit, event.data.metric);
    assertCostCounterUnits(previousCosts, costCandidates, event.data.metric);
    for (const [index, increment] of attributedCounterIncrements.entries()) {
      assertCounterUnit(previousAttributed[index], increment.unit, increment.metric);
    }
    assertUnitGuard(quantityGuard, quantityGuardCandidate);
    for (const [index, candidate] of costGuardCandidates.entries()) {
      assertUnitGuard(costGuards[index], candidate);
    }
    const quantity = counterRecord({
      bucket,
      event,
      metric: event.data.metric,
      ...(previousQuantity ? { previous: previousQuantity } : {}),
      quantity: event.data.quantity,
      shard: eventShard,
      unit: event.data.unit,
      updatedAt,
    });
    const costCounters = costCandidates.map((candidate, index) =>
      counterRecord({
        bucket,
        event,
        metric: costMetric(event.data.metric, candidate.suffix),
        ...(previousCosts[index] ? { previous: previousCosts[index] } : {}),
        quantity: candidate.quantity,
        shard: eventShard,
        unit: candidate.unit,
        updatedAt,
      }),
    );
    const counters = [quantity, ...costCounters];
    const previousCounters = [previousQuantity, ...previousCosts];
    const spendShards = spendCandidates.map((candidate, index) =>
      addScopeSpend(candidate, previousSpend[index], spendUsdMicros, funding),
    );
    const attributedCounters = attributedCounterIncrements.map((increment, index) =>
      attributedCounterRecord({
        bucket,
        event,
        increment,
        ...(previousAttributed[index] ? { previous: previousAttributed[index] } : {}),
        shard: eventShard,
        updatedAt,
      }),
    );
    try {
      await usagePersistence.commit(database, [
        ...counters.map((record, index) => ({
          kind: "put" as const,
          ...(previousCounters[index] ? { previousRecord: previousCounters[index] } : {}),
          record,
        })),
        ...(quantityGuard ? [] : [{ kind: "put" as const, record: quantityGuardCandidate }]),
        ...costGuardCandidates.flatMap((candidate, index) =>
          costGuards[index] ? [] : [{ kind: "put" as const, record: candidate }],
        ),
        ...spendShards.map((record, index) => ({
          kind: "put" as const,
          ...(previousSpend[index] ? { previousRecord: previousSpend[index] } : {}),
          record,
        })),
        ...attributedCounters.map((record, index) => ({
          kind: "put" as const,
          ...(previousAttributed[index] ? { previousRecord: previousAttributed[index] } : {}),
          record,
        })),
        { kind: "put", record: dedupRecord(event, updatedAt) },
      ]);
      return {
        attributedShards: attributedCounters,
        bucket,
        duplicate: false,
        shards: counters,
        spendShards,
      };
    } catch (cause) {
      if (await isDuplicate(database, event)) {
        return { attributedShards: [], bucket, duplicate: true, shards: [], spendShards: [] };
      }
      if (attempt === MAX_ATTEMPTS - 1) throw cause;
    }
  }
  throw new Error("Usage materialization retry limit was exhausted.");
}
