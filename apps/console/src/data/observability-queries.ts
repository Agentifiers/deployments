import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { parseMetricSelection, type MetricSelection } from "../observability/range.ts";
import {
  OBSERVABILITY_IDENTIFIER,
  parseTraceFilters,
  type TraceFilters,
} from "../observability/trace-filters.ts";
import { SCOPE_FIELDS, scopeKey, type EnvironmentScope } from "../scope.ts";
import {
  exportTraces,
  loadEnvironmentDashboard,
  loadMetrics,
  loadReleaseFilterOptions,
  loadRunTrace,
  loadSessionTracePage,
  loadTraceDetail,
  loadTraceDirectory,
  loadTracePage,
} from "../server/observability-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { STATUS_REFRESH_MS } from "./refresh.ts";
import { fields, pageInput, requireIds, type PageInput } from "./server-input.ts";

/** Agent names change rarely; one directory read serves every trace page for a while. */
const DIRECTORY_STALE_MS = 5 * 60_000;

/** Server functions accept arbitrary payloads: re-validate the scope and every selection. */
function metricInput(input: unknown) {
  const value = fields(input);
  return {
    scope: requireIds(value.scope, SCOPE_FIELDS),
    selection: parseMetricSelection(fields(value.selection)),
  };
}

const fetchDashboard = createServerFn({ method: "GET" })
  .validator((input: { readonly scope: EnvironmentScope; readonly selection: MetricSelection }) =>
    metricInput(input),
  )
  .handler(async ({ data }) =>
    loadEnvironmentDashboard(await requireAccessToken(), data.scope, data.selection),
  );

const fetchMetrics = createServerFn({ method: "GET" })
  .validator((input: { readonly scope: EnvironmentScope; readonly selection: MetricSelection }) =>
    metricInput(input),
  )
  .handler(async ({ data }) => loadMetrics(await requireAccessToken(), data.scope, data.selection));

const fetchTraceDirectory = createServerFn({ method: "GET" })
  .validator((input: EnvironmentScope) => requireIds(input, SCOPE_FIELDS))
  .handler(async ({ data }) => loadTraceDirectory(await requireAccessToken(), data));

const fetchReleaseFilterOptions = createServerFn({ method: "GET" })
  .validator((input: { readonly definitionId: string; readonly scope: EnvironmentScope }) => {
    const value = fields(input);
    return {
      definitionId: requireIds(value, ["definitionId"]).definitionId,
      scope: requireIds(value.scope, SCOPE_FIELDS),
    };
  })
  .handler(async ({ data }) =>
    loadReleaseFilterOptions(await requireAccessToken(), data.scope, data.definitionId),
  );

const fetchTracePage = createServerFn({ method: "GET" })
  .validator(
    (input: {
      readonly cursor?: string;
      readonly filters: TraceFilters;
      readonly scope: EnvironmentScope;
    }) => {
      const value = fields(input);
      return {
        cursor: typeof value.cursor === "string" ? value.cursor : undefined,
        filters: parseTraceFilters(fields(value.filters)),
        scope: requireIds(value.scope, SCOPE_FIELDS),
      };
    },
  )
  .handler(async ({ data }) =>
    loadTracePage(await requireAccessToken(), data.scope, data.filters, data.cursor),
  );

const fetchTraceDetail = createServerFn({ method: "GET" })
  .validator((input: { readonly scope: EnvironmentScope; readonly traceId: string }) => {
    const value = fields(input);
    if (typeof value.traceId !== "string" || !OBSERVABILITY_IDENTIFIER.test(value.traceId)) {
      throw new TypeError("traceId must be an observability identifier.");
    }
    return { scope: requireIds(value.scope, SCOPE_FIELDS), traceId: value.traceId };
  })
  .handler(async ({ data }) =>
    loadTraceDetail(await requireAccessToken(), data.scope, data.traceId),
  );

