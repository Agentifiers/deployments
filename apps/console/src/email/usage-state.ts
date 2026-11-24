import { oneOf } from "../observability/range.ts";

/** The runtime refuses usage ranges longer than 31 days, so the longest preset is 30. */
export const USAGE_RANGES = ["24h", "7d", "30d"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

const RANGE_HOURS: Readonly<Record<UsageRange, number>> = { "24h": 24, "30d": 720, "7d": 168 };

export const USAGE_BUCKETS = ["hour", "day", "month"] as const;
export type UsageBucket = (typeof USAGE_BUCKETS)[number];

export const USAGE_FORMATS = ["csv", "json"] as const;
export type UsageFormat = (typeof USAGE_FORMATS)[number];

export interface UsageSearch {
  readonly inbox?: string;
  readonly range?: UsageRange;
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

export function parseUsageSearch(search: Readonly<Record<string, unknown>>): UsageSearch {
  const range = oneOf(USAGE_RANGES, search.range);
  const { inbox } = search;
  return {
    ...(typeof inbox === "string" && ULID.test(inbox) ? { inbox } : {}),
    ...(range === undefined || range === "30d" ? {} : { range }),
  };
}

export function usageWindow(
  range: UsageRange,
  now: Date,
): { readonly from: string; readonly to: string } {
  return {
    from: new Date(now.getTime() - RANGE_HOURS[range] * 3_600_000).toISOString(),
    to: now.toISOString(),
  };
}
