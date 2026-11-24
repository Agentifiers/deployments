import { HOT_PLANE_RETENTION_DAYS } from "@deployments-ai/observability";
import type { ClickHouseExecutor } from "./clickhouse.ts";

export const OBSERVABILITY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS observability.facts
(
  fact_id String,
  fact_type LowCardinality(String),
  schema_version UInt16,
  redaction_policy_version UInt16,
  capture_mode LowCardinality(String),
  organization_id String,
  project_id String,
  environment_id String,
  workspace_id Nullable(String),
  trace_id Nullable(String),
  span_id Nullable(String),
  parent_span_id Nullable(String),
  run_id Nullable(String),
  session_id Nullable(String),
  source_table LowCardinality(String),
  source_record_type LowCardinality(String),
  source_record_id String,
  source_record_version UInt64,
  source_stream_arn Nullable(String),
  source_stream_sequence_number Nullable(String),
  occurred_at DateTime64(3, 'UTC'),
  normalized_at DateTime64(3, 'UTC'),
  payload_json String,
  ingestion_shard_id String,
  ingestion_sequence_number String,
  ingested_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(source_record_version)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (organization_id, environment_id, fact_type, occurred_at, source_record_id, fact_id)
TTL occurred_at + toIntervalDay(if(
  fact_type IN ('trace.finalized', 'record.deleted')
  OR (fact_type = 'span.finalized' AND JSONExtractString(payload_json, 'kind') = 'run'),
  ${HOT_PLANE_RETENTION_DAYS.trace},
  ${HOT_PLANE_RETENTION_DAYS.span}
)) DELETE
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS observability.runtime_generation
(
  generation String,
  established_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(established_at)
ORDER BY tuple();

CREATE VIEW IF NOT EXISTS observability.latest_facts AS
SELECT * EXCEPT delivery_rank
FROM
(
  SELECT *, row_number() OVER (
    PARTITION BY organization_id, project_id, environment_id,
                 source_table, source_record_type, source_record_id, fact_type
    ORDER BY source_record_version DESC, normalized_at DESC, ingested_at DESC
  ) AS delivery_rank
  FROM observability.facts
)
WHERE delivery_rank = 1;

CREATE VIEW IF NOT EXISTS observability.active_facts AS
SELECT facts.*
FROM observability.latest_facts AS facts
LEFT JOIN
(
  SELECT organization_id, project_id, environment_id,
         source_table, source_record_type, source_record_id,
         max(toUInt64(JSONExtractInt(payload_json, 'deleteThroughRecordVersion'))) AS delete_through,
         arrayDistinct(arrayFlatten(groupArray(JSONExtract(payload_json, 'deletedFactTypes', 'Array(String)')))) AS deleted_types
  FROM observability.latest_facts
  WHERE fact_type = 'record.deleted'
  GROUP BY organization_id, project_id, environment_id,
           source_table, source_record_type, source_record_id
) AS tombstones
ON tombstones.organization_id = facts.organization_id
 AND tombstones.project_id = facts.project_id
 AND tombstones.environment_id = facts.environment_id
 AND tombstones.source_table = facts.source_table
 AND tombstones.source_record_type = facts.source_record_type
 AND tombstones.source_record_id = facts.source_record_id
WHERE facts.fact_type != 'record.deleted'
  AND (
    tombstones.source_record_id IS NULL
    OR facts.source_record_version > tombstones.delete_through
    OR NOT has(tombstones.deleted_types, facts.fact_type)
  );
`;

export async function ensureObservabilitySchema(executor: ClickHouseExecutor) {
  const statements = OBSERVABILITY_SCHEMA_SQL.split(/;\s*(?:\n|$)/u)
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await executor.execute(statement);
}

export async function ensureObservabilitySchemaWithRetry(
  executor: ClickHouseExecutor,
  options: {
    readonly attempts?: number;
    readonly signal: AbortSignal;
    readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  },
) {
  const attempts = options.attempts ?? 180;
  const wait = options.wait ?? retryDelay;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts && !options.signal.aborted; attempt += 1) {
    try {
      await ensureObservabilitySchema(executor);
      return;
    } catch (cause) {
      lastError = cause;
      if (attempt + 1 < attempts) await wait(10_000, options.signal);
    }
  }
  if (options.signal.aborted) throw new Error("ClickHouse schema initialization was aborted.");
  throw new Error(`ClickHouse schema initialization failed after ${attempts} attempts.`, {
    cause: lastError,
  });
}

function retryDelay(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
