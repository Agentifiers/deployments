import type { PlatformContext, PlatformResponse, PlatformSdk } from "./index.ts";
import { segment } from "./validated-path-segment.ts";

export interface ObservabilityContext extends PlatformContext {
  readonly organizationId: string;
}

export interface ObservabilityTraceListOptions {
  readonly agentDefinitionId?: string;
  readonly agentDeploymentId?: string;
  readonly agentReleaseId?: string;
  readonly cursor?: string;
  readonly errorClass?: string;
  readonly executionPurpose?: "customer" | "evaluation" | "preview";
  readonly from?: string;
  readonly limit?: number;
  readonly status?: string;
  readonly to?: string;
}

export interface ObservabilityTraceSummary {
  readonly agent_definition_id?: string;
  readonly agent_deployment_id?: string;
  readonly agent_release_id?: string;
  readonly completed_at?: string | null;
  readonly duration_ms?: number;
  readonly environment_id: string;
  readonly error_class?: string;
  readonly execution_purpose?: string;
  readonly fact_id: string;
  readonly finalized_at?: string | null;
  readonly occurred_at: string;
  readonly project_id: string;
  readonly release_selection?: string;
  readonly root_run_id?: string | null;
  readonly run_count?: number;
  readonly run_id?: string | null;
  readonly session_id?: string | null;
  readonly status?: string | null;
  readonly total_cost_usd_micros?: number;
  readonly total_tokens?: number;
  readonly trace_id: string;
  readonly trigger?: string;
}

export interface ObservabilityTracePage {
  readonly items: readonly ObservabilityTraceSummary[];
  readonly nextCursor?: string;
}

export interface ObservabilitySpan {
  readonly actual_model_id?: string | null;
  readonly actual_provider?: string | null;
  /** Model spans: this attempt. Model-requested tool spans: the attempt that requested the tool. */
  readonly attempt_id?: string | null;
  readonly cached_tokens?: number;
  readonly cost_usd_micros?: number;
  readonly duration_ms?: number;
  readonly error_class?: string | null;
  readonly fact_id: string;
  readonly fallback_attempt?: number;
  readonly fallback_reason?: string | null;
  readonly input_tokens?: number;
  /** Model spans only: `assistant` or `response-depth`. */
  readonly invocation_kind?: string | null;
  readonly kind?: string;
  /** Per-run model generation index on model spans and on model-requested tool spans. */
  readonly model_call_index?: number;
  readonly name?: string;
  readonly occurred_at: string;
  readonly output_tokens?: number;
  readonly parent_span_id?: string | null;
  readonly provider_request_id?: string | null;
  readonly requested_model_id?: string | null;
  readonly requested_provider?: string | null;
  readonly run_id?: string | null;
  readonly session_id?: string | null;
  readonly span_id: string;
  readonly status?: string;
  readonly stop_reason?: string | null;
  readonly total_tokens?: number;
  readonly trace_id: string;
}

export interface ObservabilitySpanListOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

export type ObservabilityMetricGroupBy =
  | "agentDefinitionId"
  | "agentDeploymentId"
  | "agentReleaseId"
  | "model"
  | "provider";

export interface ObservabilityMetricOptions {
  readonly from?: string;
  readonly groupBy?: ObservabilityMetricGroupBy;
  readonly interval?: "day" | "hour";
  readonly to?: string;
}

/** Finalized-trace metrics for one bucket (and agent group). */
export interface ObservabilityMetricPoint {
  readonly bucket: string;
  readonly error_count: number;
  readonly group_value?: string;
  readonly p50_duration_ms?: number;
  readonly p95_duration_ms?: number;
  readonly total_cost_usd_micros: number;
  readonly total_tokens: number;
  readonly trace_count: number;
}

/** Model-invocation metrics for one bucket and model or provider. */
export interface ObservabilityModelMetricPoint {
  readonly bucket: string;
  readonly cached_tokens: number;
  readonly error_count: number;
  readonly group_value?: string;
  readonly input_tokens: number;
  readonly invocation_count: number;
  readonly output_tokens: number;
  readonly p50_latency_ms?: number;
  readonly p95_latency_ms?: number;
  readonly total_cost_usd_micros: number;
  readonly total_tokens: number;
}

