import "@tanstack/react-start/server-only";
import {
  metricWindow,
  RANGE_INTERVALS,
  type MetricRange,
  type MetricWindow,
} from "../observability/range.ts";
import type { TraceSummary } from "../observability/traces.ts";
import type { EnvironmentScope } from "../scope.ts";
import { requirePublicIds } from "./console-data.ts";
import { createHotPlaneQueue, type HotPlaneCall } from "./hot-plane-queue.ts";
import type { RouteResponse } from "./platform-api.ts";

/** The hot plane keeps only the busiest groups of a grouped series (`api-metrics.ts`). */
export const METRIC_GROUP_LIMIT = 20;
/** Recent runs and recent errors on the agent overview each show this many traces. */
const RECENT_TRACES = 10;
const TRACE_PAGE_LIMIT = 100;
/**
 * Trace pages read to total the groups a grouped series leaves out. Those groups each have fewer
 * traces than the series' quietest group, so a few pages usually cover them; past this cap
 * (2,000 traces) the left-out groups stay unknown rather than undercounted.
 */
const MAX_TOTALS_PAGES = 20;

type MetricPoint = RouteResponse<"getObservabilityMetrics">["items"][number];

/**
 * A p95 duration. Percentiles do not combine across buckets, so from a metrics series it is the
 * highest daily p95 in the window; totalled from traces it is the window's exact p95.
 */
interface DurationP95 {
  readonly basis: "daily-peak" | "traces";
  readonly ms: number;
}

/** Window totals of one agent, deployment, or release. */
export interface GroupTotals {
  readonly costUsdMicros: number;
  readonly errors: number;
  readonly p95?: DurationP95;
  readonly tokens: number;
  readonly traces: number;
}

/**
 * Totals per group value. When `complete`, a group missing from `groups` had no traces in the
 * window; otherwise it ranked below the series' group limit and its totals are unknown.
 */
export interface GroupedTotals {
  readonly complete: boolean;
  readonly groups: Readonly<Record<string, GroupTotals>>;
}

export interface AgentListMetrics {
  readonly totals: GroupedTotals;
  readonly window: MetricWindow;
}

/** The agent overview: KPIs, release totals for running canaries, and recent traces. */
export interface AgentOverview {
  readonly agent: GroupedTotals;
  readonly errors: readonly TraceSummary[];
  /** Totals of the agent's releases; empty when no canary is running. */
  readonly releases: GroupedTotals;
  readonly recent: readonly TraceSummary[];
  readonly window: MetricWindow;
}

/**
 * Sums a grouped trace series per group value. `wanted` keeps only those groups (the rest of the
 * response still counts toward `complete`). Facts lacking the dimension are not a group here.
 */
export function groupTotals(
  items: readonly MetricPoint[],
  wanted?: ReadonlySet<string>,
): GroupedTotals {
  const seen = new Set<string | null>();
  const groups: Record<string, GroupTotals> = {};
  for (const point of items) {
    if (!("trace_count" in point)) continue;
    const groupValue = point.group_value ?? null;
    seen.add(groupValue);
    if (groupValue === null || (wanted && !wanted.has(groupValue))) continue;
    const current = groups[groupValue];
    const bucketP95 = point.p95_duration_ms;
    const peak =
      bucketP95 === undefined ? current?.p95?.ms : Math.max(bucketP95, current?.p95?.ms ?? 0);
    groups[groupValue] = {
      costUsdMicros: (current?.costUsdMicros ?? 0) + point.total_cost_usd_micros,
      errors: (current?.errors ?? 0) + point.error_count,
      tokens: (current?.tokens ?? 0) + point.total_tokens,
      traces: (current?.traces ?? 0) + point.trace_count,
      ...(peak === undefined ? {} : { p95: { basis: "daily-peak", ms: peak } }),
    };
  }
  return { complete: seen.size < METRIC_GROUP_LIMIT, groups };
}

/** The 95th percentile with linear interpolation between closest ranks. */
function percentile95(sorted: readonly number[]) {
  const position = (sorted.length - 1) * 0.95;
  const lower = Math.floor(position);
  const low = sorted[lower]!;
  const high = sorted[Math.min(lower + 1, sorted.length - 1)]!;
  return low + (high - low) * (position - lower);
}

/** Totals per group of a complete set of traces; traces without a group value are skipped. */
export function summarizeTraces(
  traces: readonly TraceSummary[],
  groupOf: (trace: TraceSummary) => string | undefined,
): Record<string, GroupTotals> {
  const grouped = Map.groupBy(
    traces.filter((trace) => groupOf(trace) !== undefined),
    (trace) => groupOf(trace)!,
  );
  const groups: Record<string, GroupTotals> = {};
  for (const [groupValue, members] of grouped) {
    const durations = members
      .flatMap((trace) => (trace.duration_ms === undefined ? [] : [trace.duration_ms]))
      .toSorted((left, right) => left - right);
    let costUsdMicros = 0;
    let tokens = 0;
    for (const trace of members) {
      costUsdMicros += trace.total_cost_usd_micros ?? 0;
      tokens += trace.total_tokens ?? 0;
    }
    groups[groupValue] = {
      costUsdMicros,
      errors: members.filter((trace) => trace.status === "error").length,
      tokens,
      traces: members.length,
      ...(durations.length === 0 ? {} : { p95: { basis: "traces", ms: percentile95(durations) } }),
    };
  }
  return groups;
}

