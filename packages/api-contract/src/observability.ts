import { Schema } from "effect";
import type { PublicApiRouteContract, PublicApiQueryParameter } from "./route-contract.ts";
import { Timestamp } from "./primitives.ts";

const CursorQuery = {
  name: "cursor",
  schema: { maxLength: 4096, minLength: 1, type: "string" },
} as const;
const LimitQuery = {
  name: "limit",
  schema: { maximum: 100, minimum: 1, type: "integer" },
} as const;
const IdentifierQuery = (name: string, description: string) =>
  ({
    description,
    name,
    schema: { maxLength: 160, minLength: 1, pattern: "^[A-Za-z0-9._:-]+$", type: "string" },
  }) as const satisfies PublicApiQueryParameter;
const FromQuery = {
  description: "Inclusive window start (RFC 3339).",
  name: "from",
  schema: { format: "date-time", type: "string" },
} as const;
const ToQuery = {
  description: "Window end (RFC 3339).",
  name: "to",
  schema: { format: "date-time", type: "string" },
} as const;
const TraceQueries = [
  CursorQuery,
  LimitQuery,
  FromQuery,
  ToQuery,
  { name: "status", schema: { maxLength: 64, minLength: 1, type: "string" } },
  IdentifierQuery(
    "agentDefinitionId",
    "Only traces whose root run executed a release of this agent definition.",
  ),
  IdentifierQuery(
    "agentDeploymentId",
    "Only traces whose root run executed this agent deployment.",
  ),
  IdentifierQuery("agentReleaseId", "Only traces whose root run executed this agent release."),
  {
    description: "Only traces whose root run had this execution purpose.",
    name: "executionPurpose",
    schema: { enum: ["customer", "evaluation", "preview"], type: "string" },
  },
  IdentifierQuery("errorClass", "Only errored traces with this error class."),
] as const satisfies readonly PublicApiQueryParameter[];

export const OBSERVABILITY_METRIC_INTERVALS = ["hour", "day"] as const;
export const OBSERVABILITY_TRACE_METRIC_GROUPS = [
  "agentDefinitionId",
  "agentDeploymentId",
  "agentReleaseId",
] as const;
export const OBSERVABILITY_MODEL_METRIC_GROUPS = ["model", "provider"] as const;
export const OBSERVABILITY_METRIC_GROUPS = [
  ...OBSERVABILITY_TRACE_METRIC_GROUPS,
  ...OBSERVABILITY_MODEL_METRIC_GROUPS,
] as const;

const MetricQueries = [
  {
    ...FromQuery,
    description: "Inclusive window start (RFC 3339); defaults to `to` minus 24 hours.",
  },
  { ...ToQuery, description: "Window end (RFC 3339); defaults to now." },
  {
    description: "Bucket width; defaults to `hour`.",
    name: "interval",
    schema: { enum: [...OBSERVABILITY_METRIC_INTERVALS], type: "string" },
  },
  {
    description:
      "Optional dimension. Agent dimensions aggregate finalized traces; `model` and `provider` aggregate model invocations.",
    name: "groupBy",
    schema: { enum: [...OBSERVABILITY_METRIC_GROUPS], type: "string" },
  },
  IdentifierQuery(
    "agentDeploymentId",
    "Only traces and model invocations of this agent deployment.",
  ),
] as const satisfies readonly PublicApiQueryParameter[];

const ToolMetricQueries = [
  {
    ...FromQuery,
    description: "Inclusive window start (RFC 3339); defaults to `to` minus 24 hours.",
  },
  { ...ToQuery, description: "Window end (RFC 3339); defaults to now." },
  IdentifierQuery("agentDeploymentId", "Only tool calls made by runs of this agent deployment."),
] as const satisfies readonly PublicApiQueryParameter[];

export const ObservabilityPayload = Schema.Record(Schema.String, Schema.Unknown);

export const ObservabilityTraceSummary = Schema.Struct({
  agent_definition_id: Schema.optional(Schema.String),
  agent_deployment_id: Schema.optional(Schema.String),
  agent_release_id: Schema.optional(Schema.String),
  completed_at: Schema.optional(Timestamp),
  duration_ms: Schema.optional(Schema.Number),
  environment_id: Schema.String,
  error_class: Schema.optional(Schema.String),
  execution_purpose: Schema.optional(Schema.String),
  fact_id: Schema.String,
  finalized_at: Schema.optional(Timestamp),
  occurred_at: Timestamp,
  project_id: Schema.String,
  release_selection: Schema.optional(Schema.String),
  root_run_id: Schema.optional(Schema.String),
  run_count: Schema.optional(Schema.Number),
  run_id: Schema.optional(Schema.String),
  session_id: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  total_cost_usd_micros: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
  trace_id: Schema.String,
  trigger: Schema.optional(Schema.String),
});