export interface ObservabilityMetricSeries {
  readonly from: string;
  readonly groupBy?: ObservabilityMetricGroupBy;
  readonly interval: "day" | "hour";
  readonly items: readonly (ObservabilityMetricPoint | ObservabilityModelMetricPoint)[];
  readonly source: "model-invocations" | "traces";
  readonly to: string;
}

export interface ObservabilityToolMetricOptions {
  readonly agentDeploymentId?: string;
  readonly from?: string;
  readonly to?: string;
}

export interface ObservabilitySdk {
  readonly listTraces: (
    options?: ObservabilityTraceListOptions,
  ) => Promise<PlatformResponse<ObservabilityTracePage>>;
  readonly getTrace: (traceId: string) => Promise<PlatformResponse<ObservabilityTraceSummary>>;
  readonly listTraceSpans: (
    traceId: string,
    options?: ObservabilitySpanListOptions,
  ) => Promise<
    PlatformResponse<{
      readonly items: readonly ObservabilitySpan[];
      readonly nextCursor?: string;
    }>
  >;
  readonly getRunTrace: (runId: string) => Promise<PlatformResponse<ObservabilityTraceSummary>>;
  readonly listSessionTraces: (
    sessionId: string,
    options?: ObservabilityTraceListOptions,
  ) => Promise<PlatformResponse<ObservabilityTracePage>>;
  readonly metrics: (
    options?: ObservabilityMetricOptions,
  ) => Promise<PlatformResponse<ObservabilityMetricSeries>>;
  readonly tools: (options?: ObservabilityToolMetricOptions) => Promise<
    PlatformResponse<{
      readonly from: string;
      readonly items: readonly Readonly<Record<string, unknown>>[];
      readonly to: string;
    }>
  >;
  readonly exportTraces: (limit?: number) => Promise<
    PlatformResponse<{
      readonly generatedAt: string;
      readonly items: readonly ObservabilityTraceSummary[];
    }>
  >;
}

function query(options: ObservabilityTraceListOptions = {}) {
  return {
    agentDefinitionId: options.agentDefinitionId,
    agentDeploymentId: options.agentDeploymentId,
    agentReleaseId: options.agentReleaseId,
    cursor: options.cursor,
    errorClass: options.errorClass,
    executionPurpose: options.executionPurpose,
    from: options.from,
    limit: options.limit,
    status: options.status,
    to: options.to,
  };
}

export function createObservabilitySdk(
  sdk: PlatformSdk,
  context: ObservabilityContext,
): ObservabilitySdk {
  return {
    listTraces: (options) =>
      sdk.request({
        context,
        method: "GET",
        path: "/v1/observability/traces",
        query: query(options),
      }),
    getTrace: (traceId) =>
      sdk.request({
        context,
        method: "GET",
        path: `/v1/observability/traces/${segment(traceId, "traceId")}`,
      }),
    listTraceSpans: (traceId, options) =>
      sdk.request({
        context,
        method: "GET",
        path: `/v1/observability/traces/${segment(traceId, "traceId")}/spans`,
        query: { cursor: options?.cursor, limit: options?.limit },
      }),
    getRunTrace: (runId) =>
      sdk.request({
        context,
        method: "GET",
        path: `/v1/observability/runs/${segment(runId, "runId")}/trace`,
      }),
    listSessionTraces: (sessionId, options) =>
      sdk.request({
        context,
        method: "GET",
        path: `/v1/observability/sessions/${segment(sessionId, "sessionId")}/traces`,
        query: query(options),
      }),
    metrics: (options) =>
      sdk.request({
        context,
        method: "GET",
        path: "/v1/observability/metrics",
        query: {
          from: options?.from,
          groupBy: options?.groupBy,
          interval: options?.interval,
          to: options?.to,
        },
      }),
    tools: (options) =>
      sdk.request({
        context,
        method: "GET",
        path: "/v1/observability/tools",
        query: {
          agentDeploymentId: options?.agentDeploymentId,
          from: options?.from,
          to: options?.to,
        },
      }),
    exportTraces: (limit) =>
      sdk.request({
        body: limit === undefined ? {} : { limit },
        context,
        method: "POST",
        path: "/v1/observability/exports",
      }),
  };
}
