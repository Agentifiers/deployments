import { parseObservabilityFact, type ObservabilityFact } from "@deployments-ai/observability";

export interface IngestionSource {
  readonly sequenceNumber: string;
  readonly shardId: string;
}

const CLICKHOUSE_DATETIME64_MIN = Date.UTC(1900, 0, 1);
const CLICKHOUSE_DATETIME64_MAX_EXCLUSIVE = Date.UTC(2300, 0, 1);

function clickhouseTimestamp(value: string) {
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    timestamp < CLICKHOUSE_DATETIME64_MIN ||
    timestamp >= CLICKHOUSE_DATETIME64_MAX_EXCLUSIVE
  ) {
    throw new TypeError("Fact timestamp is outside the ClickHouse DateTime64(3) range.");
  }
  return new Date(timestamp).toISOString().replace("T", " ").replace(/Z$/u, "");
}

export function hotFactRow(value: unknown, source: IngestionSource, ingestedAt: Date) {
  const fact = parseObservabilityFact(value);
  if (!Number.isSafeInteger(fact.source.recordVersion) || fact.source.recordVersion < 0) {
    throw new TypeError("Fact source record version is not a non-negative safe integer.");
  }
  return {
    capture_mode: fact.captureMode,
    environment_id: fact.scope.environmentId,
    fact_id: fact.factId,
    fact_type: fact.factType,
    ingested_at: clickhouseTimestamp(ingestedAt.toISOString()),
    ingestion_sequence_number: source.sequenceNumber,
    ingestion_shard_id: source.shardId,
    normalized_at: clickhouseTimestamp(fact.normalizedAt),
    occurred_at: clickhouseTimestamp(fact.occurredAt),
    organization_id: fact.scope.organizationId,
    parent_span_id: fact.trace?.parentSpanId ?? null,
    payload_json: JSON.stringify(fact.payload),
    project_id: fact.scope.projectId,
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

export function decodeKinesisFact(data: Uint8Array): ObservabilityFact {
  return parseObservabilityFact(JSON.parse(new TextDecoder().decode(data)) as unknown);
}
