import type { MetricWindow } from "../observability/range.ts";
import type { RouteResponse } from "../server/platform-api.ts";

/**
 * One series of `GET /v1/usage/summary` or `GET /v1/costs/summary`, which reconcile the ledger's
 * meter events, hourly counters, and rollups server-side. `kind: "cost"` series are in
 * nanodollars and keyed by the metric (or cost source) they price; `part` marks a token split.
 */
type SummarySeries = RouteResponse<"getUsageSummary">["series"][number];

export type TokenPart = NonNullable<SummarySeries["part"]>;
/** Token splits of `model_tokens` in display order. */
export const TOKEN_PARTS = [
  "input",
  "output",
  "cached",
  "cache-write",
] as const satisfies readonly TokenPart[];

/** A summary series and the stable id charts and tables key it by. */
export interface LedgerSeries extends SummarySeries {
  readonly id: string;
}

export interface LedgerUsage {
  readonly buckets: readonly string[];
  readonly series: readonly LedgerSeries[];
}

/** The ledger over one period. */
export interface LedgerView {
  /** Whether cost series were read; callers without `spend:read` see usage only. */
  readonly costs: boolean;
  readonly usage: LedgerUsage;
  readonly window: MetricWindow;
}
