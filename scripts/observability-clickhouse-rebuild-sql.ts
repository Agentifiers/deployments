import { safe } from "./observability-clickhouse-rebuild-support.ts";

function rebuildSource(prefix: string) {
  const safePrefix = safe(prefix, "rebuild prefix");
  if (!safePrefix.startsWith("rebuild/") || safePrefix.length <= 8) {
    throw new Error("Rebuild prefix must be below the rebuild/ namespace.");
  }
  return `s3(observability_rebuild, filename = '${safePrefix.slice(8)}*')`;
}

export function importSql(bucket: string, prefix: string, generation: string) {
  safe(bucket, "backup bucket");
  const safeGeneration = safe(generation, "ClickHouse generation");
  const source = rebuildSource(prefix);
  return `DROP TABLE IF EXISTS observability.facts_rebuild SYNC;
CREATE TABLE observability.facts_rebuild AS observability.facts;
INSERT INTO observability.facts_rebuild
  (fact_id, fact_type, schema_version, redaction_policy_version, capture_mode,
   organization_id, project_id, environment_id, workspace_id,
   trace_id, span_id, parent_span_id, run_id, session_id,
   source_table, source_record_type, source_record_id, source_record_version,
   source_stream_arn, source_stream_sequence_number,
   occurred_at, normalized_at, ingested_at, payload_json,
   ingestion_shard_id, ingestion_sequence_number)
SELECT fact_id, fact_type, schema_version, redaction_policy_version, capture_mode,
       organization_id, project_id, environment_id, workspace_id,
       trace_id, span_id, parent_span_id, run_id, session_id,
       source_table, source_record_type, source_record_id, source_record_version,
       source_stream_arn, source_stream_sequence_number,
       parseDateTime64BestEffort(occurred_at, 3, 'UTC'),
       parseDateTime64BestEffort(normalized_at, 3, 'UTC'),
       parseDateTime64BestEffort(projected_at, 3, 'UTC'), payload_json,
       coalesce(projection_shard_id, ''), coalesce(projection_sequence_number, '')
FROM ${source};
OPTIMIZE TABLE observability.facts_rebuild FINAL;
EXCHANGE TABLES observability.facts AND observability.facts_rebuild;
DROP TABLE observability.facts_rebuild SYNC;
INSERT INTO observability.runtime_generation (generation, established_at)
VALUES ('${safeGeneration}', now64(3));`;
}

export function exportWatermarkSql(bucket: string, prefix: string) {
  safe(bucket, "backup bucket");
  const source = rebuildSource(prefix);
  return `SELECT fact_family, projection_stream_arn, projection_shard_id,
       argMax(
         projection_sequence_number,
         tuple(length(projection_sequence_number), projection_sequence_number)
       ) AS projection_sequence_watermark
FROM ${source}
WHERE projection_stream_arn IS NOT NULL
  AND projection_shard_id IS NOT NULL
  AND projection_sequence_number IS NOT NULL
GROUP BY fact_family, projection_stream_arn, projection_shard_id
ORDER BY fact_family, projection_stream_arn, projection_shard_id`;
}

export function targetReconciliationSql(bucket: string, prefix: string) {
  safe(bucket, "backup bucket");
  const source = rebuildSource(prefix);
  return `WITH
source_facts AS (
  SELECT fact_id, fact_type, normalized_at, payload_json
  FROM ${source}
  WHERE parseDateTime64BestEffort(occurred_at, 3, 'UTC') >= now() -
    toIntervalDay(if(
      fact_type IN ('trace.finalized', 'record.deleted')
      OR (fact_type = 'span.finalized' AND JSONExtractString(payload_json, 'kind') = 'run'),
      90,
      30
    ))
),
target_facts AS (
  SELECT fact_id, 1 AS present,
         argMax(payload_json, tuple(source_record_version, normalized_at)) AS target_payload_json,
         max(normalized_at) AS target_normalized_at
  FROM observability.facts
  GROUP BY fact_id
)
SELECT toFloat64(count()) AS source_count,
       toFloat64(countIf(target_facts.present = 1)) AS target_count,
       toFloat64(countIf(target_facts.present = 0)) AS missing_count,
       toFloat64(countIf(target_facts.present = 1 AND source_facts.payload_json != target_facts.target_payload_json)) AS payload_mismatch_count,
       toFloat64(sumIf(JSONExtractUInt(source_facts.payload_json, 'totalTokens'), source_facts.fact_type = 'trace.finalized')) AS source_trace_tokens,
       toFloat64(sumIf(JSONExtractUInt(target_facts.target_payload_json, 'totalTokens'), source_facts.fact_type = 'trace.finalized' AND target_facts.present = 1)) AS target_trace_tokens,
       toFloat64(sumIf(JSONExtractUInt(source_facts.payload_json, 'totalCostUsdMicros'), source_facts.fact_type = 'trace.finalized')) AS source_trace_cost,
       toFloat64(sumIf(JSONExtractUInt(target_facts.target_payload_json, 'totalCostUsdMicros'), source_facts.fact_type = 'trace.finalized' AND target_facts.present = 1)) AS target_trace_cost,
       toFloat64(toUnixTimestamp64Milli(max(parseDateTime64BestEffort(source_facts.normalized_at, 3, 'UTC')))) AS source_normalized_watermark,
       toFloat64(toUnixTimestamp64Milli(max(target_facts.target_normalized_at))) AS target_normalized_watermark
FROM source_facts
LEFT JOIN target_facts USING fact_id`;
}

export interface TargetReconciliation {
  readonly missing_count: number;
  readonly payload_mismatch_count: number;
  readonly source_count: number;
  readonly source_normalized_watermark: number;
  readonly source_trace_cost: number;
  readonly source_trace_tokens: number;
  readonly target_count: number;
  readonly target_normalized_watermark: number;
  readonly target_trace_cost: number;
  readonly target_trace_tokens: number;
}

export function targetReconciliationSucceeded(result: TargetReconciliation) {
  return (
    result.source_count === result.target_count &&
    result.missing_count === 0 &&
    result.payload_mismatch_count === 0 &&
    result.source_trace_tokens === result.target_trace_tokens &&
    result.source_trace_cost === result.target_trace_cost &&
    result.source_normalized_watermark === result.target_normalized_watermark
  );
}

export function unloadSql(rebuildQuery: string, bucket: string, prefix: string) {
  return `UNLOAD (${rebuildQuery.replace(/;$/u, "")}) TO 's3://${safe(bucket, "backup bucket")}/${safe(prefix, "rebuild prefix")}' WITH (format = 'PARQUET', compression = 'SNAPPY')`;
}
