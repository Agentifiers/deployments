import {
  oneOf,
  parseMetricSelection,
  type MetricInterval,
  type MetricRange,
} from "../observability/range.ts";

/** Breakdown dimensions of the usage screen (plan §5.8): agent, model, provider. */
export const BREAKDOWN_GROUPS = ["agentDefinitionId", "model", "provider"] as const;
export type BreakdownGroupBy = (typeof BREAKDOWN_GROUPS)[number];

/** The period and bucket width shared by the ledger and the analytics breakdowns. */
export interface UsagePeriod {
  readonly interval: MetricInterval;
  readonly range: MetricRange;
}

export interface UsageSelection extends UsagePeriod {
  readonly groupBy: BreakdownGroupBy;
}

/**
 * Reads the usage screen's selection from untrusted URL search parameters. The periods are the
 * observability presets, so ledger totals and analytics breakdowns always cover the same window;
 * the breakdown defaults to agents.
 */
export function parseUsageSelection(search: Readonly<Record<string, unknown>>): UsageSelection {
  const { interval, range } = parseMetricSelection(search);
  return {
    groupBy: oneOf(BREAKDOWN_GROUPS, search.groupBy) ?? "agentDefinitionId",
    interval,
    range,
  };
}
