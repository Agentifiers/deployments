import { createHmac, timingSafeEqual } from "node:crypto";
import {
  HOT_PLANE_RETENTION_DAYS,
  type ObservabilityFactType,
} from "@deployments-ai/observability";

const DEFAULT_MAX_LIMIT = 100;
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,160}$/u;
const SEQUENCE_NUMBER = /^\d{1,256}$/u;
const MAX_SNAPSHOT_SHARDS = 64;

export const MAX_LOOKBACK_DAYS = 31;
export const SPAN_RETENTION_DAYS = HOT_PLANE_RETENTION_DAYS.span;
export const TRACE_RETENTION_DAYS = HOT_PLANE_RETENTION_DAYS.trace;

/** Trace list filters; each is bound into the pagination cursor under its query name. */
const TRACE_FILTER_NAMES = [
  "agentDefinitionId",
  "agentDeploymentId",
  "agentReleaseId",
  "errorClass",
  "executionPurpose",
  "status",
] as const;
export type TraceFilterName = (typeof TRACE_FILTER_NAMES)[number];
export type TraceFilters = Partial<Readonly<Record<TraceFilterName, string>>>;

export interface IngestionWatermark {
  readonly sequenceNumber: string;
  readonly shardId: string;
}

export interface PageCursor extends TraceFilters {
  readonly environmentId?: string;
  readonly factId: string;
  readonly from: string;
  readonly occurredAt: string;
  readonly organizationId: string;
  readonly projectId?: string;
  readonly route: string;
  readonly snapshotAt: string;
  readonly snapshotWatermarks: readonly IngestionWatermark[];
  readonly to: string;
  readonly workspaceId?: string;
}

export interface SpanCursor {
  readonly environmentId?: string;
  readonly factId: string;
  readonly occurredAt: string;
  readonly organizationId: string;
  readonly projectId?: string;
  readonly spanId: string;
  readonly snapshotAt: string;
  readonly snapshotWatermarks: readonly IngestionWatermark[];
  readonly traceId: string;
  readonly workspaceId?: string;
}

export interface QueryScope {
  readonly environmentId?: string;
  readonly organizationId: string;
  readonly projectId?: string;
  readonly workspaceId?: string;
}

