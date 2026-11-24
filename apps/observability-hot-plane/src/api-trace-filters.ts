import {
  identifier,
  QueryProblem,
  type PageCursor,
  type TraceFilterName,
  type TraceFilters,
} from "./api-query.ts";

const EXECUTION_PURPOSES: Readonly<Record<string, true>> = {
  customer: true,
  evaluation: true,
  preview: true,
};

/**
 * Trace filters read typed fields of the finalized trace fact payload. Facts finalized before a
 * field existed never match a filter on it.
 */
const TRACE_FILTERS: Readonly<
  Record<TraceFilterName, { readonly parameter: string; readonly predicate: string }>
> = {
  agentDefinitionId: {
    parameter: "agent_definition_id",
    predicate:
      "JSONExtractString(payload_json, 'agentDefinitionId') = {agent_definition_id:String}",
  },
  agentDeploymentId: {
    parameter: "agent_deployment_id",
    predicate:
      "JSONExtractString(payload_json, 'agentDeploymentId') = {agent_deployment_id:String}",
  },
  agentReleaseId: {
    parameter: "agent_release_id",
    predicate: "JSONExtractString(payload_json, 'agentReleaseId') = {agent_release_id:String}",
  },
  errorClass: {
    parameter: "error_class",
    predicate: "JSONExtractString(payload_json, 'errorClass') = {error_class:String}",
  },
  executionPurpose: {
    parameter: "execution_purpose",
    predicate: "JSONExtractString(payload_json, 'executionPurpose') = {execution_purpose:String}",
  },
  status: {
    parameter: "status",
    predicate:
      "coalesce(nullIf(JSONExtractString(payload_json, 'outcome'), ''), 'unknown') = {status:String}",
  },
};

const FILTER_ENTRIES = Object.entries(TRACE_FILTERS) as readonly [
  TraceFilterName,
  (typeof TRACE_FILTERS)[TraceFilterName],
][];

/** Parses the requested filters; omitted filters fall back to the cursor's bound values. */
export function traceFilters(searchParams: URLSearchParams, cursor: PageCursor | undefined) {
  const requested: Partial<Record<TraceFilterName, string>> = {};
  for (const [name, filter] of FILTER_ENTRIES) {
    const value = identifier(searchParams.get(name), filter.parameter);
    if (value !== undefined) requested[name] = value;
  }
  if (
    requested.executionPurpose !== undefined &&
    EXECUTION_PURPOSES[requested.executionPurpose] !== true
  ) {
    throw new QueryProblem(
      400,
      "invalid_execution_purpose",
      "executionPurpose must be customer, evaluation, or preview.",
    );
  }
  if (!cursor) return requested as TraceFilters;
  if (
    FILTER_ENTRIES.some(
      ([name]) => requested[name] !== undefined && requested[name] !== cursor[name],
    )
  ) {
    throw new QueryProblem(
      400,
      "cursor_filter_mismatch",
      "Trace filters must match the cursor query.",
    );
  }
  const bound: Partial<Record<TraceFilterName, string>> = {};
  for (const [name] of FILTER_ENTRIES) {
    if (cursor[name] !== undefined) bound[name] = cursor[name];
  }
  return bound as TraceFilters;
}

export function traceFilterSql(filters: TraceFilters) {
  const active = FILTER_ENTRIES.filter(([name]) => filters[name] !== undefined);
  return {
    parameters: Object.fromEntries(
      active.map(([name, filter]) => [filter.parameter, filters[name]!]),
    ) as Readonly<Record<string, string>>,
    predicates: active.map(([, filter]) => filter.predicate),
  };
}
