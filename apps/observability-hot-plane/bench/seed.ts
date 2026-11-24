/**
 * Creates the hot-plane schema with the repository's own DDL and loads a synthetic busy dev
 * install: ORGANIZATIONS organizations with a skewed share of traffic (the busiest about 14%),
 * two environments each, and about FACTS facts over the last 30 days. Each trace writes one
 * trace.finalized fact, one run span, three tool spans, and two model invocations; one in a
 * thousand traces also gets a deletion tombstone. Values derive from hashes of the row number,
 * so every run loads the same data relative to its start time.
 *
 *   bun apps/observability-hot-plane/bench/seed.ts [facts]
 */
import { ensureObservabilitySchema } from "../src/schema.ts";
import { adminExecutor } from "./executor.ts";
import { environmentId, organizationId, ORGANIZATIONS, PROJECT_ID } from "./settings.ts";

const FACTS = Number(process.argv[2] ?? 2_000_000);
const FACTS_PER_TRACE = 7;
const BATCHES = 30;
const traces = Math.floor(FACTS / FACTS_PER_TRACE);
const clickhouse = adminExecutor();

await clickhouse.execute("DROP DATABASE IF EXISTS observability SYNC");
await clickhouse.execute("CREATE DATABASE observability");
await ensureObservabilitySchema(clickhouse);

const organizations = `[${Array.from({ length: ORGANIZATIONS }, (_, index) => `'${organizationId(index)}'`).join(",")}]`;
const environments = `[${Array.from({ length: ORGANIZATIONS }, (_, index) => `['${environmentId(index, 0)}','${environmentId(index, 1)}']`).join(",")}]`;
const hash = (salt: number) => `cityHash64(trace_number, ${salt})`;
const unit = (salt: number) => `(${hash(salt)} % 1000000) / 1000000.0`;

/** One row per trace with its shared attributes; facts expand it with arrayJoin. */
const traceRows = (start: number, end: number) => `
  SELECT
    trace_number,
    toUInt32(floor(pow(${unit(1)}, 2) * ${ORGANIZATIONS})) AS org,
    ${organizations}[org + 1] AS organization_id,
    ${environments}[org + 1][if(${unit(2)} < 0.85, 1, 2)] AS environment_id,
    now64(3) - toIntervalMillisecond(toUInt64(${unit(3)} * 30 * 86400000)) AS finished_at,
    concat('trace-', toString(trace_number)) AS trace_id,
    concat('run-', toString(trace_number)) AS run_id,
    concat('session-', toString(${hash(4)} % 50000)) AS session_id,
    concat('definition-', toString(org), '-', toString(${hash(5)} % 6)) AS definition_id,
    concat('deployment-', toString(org), '-', toString(${hash(5)} % 6), '-', toString(${hash(6)} % 2)) AS deployment_id,
    concat('release-', toString(org), '-', toString(${hash(5)} % 6), '-', toString(${hash(7)} % 3)) AS release_id,
    if(${unit(8)} < 0.08, 'error', 'ok') AS outcome,
    toUInt64(200 + ${hash(9)} % 30000) AS duration_ms,
    toUInt64(500 + ${hash(10)} % 20000) AS total_tokens,
    toUInt64(${hash(11)} % 50000) AS cost_micros,
    ['openai', 'anthropic', 'google'][1 + ${hash(12)} % 3] AS provider,
    ['model-small', 'model-large', 'model-reasoning'][1 + ${hash(13)} % 3] AS model,
    repeat('x', 120 + ${hash(14)} % 200) AS padding
  FROM (SELECT number + ${start} AS trace_number FROM numbers(${end - start}))`;

