import {
  activeFactsSql,
  canonicalResultTimestamp,
  canonicalTimestamp,
  identifier,
  MAX_LOOKBACK_DAYS,
  QueryProblem,
  scope,
  scopeSql,
  SPAN_RETENTION_DAYS,
  TRACE_RETENTION_DAYS,
} from "./api-query.ts";
import type { ClickHouseExecutor } from "./clickhouse.ts";

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_MS = DAY_MS;
/** Grouped hourly series stay at most 169 buckets x MAX_METRIC_GROUPS rows. */
const MAX_GROUPED_HOURLY_DAYS = 7;
const MAX_METRIC_GROUPS = 20;
const MAX_TOOL_ROWS = 100;

const WINDOW_SQL =
  "occurred_at >= parseDateTime64BestEffort({from:String}, 3) AND occurred_at < parseDateTime64BestEffort({to:String}, 3)";

const RUNS_FINISHED_SQL = "occurred_at >= parseDateTime64BestEffort({from:String}, 3)";

const BUCKETS = {
  day: "toStartOfDay(occurred_at)",
  hour: "toStartOfHour(occurred_at)",
} as const;
type MetricInterval = keyof typeof BUCKETS;

const fieldText = (field: string) => `JSONExtractString(payload_json, '${field}')`;
const fieldNumber = (field: string) => `toFloat64(JSONExtractUInt(payload_json, '${field}'))`;
const preferActual = (actual: string, requested: string) =>
  `if(${fieldText(actual)} != '', ${fieldText(actual)}, ${fieldText(requested)})`;

/**
 * Agent dimensions aggregate finalized trace facts (90-day retention); model and provider
 * aggregate model-invocation facts (30-day retention), preferring the provider-confirmed model.
 */
const GROUPS = {
  agentDefinitionId: { expression: fieldText("agentDefinitionId"), source: "traces" },
  agentDeploymentId: { expression: fieldText("agentDeploymentId"), source: "traces" },
  agentReleaseId: { expression: fieldText("agentReleaseId"), source: "traces" },
  model: {
    expression: preferActual("actualModelId", "requestedModelId"),
    source: "model-invocations",
  },
  provider: {
    expression: preferActual("actualProvider", "requestedProvider"),
    source: "model-invocations",
  },
} as const;
type MetricGroup = keyof typeof GROUPS;

const SOURCES = {
  "model-invocations": {
    factType: "model-invocation.recorded",
    metrics: `toFloat64(count()) AS invocation_count,
      toFloat64(countIf(${fieldText("status")} = 'error')) AS error_count,
      toFloat64(sum(JSONExtractUInt(payload_json, 'inputTokens'))) AS input_tokens,
      toFloat64(sum(JSONExtractUInt(payload_json, 'outputTokens'))) AS output_tokens,
      toFloat64(sum(JSONExtractUInt(payload_json, 'cachedTokens'))) AS cached_tokens,
      toFloat64(sum(JSONExtractUInt(payload_json, 'totalTokens'))) AS total_tokens,
      toFloat64(sum(JSONExtractUInt(payload_json, 'costUsdMicros'))) AS total_cost_usd_micros,
      quantile(0.5)(${fieldNumber("durationMs")}) AS p50_latency_ms,
      quantile(0.95)(${fieldNumber("durationMs")}) AS p95_latency_ms`,
    columns:
      "invocation_count, error_count, input_tokens, output_tokens, cached_tokens, total_tokens, total_cost_usd_micros, p50_latency_ms, p95_latency_ms",
    retentionDays: SPAN_RETENTION_DAYS,
    volume: "invocation_count",
  },
  traces: {
    factType: "trace.finalized",
    // Traces finalized before durationMs existed are excluded from the percentiles only.
    metrics: `toFloat64(count()) AS trace_count,
      toFloat64(countIf(${fieldText("outcome")} = 'error')) AS error_count,
      toFloat64(sum(JSONExtractUInt(payload_json, 'totalTokens'))) AS total_tokens,
      toFloat64(sum(JSONExtractUInt(payload_json, 'totalCostUsdMicros'))) AS total_cost_usd_micros,
      if(countIf(JSONHas(payload_json, 'durationMs')) = 0, NULL,
         quantileIf(0.5)(${fieldNumber("durationMs")}, JSONHas(payload_json, 'durationMs'))) AS p50_duration_ms,
      if(countIf(JSONHas(payload_json, 'durationMs')) = 0, NULL,
         quantileIf(0.95)(${fieldNumber("durationMs")}, JSONHas(payload_json, 'durationMs'))) AS p95_duration_ms`,
    columns:
      "trace_count, error_count, total_tokens, total_cost_usd_micros, p50_duration_ms, p95_duration_ms",
    retentionDays: TRACE_RETENTION_DAYS,
    volume: "trace_count",
  },
} as const;

function window(url: URL, now: Date, retentionDays: number, maximumDays: number) {
  const to = canonicalTimestamp(url.searchParams.get("to"), "to") ?? now.toISOString();
  const from =
    canonicalTimestamp(url.searchParams.get("from"), "from") ??
    new Date(Date.parse(to) - DEFAULT_WINDOW_MS).toISOString();
  if (
    Date.parse(to) <= Date.parse(from) ||
    Date.parse(to) - Date.parse(from) > maximumDays * DAY_MS ||
    Date.parse(from) < now.getTime() - retentionDays * DAY_MS
  ) {
    throw new QueryProblem(
      400,
      "invalid_time_range",
      `The time range must be positive, no longer than ${maximumDays} days, and inside the ${retentionDays}-day retention window.`,
    );
  }
  return { from, to };
}