export const ObservabilityTraceListResponse = Schema.Struct({
  items: Schema.Array(ObservabilityTraceSummary),
  nextCursor: Schema.optional(Schema.String),
});

export const ObservabilityTraceResponse = ObservabilityTraceSummary;

export const ObservabilitySpanResponse = Schema.Struct({
  actual_model_id: Schema.optional(Schema.String),
  actual_provider: Schema.optional(Schema.String),
  /** Model spans: this attempt. Model-requested tool spans: the attempt that requested the tool. */
  attempt_id: Schema.optional(Schema.String),
  cached_tokens: Schema.optional(Schema.Number),
  cost_usd_micros: Schema.optional(Schema.Number),
  duration_ms: Schema.optional(Schema.Number),
  error_class: Schema.optional(Schema.String),
  fact_id: Schema.String,
  fallback_attempt: Schema.optional(Schema.Number),
  fallback_reason: Schema.optional(Schema.String),
  input_tokens: Schema.optional(Schema.Number),
  /** Model spans only: `assistant` or `response-depth`. */
  invocation_kind: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  /** Per-run model generation index on model spans and on model-requested tool spans. */
  model_call_index: Schema.optional(Schema.Number),
  name: Schema.optional(Schema.String),
  occurred_at: Timestamp,
  output_tokens: Schema.optional(Schema.Number),
  parent_span_id: Schema.optional(Schema.String),
  provider_request_id: Schema.optional(Schema.String),
  requested_model_id: Schema.optional(Schema.String),
  requested_provider: Schema.optional(Schema.String),
  run_id: Schema.optional(Schema.String),
  session_id: Schema.optional(Schema.String),
  span_id: Schema.String,
  status: Schema.optional(Schema.String),
  stop_reason: Schema.optional(Schema.String),
  total_tokens: Schema.optional(Schema.Number),
  trace_id: Schema.String,
});

export const ObservabilitySpanListResponse = Schema.Struct({
  items: Schema.Array(ObservabilitySpanResponse),
  nextCursor: Schema.optional(Schema.String),
});

/** One bucket (and group) of finalized-trace metrics. */
export const ObservabilityMetricPoint = Schema.Struct({
  bucket: Timestamp,
  error_count: Schema.Number,
  /** Value of the `groupBy` dimension; absent for ungrouped series and traces lacking it. */
  group_value: Schema.optional(Schema.String),
  p50_duration_ms: Schema.optional(Schema.Number),
  p95_duration_ms: Schema.optional(Schema.Number),
  total_cost_usd_micros: Schema.Number,
  total_tokens: Schema.Number,
  trace_count: Schema.Number,
});

/** One bucket and model or provider of model-invocation metrics. */
export const ObservabilityModelMetricPoint = Schema.Struct({
  bucket: Timestamp,
  cached_tokens: Schema.Number,
  error_count: Schema.Number,
  group_value: Schema.optional(Schema.String),
  input_tokens: Schema.Number,
  invocation_count: Schema.Number,
  output_tokens: Schema.Number,
  p50_latency_ms: Schema.optional(Schema.Number),
  p95_latency_ms: Schema.optional(Schema.Number),
  total_cost_usd_micros: Schema.Number,
  total_tokens: Schema.Number,
});

export const ObservabilityMetricSeriesResponse = Schema.Struct({
  from: Timestamp,
  groupBy: Schema.optional(Schema.Literals(OBSERVABILITY_METRIC_GROUPS)),
  interval: Schema.Literals(OBSERVABILITY_METRIC_INTERVALS),
  /** Trace points for ungrouped and agent-grouped series; model points for model/provider. */
  items: Schema.Array(Schema.Union([ObservabilityMetricPoint, ObservabilityModelMetricPoint])),
  source: Schema.Literals(["model-invocations", "traces"]),
  to: Timestamp,
});

export const ObservabilityToolMetricsResponse = Schema.Struct({
  from: Timestamp,
  items: Schema.Array(ObservabilityPayload),
  to: Timestamp,
});

export const CreateObservabilityExportRequest = Schema.Struct({
  limit: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(1_000),
    ),
  ),
});

export const ObservabilityExportResponse = Schema.Struct({
  generatedAt: Timestamp,
  items: Schema.Array(ObservabilityTraceSummary),
});