const insert = (start: number, end: number) => `
INSERT INTO observability.facts
SELECT
  concat('fact-', toString(trace_number), '-', toString(slot)) AS fact_id,
  multiIf(slot = 0, 'trace.finalized', slot = 1 OR slot <= 4, 'span.finalized', slot <= 6, 'model-invocation.recorded', 'record.deleted') AS fact_type,
  1 AS schema_version,
  1 AS redaction_policy_version,
  'metadata-only' AS capture_mode,
  organization_id,
  '${PROJECT_ID}' AS project_id,
  environment_id,
  NULL AS workspace_id,
  trace_id,
  if(slot BETWEEN 1 AND 4, concat('span-', toString(trace_number), '-', toString(slot)), NULL) AS span_id,
  if(slot BETWEEN 2 AND 4, concat('span-', toString(trace_number), '-1'), NULL) AS parent_span_id,
  run_id,
  session_id,
  'execution' AS source_table,
  multiIf(slot = 0, 'trace', slot <= 4, 'span', slot <= 6, 'model-invocation', 'trace') AS source_record_type,
  if(slot = 7, concat('fact-', toString(trace_number), '-0'), concat('fact-', toString(trace_number), '-', toString(slot))) AS source_record_id,
  if(slot = 7, 1, 1) AS source_record_version,
  NULL AS source_stream_arn,
  NULL AS source_stream_sequence_number,
  finished_at - toIntervalMillisecond(if(slot = 0, 0, (7 - slot) * 500)) AS occurred_at,
  occurred_at + toIntervalMillisecond(800) AS normalized_at,
  multiIf(
    slot = 0, toJSONString(map(
      'outcome', outcome, 'rootRunId', run_id, 'runCount', '1',
      'totalTokens', toString(total_tokens), 'totalCostUsdMicros', toString(cost_micros),
      'durationMs', toString(duration_ms), 'agentDefinitionId', definition_id,
      'agentDeploymentId', deployment_id, 'agentReleaseId', release_id,
      'executionPurpose', 'customer', 'trigger', 'api',
      'errorClass', if(outcome = 'error', 'ProviderError', ''), 'notes', padding)),
    slot = 1, toJSONString(map('kind', 'run', 'name', 'agent.run', 'status', outcome,
      'durationMs', toString(duration_ms), 'agentDeploymentId', deployment_id, 'notes', padding)),
    slot <= 4, toJSONString(map('kind', 'tool',
      'name', ['search', 'fetch', 'write_file', 'read_file', 'shell', 'browser', 'sql', 'email'][1 + cityHash64(trace_number, slot) % 8],
      'status', if(cityHash64(trace_number, slot, 1) % 20 = 0, 'error', 'ok'),
      'durationMs', toString(cityHash64(trace_number, slot, 2) % 5000), 'notes', padding)),
    slot <= 6, toJSONString(map('actualProvider', provider, 'actualModelId', model,
      'requestedProvider', provider, 'requestedModelId', model,
      'status', if(cityHash64(trace_number, slot, 3) % 25 = 0, 'error', 'ok'),
      'inputTokens', toString(intDiv(total_tokens, 3)), 'outputTokens', toString(intDiv(total_tokens, 6)),
      'cachedTokens', toString(intDiv(total_tokens, 10)), 'totalTokens', toString(intDiv(total_tokens, 2)),
      'costUsdMicros', toString(intDiv(cost_micros, 2)),
      'durationMs', toString(cityHash64(trace_number, slot, 4) % 8000), 'notes', padding)),
    '{"deleteThroughRecordVersion":1,"deletedFactTypes":["trace.finalized"]}'
  ) AS payload_json,
  concat('shardId-00000000000', toString(trace_number % 2)) AS ingestion_shard_id,
  toString(trace_number * 8 + slot) AS ingestion_sequence_number,
  normalized_at AS ingested_at
FROM (${traceRows(start, end)})
ARRAY JOIN if(trace_number % 1000 = 999, [0, 1, 2, 3, 4, 5, 6, 7], [0, 1, 2, 3, 4, 5, 6]) AS slot`;

const started = performance.now();
for (let batch = 0; batch < BATCHES; batch += 1) {
  const start = Math.floor((traces * batch) / BATCHES);
  const end = Math.floor((traces * (batch + 1)) / BATCHES);
  await clickhouse.execute(insert(start, end));
}
await clickhouse.execute("OPTIMIZE TABLE observability.facts FINAL");
const [summary] = await clickhouse.query<{ facts: string; parts: string; bytes: string }>(
  `SELECT toString(sum(rows)) AS facts, toString(count()) AS parts,
          formatReadableSize(sum(data_compressed_bytes)) AS bytes
   FROM system.parts WHERE database = 'observability' AND table = 'facts' AND active`,
);
console.log(
  `Loaded ${summary?.facts} facts (${traces} traces) in ${summary?.parts} parts, ${summary?.bytes} compressed, in ${((performance.now() - started) / 1000).toFixed(1)} s.`,
);
