import { DAY_MS, type MetricWindow } from "../observability/range.ts";
import type {
  GroupedMetrics,
  MetricGroup,
  TraceBucket,
  TraceGroupTotals,
  TraceTotals,
} from "../observability/series.ts";
import type { TraceSummary } from "../observability/traces.ts";

const HOUR_MS = 3_600_000;

/** Grouped series keep this many groups, busiest first (`apps/observability-hot-plane`). */
export const METRIC_GROUP_LIMIT = 20;

/**
 * Where the agent stands in the per-definition series: `found`; `absent` when the series held
 * every group, so the agent finished no traces; `unranked` when the series was cut at the group
 * limit and the agent may only rank below it.
 */
export type AgentUsageStatus = "absent" | "found" | "unranked";

/** Tokens and cost of the deployments in the per-deployment series, attributed groups only. */
export interface DeploymentSeries {
  readonly complete: boolean;
  readonly costUsdMicros: readonly (readonly number[])[];
  readonly groups: readonly MetricGroup<TraceGroupTotals>[];
  readonly tokens: readonly (readonly number[])[];
}

/**
 * One agent's usage over a window. `basis: "metrics"` reads the hot plane's grouped series (the
 * agent ranks among its busiest groups); `basis: "traces"` totals the agent's own traces because
 * it does not. `truncated`: the agent had more traces than the trace list is read for, so its
 * figures are unknown rather than undercounted.
 */
export interface AgentUsage {
  readonly basis: "metrics" | "traces";
  readonly deployments: DeploymentSeries;
  readonly rows: readonly TraceBucket[];
  readonly status: "absent" | "found" | "truncated";
  readonly totals: TraceTotals;
  readonly window: MetricWindow;
}

const NO_TRACES: TraceTotals = { costUsdMicros: 0, errors: 0, tokens: 0, traces: 0 };

/**
 * Traces as per-bucket trace rows per group (`groupOf`), zero-filled over the window's buckets.
 * A trace counts in the bucket of its start; traces outside the window or without a group are
 * skipped.
 */
export function bucketTraces(
  traces: readonly TraceSummary[],
  window: MetricWindow,
  buckets: readonly string[],
  groupOf: (trace: TraceSummary) => string | undefined,
): Map<string, TraceBucket[]> {
  const start = Date.parse(window.from);
  const width = window.interval === "day" ? DAY_MS : HOUR_MS;
  const groups = new Map<string, TraceBucket[]>();
  for (const trace of traces) {
    const group = groupOf(trace);
    const index = Math.floor((Date.parse(trace.occurred_at) - start) / width);
    if (group === undefined || !(index >= 0 && index < buckets.length)) continue;
    let rows = groups.get(group);
    if (!rows) {
      rows = buckets.map((bucket) => ({ bucket, ...NO_TRACES }));
      groups.set(group, rows);
    }
    const row = rows[index]!;
    rows[index] = {
      bucket: row.bucket,
      costUsdMicros: row.costUsdMicros + (trace.total_cost_usd_micros ?? 0),
      errors: row.errors + (trace.status === "error" ? 1 : 0),
      tokens: row.tokens + (trace.total_tokens ?? 0),
      traces: row.traces + 1,
    };
  }
  return groups;
}

/** One definition's group of a per-definition series, as ungrouped trace buckets. */
export function agentSeries(
  grouped: GroupedMetrics,
  definitionId: string,
): Pick<AgentUsage, "rows" | "totals"> & { readonly status: AgentUsageStatus } {
  const index =
    grouped.source === "traces"
      ? grouped.groups.findIndex((group) => group.groupValue === definitionId)
      : -1;
  if (grouped.source !== "traces" || index === -1) {
    return {
      rows: grouped.buckets.map((bucket) => ({ bucket, ...NO_TRACES })),
      status: grouped.groups.length < METRIC_GROUP_LIMIT ? "absent" : "unranked",
      totals: NO_TRACES,
    };
  }
  const { costUsdMicros, errors, tokens, traces } = grouped.values;
  const { source: _source, ...totals } = grouped.groups[index]!.totals;
  return {
    rows: grouped.buckets.map((bucket, at) => ({
      bucket,
      costUsdMicros: costUsdMicros[index]?.[at] ?? 0,
      errors: errors[index]?.[at] ?? 0,
      tokens: tokens[index]?.[at] ?? 0,
      traces: traces[index]?.[at] ?? 0,
    })),
    status: "found",
    totals,
  };
}