const fetchRunTrace = createServerFn({ method: "GET" })
  .validator((input: { readonly runId: string; readonly scope: EnvironmentScope }) => ({
    ...requireIds(input, ["runId"]),
    scope: requireIds(fields(input).scope, SCOPE_FIELDS),
  }))
  .handler(async ({ data }) => loadRunTrace(await requireAccessToken(), data.scope, data.runId));

const fetchSessionTracePage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly sessionId: string }) => pageInput(input, ["sessionId"]))
  .handler(async ({ data }) =>
    loadSessionTracePage(await requireAccessToken(), data.scope, data.sessionId, data.cursor),
  );

/**
 * The trace list's export (`POST /v1/observability/exports`, a read): the newest traces narrowed
 * to the list's window and filters. Each Export click runs one fresh export.
 */
export const exportTracesFn = createServerFn({ method: "POST" })
  .validator((input: { readonly filters: TraceFilters; readonly scope: EnvironmentScope }) => {
    const value = fields(input);
    return {
      filters: parseTraceFilters(fields(value.filters)),
      scope: requireIds(value.scope, SCOPE_FIELDS),
    };
  })
  .handler(async ({ data }) => exportTraces(await requireAccessToken(), data.scope, data.filters));

export const environmentDashboardQuery = (scope: EnvironmentScope, selection: MetricSelection) =>
  queryOptions({
    queryFn: () => fetchDashboard({ data: { scope, selection } }),
    queryKey: ["observability-dashboard", ...scopeKey(scope), selection.range, selection.interval],
    refetchInterval: STATUS_REFRESH_MS,
  });

export const metricsQuery = (scope: EnvironmentScope, selection: MetricSelection) =>
  queryOptions({
    queryFn: () => fetchMetrics({ data: { scope, selection } }),
    queryKey: [
      "observability-metrics",
      ...scopeKey(scope),
      selection.range,
      selection.interval,
      selection.groupBy ?? null,
    ],
  });

export const agentDirectoryQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchTraceDirectory({ data: scope }),
    queryKey: ["agent-directory", ...scopeKey(scope)],
    staleTime: DIRECTORY_STALE_MS,
  });

/** One agent's releases for the trace list's release filter. */
export const releaseFilterQuery = (scope: EnvironmentScope, definitionId: string) =>
  queryOptions({
    queryFn: () => fetchReleaseFilterOptions({ data: { definitionId, scope } }),
    queryKey: ["agent-releases", ...scopeKey(scope), definitionId],
    staleTime: DIRECTORY_STALE_MS,
  });

/**
 * Trace pages. Cursors pin a snapshot for five minutes, so the list never refetches on its own:
 * re-fetching every page would replay expired cursors. Refreshing resets the list instead.
 */
export const tracePagesQuery = (scope: EnvironmentScope, filters: TraceFilters) =>
  infiniteQueryOptions({
    // `queryFn` precedes `getNextPageParam` so the page type is inferred from it.
    queryFn: ({ pageParam }) =>
      fetchTracePage({
        data: { filters, scope, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: ["observability-traces", ...scopeKey(scope), filters],
    staleTime: Number.POSITIVE_INFINITY,
  });

export const traceDetailQuery = (scope: EnvironmentScope, traceId: string) =>
  queryOptions({
    queryFn: () => fetchTraceDetail({ data: { scope, traceId } }),
    queryKey: ["observability-trace", ...scopeKey(scope), traceId],
  });

/** The finalized trace of a run, for its totals; `null` until the run's trace is finalized. */
export const runTraceQuery = (scope: EnvironmentScope, runId: string) =>
  queryOptions({
    queryFn: () => fetchRunTrace({ data: { runId, scope } }),
    queryKey: ["observability-run-trace", ...scopeKey(scope), runId],
  });

/** A thread's traces. Like the trace list, its cursors pin a snapshot, so it never refetches. */
export const sessionTracePagesQuery = (scope: EnvironmentScope, sessionId: string) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchSessionTracePage({
        data: { scope, sessionId, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: ["observability-session", ...scopeKey(scope), sessionId],
    staleTime: Number.POSITIVE_INFINITY,
  });