/**
 * Completes a truncated series with totals from every trace in the window. Groups present in the
 * series keep the series' figures; the traces fill in the groups it left out.
 */
export function completeTotals(
  series: GroupedTotals,
  fromTraces: Readonly<Record<string, GroupTotals>>,
): GroupedTotals {
  return { complete: true, groups: { ...fromTraces, ...series.groups } };
}

/**
 * Every trace in the window matching `filter`, newest first, or `undefined` when there are more
 * than MAX_TOTALS_PAGES pages. Later pages send only the cursor, which binds the window and filter.
 */
export async function readTraces(
  hotPlane: HotPlaneCall,
  scope: EnvironmentScope,
  window: MetricWindow,
  filter: { readonly agentDefinitionId?: string },
): Promise<TraceSummary[] | undefined> {
  let page = await hotPlane("listObservabilityTraces", {
    query: { ...filter, from: window.from, limit: TRACE_PAGE_LIMIT, to: window.to },
    scope,
  });
  const traces = [...page.items];
  for (let pages = 1; page.nextCursor; pages += 1) {
    if (pages === MAX_TOTALS_PAGES) return undefined;
    page = await hotPlane("listObservabilityTraces", {
      query: { cursor: page.nextCursor, limit: TRACE_PAGE_LIMIT },
      scope,
    });
    traces.push(...page.items);
  }
  return traces;
}

/**
 * The range's window, bucketed daily: grouped queries stay small, and only window totals and the
 * daily p95 peak are shown, so finer buckets would add rows without adding information.
 */
function totalsQuery(range: MetricRange) {
  const window = metricWindow({ interval: RANGE_INTERVALS[range][0]!, range }, new Date());
  return { query: { from: window.from, interval: "day" as const, to: window.to }, window };
}

/**
 * Runs, errors, and cost per agent definition over the range, for the agents list. The grouped
 * series covers only the busiest agents; when it is truncated, the window's traces total the rest.
 */
export async function loadAgentListMetrics(
  accessToken: string,
  scope: EnvironmentScope,
  range: MetricRange,
): Promise<AgentListMetrics> {
  requirePublicIds({ ...scope });
  const { query, window } = totalsQuery(range);
  const hotPlane = createHotPlaneQueue(accessToken);
  const series = groupTotals(
    (
      await hotPlane("getObservabilityMetrics", {
        query: { ...query, groupBy: "agentDefinitionId" },
        scope,
      })
    ).items,
  );
  if (series.complete) return { totals: series, window };
  const traces = await readTraces(hotPlane, scope, window, {});
  return {
    totals: traces
      ? completeTotals(
          series,
          summarizeTraces(traces, (trace) => trace.agent_definition_id),
        )
      : series,
    window,
  };
}

/**
 * One agent's overview over the range: its group of the per-definition series, the canary
 * releases' groups of the per-release series (skipped when no canary runs), and its latest
 * traces and failed traces. When the agent or a canary release ranks below the series' group
 * limit, the agent's traces in the window total both instead. Queries share one hot-plane queue.
 */
export async function loadAgentOverview(
  accessToken: string,
  scope: EnvironmentScope,
  definitionId: string,
  range: MetricRange,
  canaryReleaseIds: readonly string[],
): Promise<AgentOverview> {
  requirePublicIds({ ...scope, definitionId });
  const { query, window } = totalsQuery(range);
  const hotPlane = createHotPlaneQueue(accessToken);
  const recentQuery = { agentDefinitionId: definitionId, from: query.from, limit: RECENT_TRACES };
  const [byDefinition, byRelease, recent, errors] = await Promise.all([
    hotPlane("getObservabilityMetrics", {
      query: { ...query, groupBy: "agentDefinitionId" },
      scope,
    }),
    canaryReleaseIds.length === 0
      ? undefined
      : hotPlane("getObservabilityMetrics", {
          query: { ...query, groupBy: "agentReleaseId" },
          scope,
        }),
    hotPlane("listObservabilityTraces", { query: { ...recentQuery, to: query.to }, scope }),
    hotPlane("listObservabilityTraces", {
      query: { ...recentQuery, status: "error", to: query.to },
      scope,
    }),
  ]);
  const agent = groupTotals(byDefinition.items, new Set([definitionId]));
  const releases = byRelease
    ? groupTotals(byRelease.items, new Set(canaryReleaseIds))
    : { complete: true, groups: {} };
  const unknown = (totals: GroupedTotals, id: string) => !totals.complete && !totals.groups[id];
  const traces =
    unknown(agent, definitionId) || canaryReleaseIds.some((id) => unknown(releases, id))
      ? await readTraces(hotPlane, scope, window, { agentDefinitionId: definitionId })
      : undefined;
  return {
    agent: traces
      ? completeTotals(
          agent,
          summarizeTraces(traces, (trace) => trace.agent_definition_id),
        )
      : agent,
    errors: errors.items,
    recent: recent.items,
    releases: traces
      ? completeTotals(
          releases,
          summarizeTraces(traces, (trace) => trace.agent_release_id),
        )
      : releases,
    window,
  };
}