/** The attributed groups of a per-deployment series with their token and cost values. */
export function deploymentSeries(grouped: GroupedMetrics): DeploymentSeries {
  const complete = grouped.groups.length < METRIC_GROUP_LIMIT;
  if (grouped.source !== "traces") {
    return { complete, costUsdMicros: [], groups: [], tokens: [] };
  }
  const kept = grouped.groups.flatMap((group, index) =>
    group.groupValue === null ? [] : [{ group, index }],
  );
  const zeroFilled = (values: readonly (readonly (number | null)[])[], index: number) =>
    grouped.buckets.map((_, at) => values[index]?.[at] ?? 0);
  return {
    complete,
    costUsdMicros: kept.map(({ index }) => zeroFilled(grouped.values.costUsdMicros, index)),
    groups: kept.map(({ group }) => group),
    tokens: kept.map(({ index }) => zeroFilled(grouped.values.tokens, index)),
  };
}

/** Window totals of one deployment in the agent's split. */
interface SplitTotals {
  readonly costUsdMicros: number;
  readonly tokens: number;
  readonly traces: number;
}

export interface DeploymentSplit {
  readonly costUsdMicros: readonly (readonly number[])[];
  /** The `Other` group has a null `groupValue`, so it charts in the neutral color. */
  readonly groups: readonly MetricGroup<SplitTotals>[];
  readonly tokens: readonly (readonly number[])[];
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/**
 * This agent's share of the per-deployment series: its own deployments, plus an `Other` group
 * for whatever the agent's own series holds beyond them (deployments ranked below the group limit,
 * or traces without deployment attribution). The residual is per bucket and never negative.
 */
export function agentDeploymentSplit(
  usage: Pick<AgentUsage, "deployments" | "rows" | "totals">,
  deploymentIds: ReadonlySet<string>,
  otherLabel: string,
): DeploymentSplit {
  const { deployments } = usage;
  const kept = deployments.groups.flatMap((group, index) =>
    group.groupValue !== null && deploymentIds.has(group.groupValue) ? [{ group, index }] : [],
  );
  const groups: MetricGroup<SplitTotals>[] = kept.map(({ group }) => ({
    ...group,
    totals: {
      costUsdMicros: group.totals.costUsdMicros,
      tokens: group.totals.tokens,
      traces: group.totals.traces,
    },
  }));
  const tokens = kept.map(({ index }) => deployments.tokens[index]!);
  const costUsdMicros = kept.map(({ index }) => deployments.costUsdMicros[index]!);
  const residual = (read: (row: TraceBucket) => number, values: readonly (readonly number[])[]) =>
    usage.rows.map((row, bucket) =>
      Math.max(0, read(row) - sum(values.map((series) => series[bucket] ?? 0))),
    );
  const otherTokens = residual((row) => row.tokens, tokens);
  const otherCost = residual((row) => row.costUsdMicros, costUsdMicros);
  if (otherTokens.some((value) => value > 0) || otherCost.some((value) => value > 0)) {
    groups.push({
      groupValue: null,
      key: "other",
      label: otherLabel,
      totals: {
        costUsdMicros: sum(otherCost),
        tokens: sum(otherTokens),
        traces: Math.max(0, usage.totals.traces - sum(groups.map((group) => group.totals.traces))),
      },
    });
    tokens.push(otherTokens);
    costUsdMicros.push(otherCost);
  }
  return { costUsdMicros, groups, tokens };
}
