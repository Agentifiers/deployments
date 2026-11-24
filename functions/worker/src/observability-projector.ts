import {
  parseObservabilityFact,
  type JsonValue,
  type ObservabilityFact,
} from "@deployments-ai/observability";

export type ObservabilityIcebergDestination =
  | "model-invocations"
  | "spans"
  | "tombstones"
  | "traces"
  | "usage";

export interface ObservabilityIcebergProjection {
  readonly destination: ObservabilityIcebergDestination;
  readonly record: Readonly<Record<string, boolean | null | number | string>>;
}

export interface ObservabilityProjectionSource {
  readonly sequenceNumber: string;
  readonly shardId: string;
  readonly streamArn: string;
}

function payloadObject(fact: ObservabilityFact): Readonly<Record<string, JsonValue>> {
  if (!fact.payload || typeof fact.payload !== "object" || Array.isArray(fact.payload)) {
    throw new Error(`Observability fact ${fact.factId} payload must be an object.`);
  }
  return fact.payload as Readonly<Record<string, JsonValue>>;
}

function text(payload: Readonly<Record<string, JsonValue>>, name: string) {
  const value = payload[name];
  return typeof value === "string" ? value : null;
}

function number(payload: Readonly<Record<string, JsonValue>>, name: string) {
  const value = payload[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolean(payload: Readonly<Record<string, JsonValue>>, name: string) {
  const value = payload[name];
  return typeof value === "boolean" ? value : null;
}

function json(payload: Readonly<Record<string, JsonValue>>, name: string) {
  const value = payload[name];
  return value === undefined ? null : JSON.stringify(value);
}

function common(
  fact: ObservabilityFact,
  projectedAt: string,
  projectionSource?: ObservabilityProjectionSource,
) {
  return {
    capture_mode: fact.captureMode,
    environment_id: fact.scope.environmentId,
    fact_id: fact.factId,
    fact_type: fact.factType,
    normalized_at: fact.normalizedAt,
    occurred_at: fact.occurredAt,
    organization_id: fact.scope.organizationId,
    parent_span_id: fact.trace?.parentSpanId ?? null,
    payload_json: JSON.stringify(fact.payload),
    project_id: fact.scope.projectId,
    projection_sequence_number: projectionSource?.sequenceNumber ?? null,
    projection_shard_id: projectionSource?.shardId ?? null,
    projection_stream_arn: projectionSource?.streamArn ?? null,
    projected_at: projectedAt,
    redaction_policy_version: fact.redactionPolicyVersion,
    run_id: fact.trace?.runId ?? null,
    schema_version: fact.schemaVersion,
    session_id: fact.trace?.sessionId ?? null,
    source_record_id: fact.source.recordId,
    source_record_type: fact.source.recordType,
    source_record_version: fact.source.recordVersion,
    source_stream_arn: fact.source.streamArn ?? null,
    source_stream_sequence_number: fact.source.streamSequenceNumber ?? null,
    source_table: fact.source.table,
    span_id: fact.trace?.spanId ?? null,
    trace_id: fact.trace?.traceId ?? null,
    workspace_id: fact.scope.workspaceId ?? null,
  } as const;
}

export function observabilityIcebergProjection(
  value: unknown,
  projectedAt: string,
  projectionSource?: ObservabilityProjectionSource,
): ObservabilityIcebergProjection {
  const fact = parseObservabilityFact(value);
  const payload = payloadObject(fact);
  const base = common(fact, projectedAt, projectionSource);
  switch (fact.factType) {
    case "span.finalized":
      return {
        destination: "spans",
        record: {
          ...base,
          actual_model_id: text(payload, "actualModelId"),
          actual_provider: text(payload, "actualProvider"),
          cached_tokens: number(payload, "cachedTokens"),
          cost_usd_micros: number(payload, "costUsdMicros"),
          duration_ms: number(payload, "durationMs"),
          ended_at: text(payload, "endedAt"),
          error_class: text(payload, "errorClass"),
          input_tokens: number(payload, "inputTokens"),
          output_tokens: number(payload, "outputTokens"),
          provider_request_id: text(payload, "providerRequestId"),
          requested_model_id: text(payload, "requestedModelId"),
          requested_provider: text(payload, "requestedProvider"),
          span_kind: text(payload, "kind"),
          span_name: text(payload, "name"),
          span_status: text(payload, "status"),
          started_at: text(payload, "startedAt"),
          stop_reason: text(payload, "stopReason"),
          tool_effect: text(payload, "effect"),
          total_tokens: number(payload, "totalTokens"),
        },
      };
    case "trace.finalized":
      return {
        destination: "traces",
        // Root-run agent summary fields stay inside payload_json only: S3 Tables metadata
        // changes force table replacement, so the traces table has no typed columns for them.
        record: {
          ...base,
          completed_at: text(payload, "completedAt"),
          finalized_at: text(payload, "finalizedAt"),
          graph_watermark: text(payload, "graphWatermark"),
          root_run_id: text(payload, "rootRunId"),
          run_count: number(payload, "runCount"),
          trace_status: text(payload, "status"),
          total_cost_usd_micros: number(payload, "totalCostUsdMicros"),
          total_tokens: number(payload, "totalTokens"),
        },
      };
    case "model-invocation.recorded":
      return {
        destination: "model-invocations",
        record: {
          ...base,
          actual_model_id: text(payload, "actualModelId"),
          actual_provider: text(payload, "actualProvider"),
          agent_definition_id: text(payload, "agentDefinitionId"),
          agent_deployment_id: text(payload, "agentDeploymentId"),
          agent_manifest_hash: text(payload, "agentManifestHash"),
          agent_release_id: text(payload, "agentReleaseId"),
          attempt_id: text(payload, "attemptId"),
          cached_tokens: number(payload, "cachedTokens"),
          cost_usd_micros: number(payload, "costUsdMicros"),
          duration_ms: number(payload, "durationMs"),
          ended_at: text(payload, "endedAt"),
          error_class: text(payload, "errorClass"),
          fallback_attempt: number(payload, "fallbackAttempt"),
          fallback_reason: text(payload, "fallbackReason"),
          internal_evaluator: boolean(payload, "internalEvaluator"),
          invocation_id: text(payload, "invocationId"),
          input_tokens: number(payload, "inputTokens"),
          output_tokens: number(payload, "outputTokens"),
          provider_request_id: text(payload, "providerRequestId"),
          requested_model_id: text(payload, "requestedModelId"),
          requested_provider: text(payload, "requestedProvider"),
          started_at: text(payload, "startedAt"),
          stop_reason: text(payload, "stopReason"),
          invocation_status: text(payload, "status"),
          streaming: boolean(payload, "streaming"),
          total_tokens: number(payload, "totalTokens"),
          usage_idempotency_key: text(payload, "usageIdempotencyKey"),
        },
      };
    case "usage.recorded":
      return {
        destination: "usage",
        record: {
          ...base,
          cost_usd_micros: number(payload, "costUsdMicros"),
          metric: text(payload, "metric"),
          model_id: text(payload, "modelId"),
          provider: text(payload, "provider"),
          quantity: number(payload, "quantity"),
          started_at: text(payload, "startedAt"),
          usage_idempotency_key: text(payload, "idempotencyKey"),
          usage_source: text(payload, "source"),
          unit: text(payload, "unit"),
        },
      };
    case "record.deleted":
      return {
        destination: "tombstones",
        record: {
          ...base,
          delete_through_record_version: number(payload, "deleteThroughRecordVersion"),
          deleted_at: fact.occurredAt,
          deleted_fact_types_json: json(payload, "deletedFactTypes"),
        },
      };
    default:
      throw new Error(`Observability fact ${fact.factType} is not part of Phase 2.`);
  }
}
