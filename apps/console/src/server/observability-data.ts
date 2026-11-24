import "@tanstack/react-start/server-only";
import { Schema } from "effect";
import {
  agentLabels,
  groupLabel,
  UNATTRIBUTED,
  type AgentDirectory,
  type AgentReleaseEntry,
} from "../observability/agent-labels.ts";
import {
  bucketStarts,
  DAY_MS,
  metricWindow,
  RANGE_DAYS,
  type MetricSelection,
  type MetricWindow,
} from "../observability/range.ts";
import {
  groupedMetrics,
  traceBuckets,
  traceTotals,
  type GroupedMetrics,
  type MetricGroup,
  type TraceBucket,
  type TraceGroupTotals,
  type TraceTotals,
} from "../observability/series.ts";
import {
  EXPORT_LIMIT,
  selectExportedTraces,
  type TraceExportSelection,
} from "../observability/trace-export.ts";
import { PlatformApiError } from "../errors.ts";
import type { TraceFilters } from "../observability/trace-filters.ts";
import type { SpanSummary, ToolMetric, TraceSummary } from "../observability/traces.ts";
import type { EnvironmentScope } from "../scope.ts";
import {
  loadAgentDirectory,
  loadDefinitionReleases,
  loadReleaseEntries,
} from "./agent-directory.ts";
import { requirePublicIds } from "./console-data.ts";
import { createHotPlaneQueue } from "./hot-plane-queue.ts";
import { PlatformRequestError } from "./platform-api.ts";

const TRACE_PAGE_LIMIT = 50;
const SPAN_PAGE_LIMIT = 100;
/** A trace detail renders at most this many spans and reports the rest as truncated. */
const MAX_SPANS = 1_000;
const DASHBOARD_TOOLS = 10;
const DASHBOARD_FAILURES = 10;

/**
 * The overview's data. It refreshes every 30 seconds, so it carries IDs only: the client names
 * deployments and agents with the cached agent directory, and `failureReleases` names the
 * failures' releases. `topAgents` labels are the raw deployment IDs until the client names them.
 */
export interface EnvironmentDashboard {
  readonly activity: TraceBucket[];
  readonly failureReleases: readonly AgentReleaseEntry[];
  readonly failures: readonly TraceSummary[];
  readonly tools: readonly ToolMetric[];
  readonly topAgents: readonly MetricGroup<TraceGroupTotals>[];
  readonly totals: TraceTotals;
  readonly window: MetricWindow;
}

type MetricSeriesView =
  | {
      readonly buckets: TraceBucket[];
      readonly kind: "ungrouped";
      readonly totals: TraceTotals;
    }
  | { readonly grouped: GroupedMetrics; readonly kind: "grouped" };

export interface MetricsView {
  readonly series: MetricSeriesView;
  readonly tools: readonly ToolMetric[];
  readonly window: MetricWindow;
}

/**
 * One trace-list page. The client names agents with the cached agent directory; `releases` names
 * the releases this page refers to.
 */
export interface TracePage {
  readonly items: readonly TraceSummary[];
  readonly nextCursor?: string;
  readonly releases: readonly AgentReleaseEntry[];
}

export interface TraceDetail {
  readonly releases: readonly AgentReleaseEntry[];
  readonly spans: readonly SpanSummary[];
  readonly spansTruncated: boolean;
  readonly trace: TraceSummary;
}

/** Tool metrics items are untyped in the contract; these are the hot plane's columns. */
const ToolMetricRows = Schema.Array(
  Schema.Struct({
    calls: Schema.Number,
    errors: Schema.Number,
    name: Schema.String,
    p95_duration_ms: Schema.optional(Schema.Number),
  }),
);
const decodeToolMetricRows = Schema.decodeUnknownSync(ToolMetricRows);

function toolMetrics(items: readonly unknown[], limit: number): ToolMetric[] {
  let rows: (typeof ToolMetricRows)["Type"];
  try {
    rows = decodeToolMetricRows(items);
  } catch (cause) {
    throw new PlatformRequestError(
      "The platform API returned tool metrics outside their documented columns.",
      { cause },
    );
  }
  return rows.slice(0, limit).map((row) => ({
    calls: row.calls,
    errors: row.errors,
    name: row.name,
    ...(row.p95_duration_ms === undefined ? {} : { p95DurationMs: row.p95_duration_ms }),
  }));
}

/**
 * The environment overview: the window's trace series and totals, the top deployments by trace
 * volume, the busiest tools, and the latest failed traces. The four hot-plane queries share the
 * two-slot queue, then the failures' releases are looked up by ID.
 */