function choice<const Values extends Readonly<Record<string, unknown>>>(
  value: string | null,
  values: Values,
  name: string,
): (keyof Values & string) | undefined {
  if (value === null) return undefined;
  if (!Object.hasOwn(values, value)) {
    throw new QueryProblem(
      400,
      `invalid_${name}`,
      `${name} must be one of ${Object.keys(values).join(", ")}.`,
    );
  }
  return value as keyof Values & string;
}

/**
 * Bucketed metrics over `[from, to)`, optionally of one agent deployment. Grouped series keep the
 * MAX_METRIC_GROUPS groups with the most traces or invocations in the whole window, ranked once
 * so every bucket shows the same set.
 */
export async function metricSeries(clickhouse: ClickHouseExecutor, request: Request, now: Date) {
  const url = new URL(request.url);
  const interval: MetricInterval =
    choice(url.searchParams.get("interval"), BUCKETS, "interval") ?? "hour";
  const groupBy: MetricGroup | undefined = choice(
    url.searchParams.get("groupBy"),
    GROUPS,
    "groupBy",
  );
  const sourceName = groupBy ? GROUPS[groupBy].source : "traces";
  const source = SOURCES[sourceName];
  const range = window(
    url,
    now,
    source.retentionDays,
    groupBy && interval === "hour" ? MAX_GROUPED_HOURLY_DAYS : MAX_LOOKBACK_DAYS,
  );
  const agentDeploymentId = identifier(
    url.searchParams.get("agentDeploymentId"),
    "agent_deployment_id",
  );
  const queryScope = scopeSql(scope(request));
  const rows = await clickhouse.query(
    `SELECT bucket, group_value, ${source.columns}
     FROM (
       SELECT *, dense_rank() OVER (ORDER BY group_total DESC, group_value ASC) AS group_rank
       FROM (
         SELECT *, sum(${source.volume}) OVER (PARTITION BY group_value) AS group_total
         FROM (
           SELECT ${BUCKETS[interval]} AS bucket,
                  ${groupBy ? GROUPS[groupBy].expression : "''"} AS group_value,
                  ${source.metrics}
           FROM ${activeFactsSql({
             factTypes: [source.factType],
             occurredSql: WINDOW_SQL,
             tenantSql: queryScope.partitionSql,
           })}
           WHERE fact_type = '${source.factType}' AND ${queryScope.sql} AND ${WINDOW_SQL}
             ${agentDeploymentId ? `AND ${fieldText("agentDeploymentId")} = {agent_deployment_id:String}` : ""}
           GROUP BY bucket, group_value
         )
       )
     )
     WHERE group_rank <= {group_limit:UInt32}
     ORDER BY bucket ASC, group_rank ASC`,
    {
      ...queryScope.parameters,
      ...range,
      ...(agentDeploymentId ? { agent_deployment_id: agentDeploymentId } : {}),
      group_limit: String(groupBy ? MAX_METRIC_GROUPS : 1),
    },
  );
  return {
    ...range,
    ...(groupBy ? { groupBy } : {}),
    interval,
    items: rows.map(({ bucket, group_value: groupValue, ...metrics }) => ({
      bucket: canonicalResultTimestamp(bucket),
      ...(groupBy && typeof groupValue === "string" && groupValue !== ""
        ? { group_value: groupValue }
        : {}),
      ...metrics,
    })),
    source: sourceName,
  };
}

/**
 * Tool calls over `[from, to)`. Tool spans carry no deployment, so the deployment filter keeps
 * spans whose run finished as that deployment's run at or after `from` (runs end after their
 * tool calls); tool calls of runs still in flight are counted once the run finishes.
 */
export async function toolMetrics(clickhouse: ClickHouseExecutor, request: Request, now: Date) {
  const url = new URL(request.url);
  const range = window(url, now, SPAN_RETENTION_DAYS, MAX_LOOKBACK_DAYS);
  const agentDeploymentId = identifier(
    url.searchParams.get("agentDeploymentId"),
    "agent_deployment_id",
  );
  const queryScope = scopeSql(scope(request));
  const rows = await clickhouse.query(
    `SELECT ${fieldText("name")} AS name,
            toFloat64(count()) AS calls,
            toFloat64(countIf(${fieldText("status")} = 'error')) AS errors,
            quantile(0.95)(JSONExtractUInt(payload_json, 'durationMs')) AS p95_duration_ms
     FROM ${activeFactsSql({
       factTypes: ["span.finalized"],
       occurredSql: WINDOW_SQL,
       tenantSql: queryScope.partitionSql,
     })}
     WHERE fact_type = 'span.finalized' AND ${queryScope.sql}
       AND ${fieldText("kind")} = 'tool' AND ${WINDOW_SQL}
       ${
         agentDeploymentId
           ? `AND run_id IN (
         SELECT run_id
         FROM ${activeFactsSql({
           factTypes: ["span.finalized"],
           occurredSql: RUNS_FINISHED_SQL,
           tenantSql: queryScope.partitionSql,
         })}
         WHERE fact_type = 'span.finalized' AND ${queryScope.sql}
           AND ${fieldText("kind")} = 'run'
           AND ${fieldText("agentDeploymentId")} = {agent_deployment_id:String}
           AND ${RUNS_FINISHED_SQL}
       )`
           : ""
       }
     GROUP BY name ORDER BY calls DESC, name ASC LIMIT ${MAX_TOOL_ROWS}`,
    {
      ...queryScope.parameters,
      ...range,
      ...(agentDeploymentId ? { agent_deployment_id: agentDeploymentId } : {}),
    },
  );
  return { ...range, items: rows };
}
