import {
  OBSERVABILITY_METRIC_GROUPS,
  OBSERVABILITY_METRIC_INTERVALS,
} from "@deployments-ai/api-contract/observability";

export type MetricInterval = (typeof OBSERVABILITY_METRIC_INTERVALS)[number];
export type MetricGroupBy = (typeof OBSERVABILITY_METRIC_GROUPS)[number];

/** Look-back presets shared by metrics and the trace list; all fit the API's 31-day window. */
export const METRIC_RANGES = ["24h", "7d", "30d"] as const;
export type MetricRange = (typeof METRIC_RANGES)[number];

const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const RANGE_DAYS: Readonly<Record<MetricRange, number>> = { "24h": 1, "7d": 7, "30d": 30 };
const INTERVAL_MS: Readonly<Record<MetricInterval, number>> = { day: DAY_MS, hour: HOUR_MS };

/**
 * Bucket widths each range may use. The API caps grouped hourly series at 7 days, and the
 * 30-day range stays daily so a chart never draws more than 169 buckets.
 */
export const RANGE_INTERVALS: Readonly<Record<MetricRange, readonly MetricInterval[]>> = {
  "24h": ["hour"],
  "7d": ["hour", "day"],
  "30d": ["day"],
};

export const RANGE_LABELS: Readonly<Record<MetricRange, string>> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

export interface MetricSelection {
  readonly groupBy?: MetricGroupBy;
  readonly interval: MetricInterval;
  readonly range: MetricRange;
}

export interface MetricWindow {
  readonly from: string;
  readonly interval: MetricInterval;
  readonly to: string;
}

/** The value when it is one of `values`; narrows untrusted search parameters to a literal. */
export function oneOf<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): Values[number] | undefined {
  return values.find((candidate) => candidate === value);
}

/**
 * Reads the metric selection from untrusted URL search parameters. Unknown values fall back to
 * the 24-hour hourly default; an interval the range cannot use falls back to the range's first.
 */
export function parseMetricSelection(search: Readonly<Record<string, unknown>>): MetricSelection {
  const range = oneOf(METRIC_RANGES, search.range) ?? "24h";
  const allowed = RANGE_INTERVALS[range];
  const interval = oneOf(allowed, search.interval) ?? allowed[0]!;
  const groupBy = oneOf(OBSERVABILITY_METRIC_GROUPS, search.groupBy);
  return { interval, range, ...(groupBy ? { groupBy } : {}) };
}

/**
 * Lead time `to` keeps over `now`. The hot plane rejects a window whose `from` is older than its
 * retention measured at its own clock, and a 30-day window ends exactly at the retention edge, so
 * a request near a bucket boundary would fail after the boundary passes (retries, clock skew).
 */
const BOUNDARY_MARGIN_MS = 2 * 60_000;

/**
 * The `[from, to)` window of a selection, aligned to UTC bucket boundaries: `to` is the start of
 * the bucket after `now`, so the current partial bucket is the last one and every bucket in the
 * window is whole. Within BOUNDARY_MARGIN_MS of that boundary the window moves one bucket later,
 * so `from` stays at least the margin inside the 30-day retention of model-invocation metrics.
 */
export function metricWindow(selection: MetricSelection, now: Date): MetricWindow {
  const width = INTERVAL_MS[selection.interval];
  const to = (Math.floor((now.getTime() + BOUNDARY_MARGIN_MS) / width) + 1) * width;
  const from = to - RANGE_DAYS[selection.range] * DAY_MS;
  return {
    from: new Date(from).toISOString(),
    interval: selection.interval,
    to: new Date(to).toISOString(),
  };
}

/** Start of every bucket in `[from, to)`, as canonical ISO timestamps. */
export function bucketStarts(window: MetricWindow): string[] {
  const width = INTERVAL_MS[window.interval];
  const end = Date.parse(window.to);
  const starts: string[] = [];
  for (let start = Date.parse(window.from); start < end; start += width) {
    starts.push(new Date(start).toISOString());
  }
  return starts;
}