export async function loadEnvironmentDashboard(
  accessToken: string,
  scope: EnvironmentScope,
  selection: MetricSelection,
): Promise<EnvironmentDashboard> {
  requirePublicIds({ ...scope });
  const window = metricWindow(selection, new Date());
  const range = { from: window.from, to: window.to };
  const hotPlane = createHotPlaneQueue(accessToken);
  const [series, byDeployment, tools, failures] = await Promise.all([
    hotPlane("getObservabilityMetrics", {
      query: { ...range, interval: window.interval },
      scope,
    }),
    // Daily buckets keep the grouped query small; only the window totals per group are shown.
    hotPlane("getObservabilityMetrics", {
      query: { ...range, groupBy: "agentDeploymentId", interval: "day" },
      scope,
    }),
    hotPlane("getObservabilityToolMetrics", { query: range, scope }),
    hotPlane("listObservabilityTraces", {
      query: { ...range, limit: DASHBOARD_FAILURES, status: "error" },
      scope,
    }),
  ]);
  const ranked = groupedMetrics(byDeployment, [], (groupValue) => groupValue ?? UNATTRIBUTED);
  return {
    activity: traceBuckets(series.items, bucketStarts(window)),
    failureReleases: await loadReleaseEntries(
      accessToken,
      scope,
      failures.items.map((trace) => trace.agent_release_id),
    ),
    failures: failures.items,
    tools: toolMetrics(tools.items, DASHBOARD_TOOLS),
    topAgents: ranked.source === "traces" ? ranked.groups : [],
    totals: traceTotals(series.items),
    window,
  };
}

/** The metrics screen: one series, grouped when `groupBy` is set, and the tool table. */
export async function loadMetrics(
  accessToken: string,
  scope: EnvironmentScope,
  selection: MetricSelection,
): Promise<MetricsView> {
  requirePublicIds({ ...scope });
  const window = metricWindow(selection, new Date());
  const range = { from: window.from, to: window.to };
  const hotPlane = createHotPlaneQueue(accessToken);
  const { groupBy } = selection;
  const namesAgents =
    groupBy === "agentDefinitionId" ||
    groupBy === "agentDeploymentId" ||
    groupBy === "agentReleaseId";
  const [series, tools, directory] = await Promise.all([
    hotPlane("getObservabilityMetrics", {
      query: { ...range, interval: window.interval, ...(groupBy ? { groupBy } : {}) },
      scope,
    }),
    hotPlane("getObservabilityToolMetrics", { query: range, scope }),
    namesAgents ? loadAgentDirectory(accessToken, scope) : undefined,
  ]);
  const releases =
    groupBy === "agentReleaseId"
      ? await loadReleaseEntries(
          accessToken,
          scope,
          series.items.map((point) => point.group_value),
        )
      : [];
  const buckets = bucketStarts(window);
  return {
    series: groupBy
      ? {
          grouped: groupedMetrics(
            series,
            buckets,
            groupLabel(groupBy, directory ? agentLabels(directory, releases) : undefined),
          ),
          kind: "grouped",
        }
      : {
          buckets: traceBuckets(series.items, buckets),
          kind: "ungrouped",
          totals: traceTotals(series.items),
        },
    tools: toolMetrics(tools.items, Number.POSITIVE_INFINITY),
    window,
  };
}

