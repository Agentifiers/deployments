import {
  AttributedUsageCounterShardRecord,
  usagePersistence,
  withCanonicalRecordKeys,
  type AttributionTarget,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { addCounterQuantity } from "./counter-quantity.ts";

type MeterEvent = Extract<PlatformRecord, { readonly itemType: "meter-event" }>;
export type AttributedUsageCounter = Extract<
  PlatformRecord,
  { readonly itemType: "attributed-usage-counter-shard" }
>;

/** Token splits a `tokens` meter event records as dimensions, by the part name counters keep. */
const TOKEN_PART_DIMENSIONS = {
  "cache-write": "cacheWriteInputTokens",
  cached: "cachedInputTokens",
  input: "inputTokens",
  output: "outputTokens",
} as const;

/** The token splits of a `tokens` meter event, or undefined when it records none. */
export function meterEventTokenParts(
  event: MeterEvent,
): Readonly<Record<string, number>> | undefined {
  if (event.data.unit !== "tokens") return undefined;
  const parts: Record<string, number> = {};
  for (const [part, field] of Object.entries(TOKEN_PART_DIMENSIONS)) {
    const value = event.data.dimensions[field];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
      throw new Error(`Meter event ${field} must be a non-negative safe integer.`);
    }
    parts[part] = Number(value);
  }
  return Object.keys(parts).length === 0 ? undefined : parts;
}

/** One counter an attributed meter event advances: its quantity or one of its costs. */
export interface AttributedCounterIncrement {
  readonly metric: string;
  readonly parts?: Readonly<Record<string, number>>;
  readonly quantity: number;
  readonly target: AttributionTarget;
  readonly unit: string;
}

function addParts(
  previous: Readonly<Record<string, number>> | undefined,
  increment: Readonly<Record<string, number>> | undefined,
  metric: string,
) {
  if (!increment) return previous;
  const parts: Record<string, number> = { ...previous };
  for (const [part, value] of Object.entries(increment)) {
    parts[part] = addCounterQuantity(parts[part] ?? 0, value, `${metric} ${part}`);
  }
  return parts;
}

/** The target's counter shard after `increment`; without `previous`, the candidate to load. */
export function attributedCounterRecord(input: {
  readonly bucket: string;
  readonly event: MeterEvent;
  readonly increment: AttributedCounterIncrement;
  readonly previous?: AttributedUsageCounter;
  readonly shard: number;
  readonly updatedAt: string;
}): AttributedUsageCounter {
  const { increment, previous } = input;
  const parts = addParts(previous?.data.parts, increment.parts, increment.metric);
  return Schema.decodeUnknownSync(AttributedUsageCounterShardRecord)(
    withCanonicalRecordKeys({
      data: {
        attribution: increment.target.attribution,
        attributionId: increment.target.attributionId,
        bucket: input.bucket,
        environmentId: input.event.data.environmentId,
        metric: increment.metric,
        organizationId: input.event.data.organizationId,
        ...(parts ? { parts } : {}),
        projectId: input.event.data.projectId,
        quantity: addCounterQuantity(
          previous?.data.quantity ?? 0,
          increment.quantity,
          increment.metric,
        ),
        shard: input.shard,
        unit: increment.unit,
        updatedAt: input.updatedAt,
        version: (previous?.data.version ?? -1) + 1,
      },
      itemType: "attributed-usage-counter-shard" as const,
    }),
  );
}

export async function loadAttributedCounter(
  database: DynamoDatabaseService,
  candidate: AttributedUsageCounter,
) {
  const value = await usagePersistence.read(
    database,
    "usage",
    { pk: candidate.pk, sk: candidate.sk },
    true,
  );
  if (!value) return undefined;
  if (value.itemType !== "attributed-usage-counter-shard") {
    throw new Error("Attributed usage counter key resolved to an unexpected record.");
  }
  return value;
}