export const OBSERVABILITY_API_SCHEMAS = {
  CreateObservabilityExportRequest,
  ObservabilityExportResponse,
  ObservabilityMetricSeriesResponse,
  ObservabilityMetricPoint,
  ObservabilityModelMetricPoint,
  ObservabilitySpanListResponse,
  ObservabilitySpanResponse,
  ObservabilityToolMetricsResponse,
  ObservabilityTraceListResponse,
  ObservabilityTraceResponse,
  ObservabilityTraceSummary,
} as const;

const errors = [400, 401, 403, 404, 410, 413, 429, 500, 502, 503, 504] as const;
const traceIdParameter = [
  { name: "traceId", schema: { maxLength: 160, minLength: 1, type: "string" } },
] as const;
const runIdParameter = [
  { name: "runId", schema: { maxLength: 160, minLength: 1, type: "string" } },
] as const;
const sessionIdParameter = [
  {
    name: "sessionId",
    schema: { maxLength: 160, minLength: 1, type: "string" },
  },
] as const;

export const OBSERVABILITY_API_ROUTES = [
  {
    authentication: "platform-bearer",
    errors,
    idempotency: "none",
    method: "GET",
    name: "listObservabilityTraces",
    path: "/v1/observability/traces",
    queryParameters: TraceQueries,
    requiredAuthorization: "observability:read",
    responseBody: "ObservabilityTraceListResponse",
    scopeHeaders: "organization",
    successStatus: 200,
    tag: "Observability",
  },
  {
    authentication: "platform-bearer",
    errors,
    idempotency: "none",
    method: "GET",
    name: "getObservabilityTrace",
    path: "/v1/observability/traces/:traceId",
    pathParameters: traceIdParameter,
    requiredAuthorization: "observability:read",
    responseBody: "ObservabilityTraceResponse",
    scopeHeaders: "organization",
    successStatus: 200,
    tag: "Observability",
  },
  {
    authentication: "platform-bearer",
    errors,
    idempotency: "none",
    method: "GET",
    name: "listObservabilityTraceSpans",
    path: "/v1/observability/traces/:traceId/spans",
    pathParameters: traceIdParameter,
    queryParameters: [CursorQuery, LimitQuery],
    requiredAuthorization: "observability:read",
    responseBody: "ObservabilitySpanListResponse",
    scopeHeaders: "organization",
    successStatus: 200,
    tag: "Observability",
  },
  {
    authentication: "platform-bearer",
    errors,
    idempotency: "none",
    method: "GET",
    name: "getObservabilityRunTrace",
    path: "/v1/observability/runs/:runId/trace",
    pathParameters: runIdParameter,
    requiredAuthorization: "observability:read",
    responseBody: "ObservabilityTraceResponse",
    scopeHeaders: "organization",
    successStatus: 200,
    tag: "Observability",
  },
  {
    authentication: "platform-bearer",
    errors,
    idempotency: "none",
    method: "GET",
    name: "listObservabilitySessionTraces",
    path: "/v1/observability/sessions/:sessionId/traces",
    pathParameters: sessionIdParameter,
    queryParameters: TraceQueries,
    requiredAuthorization: "observability:read",
    responseBody: "ObservabilityTraceListResponse",
    scopeHeaders: "organization",
    successStatus: 200,
    tag: "Observability",
  },
  {
    authentication: "platform-bearer",
    errors,
    idempotency: "none",
    method: "GET",
    name: "getObservabilityMetrics",
    path: "/v1/observability/metrics",
    queryParameters: MetricQueries,
    requiredAuthorization: "observability:read",
    responseBody: "ObservabilityMetricSeriesResponse",
    scopeHeaders: "organization",
    successStatus: 200,
    tag: "Observability",
  },
  {
    authentication: "platform-bearer",
    errors,
    idempotency: "none",
    method: "GET",
    name: "getObservabilityToolMetrics",
    path: "/v1/observability/tools",
    queryParameters: ToolMetricQueries,
    requiredAuthorization: "observability:read",
    responseBody: "ObservabilityToolMetricsResponse",
    scopeHeaders: "organization",
    successStatus: 200,
    tag: "Observability",
  },
  {
    authentication: "platform-bearer",
    errors,
    idempotency: "none",
    method: "POST",
    name: "createObservabilityExport",
    path: "/v1/observability/exports",
    requestBody: "CreateObservabilityExportRequest",
    requestBodyRequired: true,
    requiredAuthorization: "observability:read",
    responseBody: "ObservabilityExportResponse",
    scopeHeaders: "organization",
    standing: "read",
    successStatus: 200,
    tag: "Observability",
  },
] as const satisfies readonly PublicApiRouteContract[];

export type ObservabilityApiRouteName = (typeof OBSERVABILITY_API_ROUTES)[number]["name"];