export class QueryProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function equalSecret(actual: string | undefined, expected: string) {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function identifier(value: string | null, name: string, required = false) {
  if (value === null) {
    if (required) throw new QueryProblem(400, `missing_${name}`, `${name} is required.`);
    return undefined;
  }
  if (!IDENTIFIER.test(value)) {
    throw new QueryProblem(400, `invalid_${name}`, `${name} is invalid.`);
  }
  return value;
}

export function canonicalTimestamp(value: string | null, name: string) {
  if (value === null) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw new QueryProblem(400, `invalid_${name}`, `${name} must be an RFC 3339 timestamp.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new QueryProblem(400, `invalid_${name}`, `${name} must be an RFC 3339 timestamp.`);
  }
  return new Date(milliseconds).toISOString();
}

export function limit(value: string | null, maximum = DEFAULT_MAX_LIMIT) {
  if (value === null) return Math.min(50, maximum);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new QueryProblem(
      400,
      "invalid_limit",
      `limit must be an integer from 1 through ${maximum}.`,
    );
  }
  return parsed;
}

export function encodeSignedCursor(cursor: PageCursor | SpanCursor, secret: string) {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function decodeSignedCursor(value: string, secret: string) {
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) throw new Error("invalid cursor envelope");
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!equalSecret(signature, expected)) throw new Error("invalid cursor signature");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
}

function validWatermarks(value: unknown): value is readonly IngestionWatermark[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SNAPSHOT_SHARDS) {
    return false;
  }
  const shards = new Set<string>();
  return value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Readonly<Record<string, unknown>>;
    if (
      typeof record.shardId !== "string" ||
      !IDENTIFIER.test(record.shardId) ||
      typeof record.sequenceNumber !== "string" ||
      !SEQUENCE_NUMBER.test(record.sequenceNumber) ||
      shards.has(record.shardId)
    ) {
      return false;
    }
    shards.add(record.shardId);
    return true;
  });
}

export function ingestionWatermarks(
  rows: readonly Readonly<Record<string, unknown>>[],
): readonly IngestionWatermark[] {
  if (rows.length === 0) return [];
  const watermarks = rows.map((row) => ({
    sequenceNumber: row.ingestion_sequence_number,
    shardId: row.ingestion_shard_id,
  }));
  if (!validWatermarks(watermarks)) {
    throw new TypeError("ClickHouse returned invalid ingestion watermarks.");
  }
  return watermarks;
}

export function ingestionWatermarkFence(watermarks: readonly IngestionWatermark[]) {
  if (!validWatermarks(watermarks)) {
    throw new TypeError("Snapshot ingestion watermarks are invalid.");
  }
  const parameters: Record<string, string> = {};
  const predicates = watermarks.map((watermark, index) => {
    parameters[`snapshot_sequence_${index}`] = watermark.sequenceNumber;
    parameters[`snapshot_shard_${index}`] = watermark.shardId;
    return `(ingestion_shard_id = {snapshot_shard_${index}:String} AND toUInt256(ingestion_sequence_number) <= {snapshot_sequence_${index}:UInt256})`;
  });
  return { parameters, sql: `(${predicates.join(" OR ")})` } as const;
}

export function decodeCursor(value: string | null, secret: string): PageCursor | undefined {
  if (value === null) return undefined;
  try {
    const decoded = decodeSignedCursor(value, secret);
    if (
      !decoded ||
      typeof decoded !== "object" ||
      !("factId" in decoded) ||
      !("from" in decoded) ||
      !("occurredAt" in decoded) ||
      !("organizationId" in decoded) ||
      !("route" in decoded) ||
      !("snapshotAt" in decoded) ||
      !("snapshotWatermarks" in decoded) ||
      !("to" in decoded) ||
      typeof decoded.factId !== "string" ||
      typeof decoded.from !== "string" ||
      typeof decoded.occurredAt !== "string" ||
      typeof decoded.organizationId !== "string" ||
      typeof decoded.route !== "string" ||
      typeof decoded.snapshotAt !== "string" ||
      !validWatermarks(decoded.snapshotWatermarks) ||
      typeof decoded.to !== "string" ||
      ("environmentId" in decoded &&
        decoded.environmentId !== undefined &&
        typeof decoded.environmentId !== "string") ||
      ("projectId" in decoded &&
        decoded.projectId !== undefined &&
        typeof decoded.projectId !== "string") ||
      TRACE_FILTER_NAMES.some(
        (name) =>
          !["string", "undefined"].includes(
            typeof (decoded as Readonly<Record<string, unknown>>)[name],
          ),
      ) ||
      ("workspaceId" in decoded &&
        decoded.workspaceId !== undefined &&
        typeof decoded.workspaceId !== "string")
    ) {
      throw new Error("invalid cursor body");
    }
    if (!Number.isFinite(Date.parse(decoded.occurredAt))) {
      throw new Error("invalid cursor timestamp");
    }
    canonicalTimestamp(decoded.from, "cursor_from");
    canonicalTimestamp(decoded.snapshotAt, "cursor_snapshot");
    canonicalTimestamp(decoded.to, "cursor_to");
    identifier(decoded.factId, "cursor_fact_id", true);
    identifier(decoded.organizationId, "cursor_organization", true);
    return decoded as PageCursor;
  } catch (cause) {
    throw new QueryProblem(
      400,
      "invalid_cursor",
      cause instanceof Error ? `cursor is invalid: ${cause.message}` : "cursor is invalid.",
    );
  }
}

export function decodeSpanCursor(
  value: string | null,
  secret: string,
  scope_: QueryScope,
  traceId: string,
): SpanCursor | undefined {
  if (value === null) return undefined;
  try {
    const decoded = decodeSignedCursor(value, secret);
    if (
      !decoded ||
      typeof decoded !== "object" ||
      !("factId" in decoded) ||
      !("occurredAt" in decoded) ||
      !("organizationId" in decoded) ||
      !("spanId" in decoded) ||
      !("snapshotAt" in decoded) ||
      !("snapshotWatermarks" in decoded) ||
      !("traceId" in decoded) ||
      typeof decoded.factId !== "string" ||
      typeof decoded.occurredAt !== "string" ||
      typeof decoded.organizationId !== "string" ||
      typeof decoded.spanId !== "string" ||
      typeof decoded.snapshotAt !== "string" ||
      !validWatermarks(decoded.snapshotWatermarks) ||
      typeof decoded.traceId !== "string" ||
      ("environmentId" in decoded &&
        decoded.environmentId !== undefined &&
        typeof decoded.environmentId !== "string") ||
      ("projectId" in decoded &&
        decoded.projectId !== undefined &&
        typeof decoded.projectId !== "string") ||
      ("workspaceId" in decoded &&
        decoded.workspaceId !== undefined &&
        typeof decoded.workspaceId !== "string")
    ) {
      throw new Error("invalid span cursor body");
    }
    const projectId = "projectId" in decoded ? decoded.projectId : undefined;
    const environmentId = "environmentId" in decoded ? decoded.environmentId : undefined;
    const workspaceId = "workspaceId" in decoded ? decoded.workspaceId : undefined;
    if (
      decoded.organizationId !== scope_.organizationId ||
      projectId !== scope_.projectId ||
      environmentId !== scope_.environmentId ||
      workspaceId !== scope_.workspaceId ||
      decoded.traceId !== traceId
    ) {
      throw new Error("span cursor does not belong to this query");
    }
    if (!Number.isFinite(Date.parse(decoded.occurredAt))) {
      throw new Error("invalid span cursor timestamp");
    }
    canonicalTimestamp(decoded.snapshotAt, "cursor_snapshot");
    identifier(decoded.factId, "cursor_fact_id", true);
    identifier(decoded.spanId, "cursor_span_id", true);
    return decoded as SpanCursor;
  } catch (cause) {
    throw new QueryProblem(
      400,
      "invalid_cursor",
      cause instanceof Error ? `cursor is invalid: ${cause.message}` : "cursor is invalid.",
    );
  }
}

export function metadataRow(row: Readonly<Record<string, unknown>>) {
  const {
    capture_mode: _captureMode,
    completed_at: completedAt,
    finalized_at: finalizedAt,
    normalized_at: _normalizedAt,
    occurred_at: occurredAt,
    payload_json: _payload,
    ...rest
  } = row;
  return {
    ...rest,
    ...(typeof completedAt === "string" && completedAt
      ? { completed_at: canonicalResultTimestamp(completedAt) }
      : {}),
    ...(typeof finalizedAt === "string" && finalizedAt
      ? { finalized_at: canonicalResultTimestamp(finalizedAt) }
      : {}),
    ...(occurredAt === undefined ? {} : { occurred_at: canonicalResultTimestamp(occurredAt) }),
  };
}

export function canonicalResultTimestamp(value: unknown) {
  if (typeof value !== "string") throw new TypeError("ClickHouse returned a non-string timestamp.");
  const timestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(timestamp)) {
    throw new TypeError("ClickHouse returned a non-RFC-3339 timestamp.");
  }
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds))
    throw new TypeError("ClickHouse returned an invalid timestamp.");
  return new Date(milliseconds).toISOString();
}

export function problem(cause: unknown) {
  const error = cause instanceof QueryProblem ? cause : undefined;
  const status = error?.status ?? 500;
  return Response.json(
    {
      code: error?.code ?? "hot_query_failed",
      detail: error?.message ?? "The observability hot query failed.",
      status,
      title: status < 500 ? "Invalid observability query" : "Observability query failed",
    },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

export function scope(request: Request): QueryScope {
  const environmentId = identifier(
    request.headers.get("x-deployments-environment"),
    "environment_id",
  );
  const projectId = identifier(request.headers.get("x-deployments-project"), "project_id");
  const workspaceId = identifier(request.headers.get("x-deployments-workspace"), "workspace_id");
  return {
    organizationId: identifier(
      request.headers.get("x-deployments-organization"),
      "organization_id",
      true,
    )!,
    ...(environmentId ? { environmentId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
}

export function scopeSql(input: QueryScope) {
  const partition = [
    "organization_id = {organization:String}",
    ...(input.projectId ? ["project_id = {project:String}"] : []),
    ...(input.environmentId ? ["environment_id = {environment:String}"] : []),
  ];
  return {
    parameters: {
      organization: input.organizationId,
      ...(input.projectId ? { project: input.projectId } : {}),
      ...(input.environmentId ? { environment: input.environmentId } : {}),
      ...(input.workspaceId ? { workspace: input.workspaceId } : {}),
    },
    /** The tenant predicates on columns of the delivery deduplication's PARTITION BY. */
    partitionSql: partition.join(" AND "),
    sql: [...partition, ...(input.workspaceId ? ["workspace_id = {workspace:String}"] : [])].join(
      " AND ",
    ),
  };
}

const TRACE_SUMMARY_TEXT_FIELDS = {
  agent_definition_id: "agentDefinitionId",
  agent_deployment_id: "agentDeploymentId",
  agent_release_id: "agentReleaseId",
  error_class: "errorClass",
  execution_purpose: "executionPurpose",
  release_selection: "releaseSelection",
  trigger: "trigger",
} as const;

/** Trace summary projection; summary fields absent from older facts select NULL and are omitted. */
export function traceSelect() {
  return `fact_id, trace_id, run_id, session_id, project_id, environment_id,
    occurred_at, normalized_at, capture_mode,
    coalesce(nullIf(JSONExtractString(payload_json, 'outcome'), ''), 'unknown') AS status,
    JSONExtractString(payload_json, 'rootRunId') AS root_run_id,
    JSONExtractString(payload_json, 'completedAt') AS completed_at,
    JSONExtractString(payload_json, 'finalizedAt') AS finalized_at,
    toFloat64(JSONExtractUInt(payload_json, 'runCount')) AS run_count,
    toFloat64(JSONExtractUInt(payload_json, 'totalTokens')) AS total_tokens,
    toFloat64(JSONExtractUInt(payload_json, 'totalCostUsdMicros')) AS total_cost_usd_micros,
    ${Object.entries(TRACE_SUMMARY_TEXT_FIELDS)
      .map(
        ([column, field]) =>
          `if(JSONHas(payload_json, '${field}'), JSONExtractString(payload_json, '${field}'), NULL) AS ${column}`,
      )
      .join(",\n    ")},
    if(JSONHas(payload_json, 'durationMs'), toFloat64(JSONExtractUInt(payload_json, 'durationMs')), NULL) AS duration_ms`;
}

/**
 * The `observability.active_facts` view for one tenant and the given fact types: each record's
 * latest delivered version, minus versions a `record.deleted` tombstone covers. The view filters
 * after ranking every fact on the node, which reads the whole table; here the tenant and
 * fact-type predicates run first, so the primary key narrows the read. That keeps the view's
 * answer because both predicates constrain only columns of the ranking's PARTITION BY and of the
 * tombstone join, so every version and tombstone of a kept record is kept. `tenantSql` is
 * `scopeSql().partitionSql`; predicates on other columns (time, workspace) belong outside.
 *
 * `occurredSql`, a predicate on `occurred_at` that every row the caller keeps satisfies, narrows
 * the ranking further to records with a fact of the given types in that range. It keeps all of
 * such a record's versions, and a record without one cannot pass the caller's own time
 * predicate. Tombstones are ranked in their own small read of the tenant's `record.deleted`
 * facts, whatever their time. With `ingestionFenceSql`, facts and tombstones delivered after the
 * pagination snapshot are hidden too.
 */
export function activeFactsSql(input: {
  readonly factTypes: readonly Exclude<ObservabilityFactType, "record.deleted">[];
  readonly ingestionFenceSql?: string;
  readonly occurredSql?: string;
  readonly tenantSql: string;
}) {
  const keptTypes = input.factTypes.map((type) => `'${type}'`).join(", ");
  const fence = input.ingestionFenceSql
    ? `
        AND normalized_at <= parseDateTime64BestEffort({snapshot:String}, 3)
        AND ${input.ingestionFenceSql}`
    : "";
  const latest = (factTypes: string, extra = "") => `SELECT * EXCEPT delivery_rank
    FROM (
      SELECT *, row_number() OVER (
        PARTITION BY organization_id, project_id, environment_id,
                     source_table, source_record_type, source_record_id, fact_type
        ORDER BY source_record_version DESC, normalized_at DESC, ingested_at DESC
      ) AS delivery_rank
      FROM observability.facts
      WHERE ${input.tenantSql}
        AND fact_type IN (${factTypes})${extra}${fence}
    )
    WHERE delivery_rank = 1`;
  return `(WITH
  snapshot_latest AS (
    ${latest(
      keptTypes,
      input.occurredSql
        ? `
        AND source_record_id IN (
          SELECT source_record_id FROM observability.facts
          WHERE ${input.tenantSql} AND fact_type IN (${keptTypes}) AND ${input.occurredSql}
        )`
        : "",
    )}
  ),
  snapshot_tombstones AS (
    SELECT organization_id, project_id, environment_id,
           source_table, source_record_type, source_record_id,
           max(toUInt64(JSONExtractInt(payload_json, 'deleteThroughRecordVersion'))) AS delete_through,
           arrayDistinct(arrayFlatten(groupArray(JSONExtract(payload_json, 'deletedFactTypes', 'Array(String)')))) AS deleted_types
    FROM (${latest("'record.deleted'")})
    GROUP BY organization_id, project_id, environment_id,
             source_table, source_record_type, source_record_id
  )
  SELECT facts.*
  FROM snapshot_latest AS facts
  LEFT JOIN snapshot_tombstones AS tombstones
    ON tombstones.organization_id = facts.organization_id
   AND tombstones.project_id = facts.project_id
   AND tombstones.environment_id = facts.environment_id
   AND tombstones.source_table = facts.source_table
   AND tombstones.source_record_type = facts.source_record_type
   AND tombstones.source_record_id = facts.source_record_id
  WHERE tombstones.source_record_id IS NULL
     OR facts.source_record_version > tombstones.delete_through
     OR NOT has(tombstones.deleted_types, facts.fact_type)
  ) AS active_facts`;
}