/** The environment's agent definitions and deployments, for trace filters and labels. */
export async function loadTraceDirectory(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<AgentDirectory> {
  requirePublicIds({ ...scope });
  return loadAgentDirectory(accessToken, scope);
}

/** One definition's releases, newest first, for the trace list's release filter. */
export async function loadReleaseFilterOptions(
  accessToken: string,
  scope: EnvironmentScope,
  definitionId: string,
): Promise<AgentReleaseEntry[]> {
  requirePublicIds({ ...scope, definitionId });
  return loadDefinitionReleases(accessToken, scope, definitionId);
}

/**
 * One page of the trace list, newest first. The first page binds the window and filters into the
 * cursor; later pages send only the cursor, because the hot plane rejects a page whose window or
 * filters differ from its cursor's.
 */
export async function loadTracePage(
  accessToken: string,
  scope: EnvironmentScope,
  filters: TraceFilters,
  cursor: string | undefined,
): Promise<TracePage> {
  requirePublicIds({ ...scope });
  const hotPlane = createHotPlaneQueue(accessToken);
  const { range, ...predicates } = filters;
  const to = Date.now();
  const page = await hotPlane("listObservabilityTraces", {
    query: cursor
      ? { cursor, limit: TRACE_PAGE_LIMIT }
      : {
          ...predicates,
          from: new Date(to - RANGE_DAYS[range] * DAY_MS).toISOString(),
          limit: TRACE_PAGE_LIMIT,
          to: new Date(to).toISOString(),
        },
    scope,
  });
  return {
    items: page.items,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    releases: await loadReleaseEntries(
      accessToken,
      scope,
      page.items.map((trace) => trace.agent_release_id),
    ),
  };
}

/** A trace with its spans (kept 30 days, so older traces have none), capped at MAX_SPANS. */
export async function loadTraceDetail(
  accessToken: string,
  scope: EnvironmentScope,
  traceId: string,
): Promise<TraceDetail> {
  requirePublicIds({ ...scope });
  const hotPlane = createHotPlaneQueue(accessToken);
  const spanPage = (cursor?: string) =>
    hotPlane("listObservabilityTraceSpans", {
      path: { traceId },
      query: { limit: SPAN_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
      scope,
    });
  const [trace, firstPage] = await Promise.all([
    hotPlane("getObservabilityTrace", { path: { traceId }, scope }),
    spanPage(),
  ]);
  const spans: SpanSummary[] = [...firstPage.items];
  let cursor = firstPage.nextCursor;
  while (cursor && spans.length < MAX_SPANS) {
    const page = await spanPage(cursor);
    spans.push(...page.items);
    cursor = page.nextCursor;
  }
  return {
    releases: await loadReleaseEntries(accessToken, scope, [trace.agent_release_id]),
    spans: spans.slice(0, MAX_SPANS),
    spansTruncated: cursor !== undefined || spans.length > MAX_SPANS,
    trace,
  };
}

/**
 * The finalized trace a run belongs to, for its duration, tokens, and cost. `null` while the run
 * has no finalized trace yet (in flight, or finalized moments ago) or it aged out of retention.
 */
export async function loadRunTrace(
  accessToken: string,
  scope: EnvironmentScope,
  runId: string,
): Promise<TraceSummary | null> {
  requirePublicIds({ ...scope, runId });
  const hotPlane = createHotPlaneQueue(accessToken);
  try {
    return await hotPlane("getObservabilityRunTrace", { path: { runId }, scope });
  } catch (error) {
    if (error instanceof PlatformApiError && error.problem.status === 404) return null;
    throw error;
  }
}

/** A thread's session: the finalized traces of its runs over the last 30 days, newest first. */
export async function loadSessionTracePage(
  accessToken: string,
  scope: EnvironmentScope,
  sessionId: string,
  cursor: string | undefined,
): Promise<TracePage> {
  requirePublicIds({ ...scope, sessionId });
  const hotPlane = createHotPlaneQueue(accessToken);
  const to = Date.now();
  const page = await hotPlane("listObservabilitySessionTraces", {
    path: { sessionId },
    query: cursor
      ? { cursor, limit: TRACE_PAGE_LIMIT }
      : {
          from: new Date(to - RANGE_DAYS["30d"] * DAY_MS).toISOString(),
          limit: TRACE_PAGE_LIMIT,
          to: new Date(to).toISOString(),
        },
    scope,
  });
  return {
    items: page.items,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    releases: await loadReleaseEntries(
      accessToken,
      scope,
      page.items.map((trace) => trace.agent_release_id),
    ),
  };
}

/** An export narrowed to the trace list's selection, with the releases its traces refer to. */
export interface TraceExport extends TraceExportSelection {
  readonly releases: readonly AgentReleaseEntry[];
}

/**
 * The trace list's export. `createObservabilityExport` accepts only a row limit (the API rejects
 * window and filter parameters), so the newest 1,000 traces are requested and narrowed to the
 * list's window and filters; `complete` reports whether they covered the window.
 */
export async function exportTraces(
  accessToken: string,
  scope: EnvironmentScope,
  filters: TraceFilters,
): Promise<TraceExport> {
  requirePublicIds({ ...scope });
  const hotPlane = createHotPlaneQueue(accessToken);
  const response = await hotPlane("createObservabilityExport", {
    body: { limit: EXPORT_LIMIT },
    scope,
  });
  const selection = selectExportedTraces(response.items, filters, response.generatedAt);
  return {
    ...selection,
    releases: await loadReleaseEntries(
      accessToken,
      scope,
      selection.items.map((trace) => trace.agent_release_id),
    ),
  };
}
