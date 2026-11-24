import { CanonicalKeyError, requiredField, type KeyableRecord } from "./record-key-fields.ts";
import type { Attribution } from "./records/usage.ts";

/** What one attributed usage counter counts: the events attributed to `attributionId`. */
export interface AttributionTarget {
  readonly attribution: Attribution;
  readonly attributionId: string;
}

/** The sort-key segment of each attribution's counters. */
const ATTRIBUTION_KEY_LABELS = {
  agent: "AGENT",
  workspace: "WORKSPACE",
} as const satisfies Record<Attribution, string>;

/**
 * The sort-key parts between `ATTRIBUTED-USAGE-COUNTER-SHARD` and the metric: the attribution's
 * label and id. One target's counters are therefore one contiguous range per metric.
 */
export function attributedCounterKeyParts(target: AttributionTarget) {
  return [ATTRIBUTION_KEY_LABELS[target.attribution], target.attributionId] as const;
}

/** The attribution parts of a stored counter. Keys derive before the record schema runs. */
export function attributedCounterRecordKeyParts(record: KeyableRecord) {
  const attribution = requiredField(record, "attribution");
  if (!Object.hasOwn(ATTRIBUTION_KEY_LABELS, attribution)) {
    throw new CanonicalKeyError({
      field: "attribution",
      itemType: record.itemType,
      message: `Record ${record.itemType} names unknown attribution ${attribution}.`,
    });
  }
  return attributedCounterKeyParts({
    attribution: attribution as Attribution,
    attributionId: requiredField(record, "attributionId"),
  });
}
