import { expect, test } from "bun:test";
import { makeObservabilityFact } from "@deployments-ai/observability";
import { observabilityIcebergProjection } from "./observability-projector.ts";

const source = {
  recordId: "record-1",
  recordType: "model-invocation",
  recordVersion: 0,
  streamArn: "arn:aws:dynamodb:us-east-2:123:table/execution/stream/1",
  streamSequenceNumber: "100",
  table: "execution" as const,
};
const scope = { environmentId: "env", organizationId: "org", projectId: "project" };
const trace = {
  parentSpanId: "0123456789abcdef" as const,
  runId: "run",
  sessionId: "thread",
  spanId: "fedcba9876543210" as const,
  traceId: "0123456789abcdef0123456789abcdef" as const,
};

test("flattens model facts into bounded Iceberg columns", () => {
  const fact = makeObservabilityFact({
    captureMode: "metadata-only",
    factType: "model-invocation.recorded",
    normalizedAt: "2026-07-28T12:00:02.000Z",
    occurredAt: "2026-07-28T12:00:01.000Z",
    payload: {
      attemptId: "attempt-1",
      cachedTokens: 2,
      durationMs: 900,
      inputTokens: 4,
      input: "must not exist",
      invocationId: "invocation-1",
      requestedModelId: "openrouter/primary",
      outputTokens: 1,
      providerRequestId: "provider-request-digest",
      status: "ok",
      stopReason: "stop",
      totalTokens: 5,
    },
    scope,
    source,
    trace,
  });

  const projected = observabilityIcebergProjection(fact, "2026-07-28T12:00:03.000Z", {
    sequenceNumber: "200",
    shardId: "shardId-000000000000",
    streamArn: "arn:aws:kinesis:us-east-2:123:stream/agent-observability-facts",
  });

  expect(projected.destination).toBe("model-invocations");
  expect(projected.record).toMatchObject({
    attempt_id: "attempt-1",
    duration_ms: 900,
    fact_id: fact.factId,
    requested_model_id: "openrouter/primary",
    projection_sequence_number: "200",
    projection_shard_id: "shardId-000000000000",
    cached_tokens: 2,
    input_tokens: 4,
    output_tokens: 1,
    provider_request_id: "provider-request-digest",
    source_stream_sequence_number: "100",
    stop_reason: "stop",
    total_tokens: 5,
  });
  expect(projected.record.payload_json).not.toContain("must not exist");
});

test("keeps trace agent summary fields in payload_json, not new Iceberg columns", () => {
  const fact = makeObservabilityFact({
    captureMode: "metadata-only",
    factType: "trace.finalized",
    normalizedAt: "2026-07-28T12:00:02.000Z",
    occurredAt: "2026-07-28T12:00:01.000Z",
    payload: {
      agentDeploymentId: "deployment-1",
      durationMs: 900,
      errorClass: "RateLimitError",
      outcome: "error",
      rootRunId: "run",
      runCount: 1,
      status: "finalized",
    },
    scope,
    source: { ...source, recordType: "trace" },
    trace,
  });

  const projected = observabilityIcebergProjection(fact, "2026-07-28T12:00:03.000Z");

  expect(projected.destination).toBe("traces");
  // The S3 Tables traces schema is fixed; adding columns would force table replacement.
  for (const column of ["agent_deployment_id", "duration_ms", "error_class"]) {
    expect(projected.record).not.toHaveProperty(column);
  }
  expect(JSON.parse(String(projected.record.payload_json))).toMatchObject({
    agentDeploymentId: "deployment-1",
    durationMs: 900,
    errorClass: "RateLimitError",
  });
});

test("routes deletion facts into the tombstone table", () => {
  const fact = makeObservabilityFact({
    captureMode: "metadata-only",
    factType: "record.deleted",
    normalizedAt: "2026-07-28T12:00:02.000Z",
    occurredAt: "2026-07-28T12:00:02.000Z",
    payload: { deleteThroughRecordVersion: 4, deletedFactTypes: ["span.finalized"] },
    scope,
    source,
  });

  expect(observabilityIcebergProjection(fact, fact.normalizedAt)).toMatchObject({
    destination: "tombstones",
    record: {
      delete_through_record_version: 4,
      deleted_fact_types_json: '["span.finalized"]',
      source_record_id: "record-1",
      trace_id: null,
    },
  });
});
