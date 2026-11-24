import { Hono } from "hono";
import { metricSeries, toolMetrics } from "./api-metrics.ts";
import {
  activeFactsSql,
  canonicalTimestamp,
  decodeCursor,
  decodeSpanCursor,
  encodeSignedCursor,
  equalSecret,
  identifier,
  ingestionWatermarkFence,
  ingestionWatermarks,
  limit,
  MAX_LOOKBACK_DAYS,
  metadataRow,
  problem,
  QueryProblem,
  scope,
  scopeSql,
  SPAN_RETENTION_DAYS,
  TRACE_RETENTION_DAYS,
  traceSelect,
} from "./api-query.ts";
import { traceFilters, traceFilterSql } from "./api-trace-filters.ts";
import type { ClickHouseExecutor } from "./clickhouse.ts";
import {
  parseOrganizationErasureRequest,
  type OrganizationErasure,
} from "./organization-erasure.ts";
import { createQueryGate, createResponseCache, type CachedResponse } from "./query-capacity.ts";

const MAX_LIMIT = 100;
const MAX_EXPORT_LIMIT = 1_000;
const MAX_EXPORT_BYTES = 5 * 1_024 * 1_024;
/**
 * The query user runs each query on one thread, so four running queries keep the dev node's two
 * cores busy while one waits on IO; more would only queue inside ClickHouse. A dashboard's burst
 * waits here for a slot instead of failing with a 429.
 */
const QUERY_LIMITS = { global: 4, maxWaitMs: 3_000, maxWaiting: 64, organization: 2 } as const;
/** Aggregates are cached briefly so a dashboard's screens and tabs share one ClickHouse query. */
const CACHED_ROUTES: ReadonlySet<string> = new Set(["/metrics", "/tools"]);
const RESPONSE_CACHE_TTL_MS = 10_000;
const RESPONSE_CACHE_MAX_ENTRIES = 256;
/** Larger series are served uncached, so the cache stays under 32 MiB of the task's 512 MiB. */
const RESPONSE_CACHE_MAX_BODY_BYTES = 128 * 1_024;
const CURSOR_LEASE_MS = 5 * 60_000;
const TRACE_WINDOW_SQL =
  "occurred_at >= parseDateTime64BestEffort({from:String}, 3) AND occurred_at <= parseDateTime64BestEffort({to:String}, 3)";

export interface HotPlaneApiDependencies {
  readonly clickhouse: ClickHouseExecutor;
  readonly now?: () => Date;
  readonly organizationErasure: OrganizationErasure;
  readonly ready?: () => boolean;
  readonly serviceToken: string;
}

function bearer(request: Request) {
  return request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/iu)?.[1];
}

const TENANT_HEADERS = [
  "x-deployments-organization",
  "x-deployments-project",
  "x-deployments-environment",
  "x-deployments-workspace",
] as const;

/** The tenant scope and the route with its parameters sorted; the organization comes first. */
function responseCacheKey(request: Request) {
  const url = new URL(request.url);
  const query = new URLSearchParams(
    [...url.searchParams].toSorted(([a], [b]) => a.localeCompare(b)),
  );
  return [
    ...TENANT_HEADERS.map((name) => request.headers.get(name) ?? ""),
    `${url.pathname}?${query.toString()}`,
  ].join("\n");
}

async function snapshotWatermarks(
  dependencies: HotPlaneApiDependencies,
  queryScope: { readonly parameters: Readonly<Record<string, string>>; readonly sql: string },
) {
  return ingestionWatermarks(
    await dependencies.clickhouse.query(
      `SELECT ingestion_shard_id,
              toString(max(toUInt256(ingestion_sequence_number))) AS ingestion_sequence_number
       FROM observability.facts
       WHERE ${queryScope.sql}
       GROUP BY ingestion_shard_id
       ORDER BY ingestion_shard_id ASC`,
      queryScope.parameters,
    ),
  );
}

async function listTraces(
  dependencies: HotPlaneApiDependencies,
  request: Request,
  route: string,
  fixed: Readonly<Record<string, string>> = {},
  maximumLimit = MAX_LIMIT,
  paginateSnapshot = true,
) {
  const url = new URL(request.url);
  const requestedScope = scope(request);
  const queryScope = scopeSql(requestedScope);
  const pageLimit = limit(url.searchParams.get("limit"), maximumLimit);
  const cursor = decodeCursor(url.searchParams.get("cursor"), dependencies.serviceToken);
  if (
    cursor &&
    (cursor.organizationId !== requestedScope.organizationId ||
      cursor.projectId !== requestedScope.projectId ||
      cursor.environmentId !== requestedScope.environmentId ||
      cursor.workspaceId !== requestedScope.workspaceId ||
      cursor.route !== route)
  ) {
    throw new QueryProblem(400, "cursor_scope_mismatch", "cursor does not belong to this query.");
  }
  const now = dependencies.now?.() ?? new Date();
  if (cursor && now.getTime() > Date.parse(cursor.snapshotAt) + CURSOR_LEASE_MS) {
    throw new QueryProblem(410, "cursor_expired", "The pagination cursor has expired.");
  }
  const defaultFrom = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const requestedFrom = canonicalTimestamp(url.searchParams.get("from"), "from");
  const requestedTo = canonicalTimestamp(url.searchParams.get("to"), "to");
  const filters = traceFilters(url.searchParams, cursor);
  if (
    cursor &&
    ((requestedFrom !== undefined && requestedFrom !== cursor.from) ||
      (requestedTo !== undefined && requestedTo !== cursor.to))
  ) {
    throw new QueryProblem(
      400,
      "cursor_filter_mismatch",
      "Trace filters must match the cursor query.",
    );
  }
  const from = cursor?.from ?? requestedFrom ?? defaultFrom;
  const to = cursor?.to ?? requestedTo ?? now.toISOString();
  const snapshotAt = cursor?.snapshotAt ?? now.toISOString();
  const retentionStart =
    Date.parse(snapshotAt) - TRACE_RETENTION_DAYS * 86_400_000 + CURSOR_LEASE_MS;
  if (
    Date.parse(to) <= Date.parse(from) ||
    Date.parse(to) - Date.parse(from) > MAX_LOOKBACK_DAYS * 86_400_000 ||
    Date.parse(from) < retentionStart
  ) {
    throw new QueryProblem(
      400,
      "invalid_time_range",
      `The time range must be positive, no longer than ${MAX_LOOKBACK_DAYS} days, and inside the ${TRACE_RETENTION_DAYS}-day trace retention window.`,
    );
  }
  const filterSql = traceFilterSql(filters);
  const snapshotWatermarks_ = paginateSnapshot
    ? (cursor?.snapshotWatermarks ?? (await snapshotWatermarks(dependencies, queryScope)))
    : [];
  if (paginateSnapshot && snapshotWatermarks_.length === 0) return { items: [] };
  const ingestionFence =
    snapshotWatermarks_.length > 0 ? ingestionWatermarkFence(snapshotWatermarks_) : undefined;
  const predicates = [
    "fact_type = 'trace.finalized'",
    queryScope.sql,
    TRACE_WINDOW_SQL,
    ...filterSql.predicates,
    ...Object.keys(fixed).map((name) => `${name} = {${name}:String}`),
    ...(cursor
      ? [
          "(occurred_at < parseDateTime64BestEffort({cursor_time:String}, 3) OR (occurred_at = parseDateTime64BestEffort({cursor_time:String}, 3) AND fact_id < {cursor_fact:String}))",
        ]
      : []),
  ];
  const rows = await dependencies.clickhouse.query(
    `SELECT ${traceSelect()}
     FROM ${activeFactsSql({
       factTypes: ["trace.finalized"],
       ...(ingestionFence ? { ingestionFenceSql: ingestionFence.sql } : {}),
       occurredSql: TRACE_WINDOW_SQL,
       tenantSql: queryScope.partitionSql,
     })}
     WHERE ${predicates.join(" AND ")}
     ORDER BY occurred_at DESC, fact_id DESC
     LIMIT {limit:UInt32}`,
    {
      ...queryScope.parameters,
      ...ingestionFence?.parameters,
      ...filterSql.parameters,
      ...fixed,
      from,
      to,
      limit: String(pageLimit + 1),
      snapshot: snapshotAt,
      ...(cursor ? { cursor_fact: cursor.factId, cursor_time: cursor.occurredAt } : {}),
    },
  );
  const items = rows.slice(0, pageLimit).map(metadataRow);
  const last = rows.length > pageLimit ? rows[pageLimit - 1] : undefined;
  return {
    items,
    ...(paginateSnapshot &&
    last &&
    typeof last.fact_id === "string" &&
    typeof last.occurred_at === "string"
      ? {
          nextCursor: encodeSignedCursor(
            {
              ...filters,
              factId: last.fact_id,
              from,
              occurredAt: last.occurred_at,
              organizationId: requestedScope.organizationId,
              ...(requestedScope.projectId ? { projectId: requestedScope.projectId } : {}),
              ...(requestedScope.environmentId
                ? { environmentId: requestedScope.environmentId }
                : {}),
              ...(requestedScope.workspaceId ? { workspaceId: requestedScope.workspaceId } : {}),
              route,
              snapshotAt,
              snapshotWatermarks: snapshotWatermarks_,
              to,
            },
            dependencies.serviceToken,
          ),
        }
      : {}),
  };
}

export function createHotPlaneApi(dependencies: HotPlaneApiDependencies) {
  const app = new Hono();
  const queryGate = createQueryGate(QUERY_LIMITS);
  const responses = createResponseCache({
    maxEntries: RESPONSE_CACHE_MAX_ENTRIES,
    now: () => (dependencies.now?.() ?? new Date()).getTime(),
    ttlMs: RESPONSE_CACHE_TTL_MS,
  });
  app.get("/health", (context) =>
    context.json({ service: "observability-hot-plane", status: "ok" }),
  );
  app.use("/*", async (context, next) => {
    if (context.req.path === "/health") return next();
    if (!equalSecret(bearer(context.req.raw), dependencies.serviceToken)) {
      return context.json(
        { code: "unauthorized", detail: "A valid service token is required." },
        401,
      );
    }
    return next();
  });
  app.get("/ready", async (context) => {
    try {
      if (dependencies.ready?.() === false) {
        return context.json({ status: "initializing" }, 503);
      }
      await dependencies.clickhouse.query("SELECT 1 AS ready");
      return context.json({ status: "ready" });
    } catch (cause) {
      console.error("ClickHouse readiness failed.", cause);
      return context.json({ status: "unavailable" }, 503);
    }
  });
  app.use("/*", async (context, next) => {
    if (dependencies.ready?.() === false) {
      return problem(
        new QueryProblem(503, "observability_initializing", "The hot plane is initializing."),
      );
    }
    return next();
  });
  // Registered ahead of the tenant query-concurrency gate: erasure is an
  // internal operator call, not a tenant-scoped read.
  app.post("/internal/organization-erasures", async (context) => {
    try {
      const request = parseOrganizationErasureRequest(await context.req.text());
      // Every call, including the poll that reports completion, drops the organization's cached
      // aggregates and in-flight results, so none read before the purge is served after it.
      responses.evict(`${request.organizationId}\n`);
      const outcome = await dependencies.organizationErasure.erase(request);
      responses.evict(`${request.organizationId}\n`);
      if (outcome.status === "fence_missing") {
        throw new QueryProblem(
          409,
          "erasure_fence_missing",
          "The organization has no erasure fence for this operation.",
        );
      }
      if (outcome.status === "conversation_erasure_not_running") {
        throw new QueryProblem(
          409,
          "conversation_erasure_not_running",
          "The operation is not a running thread or end-user erasure of the organization.",
        );
      }
      return context.json(outcome, outcome.status === "complete" ? 200 : 202);
    } catch (cause) {
      if (!(cause instanceof QueryProblem)) {
        console.error("Observability organization erasure failed.", cause);
      }
      return problem(cause);
    }
  });
  app.use("/*", async (context, next) => {
    const organizationId = context.req.header("x-deployments-organization") ?? "";
    const gated = async () => {
      try {
        await queryGate.run(organizationId, next);
      } catch (cause) {
        if (!(cause instanceof QueryProblem)) throw cause;
        context.res = problem(cause);
      }
    };
    if (context.req.method !== "GET" || !CACHED_ROUTES.has(context.req.path)) return gated();
    const key = responseCacheKey(context.req.raw);
    const cached = await responses.read(key);
    if (cached)
      return new Response(cached.body, { headers: { "content-type": cached.contentType } });
    const result = Promise.withResolvers<CachedResponse | undefined>();
    responses.write(key, result.promise);
    try {
      await gated();
      const body = context.res.status === 200 ? await context.res.clone().text() : undefined;
      result.resolve(
        body === undefined || Buffer.byteLength(body) > RESPONSE_CACHE_MAX_BODY_BYTES
          ? undefined
          : { body, contentType: context.res.headers.get("content-type") ?? "application/json" },
      );
    } catch (cause) {
      result.resolve(undefined);
      throw cause;
    }
  });
  app.get("/traces", async (context) => {
    try {
      return context.json(await listTraces(dependencies, context.req.raw, "traces"));
    } catch (cause) {
      return problem(cause);
    }
  });
  app.get("/traces/:traceId", async (context) => {
    try {
      const traceId = identifier(context.req.param("traceId"), "trace_id", true)!;
      const requestedScope = scope(context.req.raw);
      const queryScope = scopeSql(requestedScope);
      const rows = await dependencies.clickhouse.query(
        `SELECT ${traceSelect()}
         FROM ${activeFactsSql({ factTypes: ["trace.finalized"], tenantSql: queryScope.partitionSql })}
         WHERE fact_type = 'trace.finalized' AND ${queryScope.sql} AND trace_id = {trace:String}
           AND occurred_at >= now() - INTERVAL ${TRACE_RETENTION_DAYS} DAY
         ORDER BY source_record_version DESC, normalized_at DESC LIMIT 1`,
        { ...queryScope.parameters, trace: traceId },
      );
      if (!rows[0]) throw new QueryProblem(404, "trace_not_found", "Trace not found.");
      return context.json(metadataRow(rows[0]));
    } catch (cause) {
      return problem(cause);
    }
  });
  app.get("/traces/:traceId/spans", async (context) => {
    try {
      const traceId = identifier(context.req.param("traceId"), "trace_id", true)!;
      const requestedScope = scope(context.req.raw);
      const queryScope = scopeSql(requestedScope);
      const url = new URL(context.req.url);
      const pageLimit = limit(url.searchParams.get("limit"));
      const cursor = decodeSpanCursor(
        url.searchParams.get("cursor"),
        dependencies.serviceToken,
        requestedScope,
        traceId,
      );
      const snapshotAt = cursor?.snapshotAt ?? (dependencies.now?.() ?? new Date()).toISOString();
      const requestNow = dependencies.now?.() ?? new Date();
      if (cursor && requestNow.getTime() > Date.parse(snapshotAt) + CURSOR_LEASE_MS) {
        throw new QueryProblem(410, "cursor_expired", "The pagination cursor has expired.");
      }
      const retentionStart = new Date(
        Date.parse(snapshotAt) - SPAN_RETENTION_DAYS * 86_400_000 + CURSOR_LEASE_MS,
      ).toISOString();
      const snapshotWatermarks_ =
        cursor?.snapshotWatermarks ?? (await snapshotWatermarks(dependencies, queryScope));
      if (snapshotWatermarks_.length === 0) return context.json({ items: [] });
      const ingestionFence = ingestionWatermarkFence(snapshotWatermarks_);
      const rows = await dependencies.clickhouse.query(
        `SELECT fact_id, trace_id, span_id, parent_span_id, run_id, session_id, occurred_at,
                JSONExtractString(payload_json, 'kind') AS kind,
                JSONExtractString(payload_json, 'name') AS name,
                JSONExtractString(payload_json, 'status') AS status,
                toFloat64(JSONExtractUInt(payload_json, 'durationMs')) AS duration_ms,
                JSONExtractString(payload_json, 'errorClass') AS error_class,
                if(JSONHas(payload_json, 'requestedProvider'), JSONExtractString(payload_json, 'requestedProvider'), NULL) AS requested_provider,
                if(JSONHas(payload_json, 'requestedModelId'), JSONExtractString(payload_json, 'requestedModelId'), NULL) AS requested_model_id,
                if(JSONHas(payload_json, 'actualProvider'), JSONExtractString(payload_json, 'actualProvider'), NULL) AS actual_provider,
                if(JSONHas(payload_json, 'actualModelId'), JSONExtractString(payload_json, 'actualModelId'), NULL) AS actual_model_id,
                if(JSONHas(payload_json, 'attemptId'), JSONExtractString(payload_json, 'attemptId'), NULL) AS attempt_id,
                if(JSONHas(payload_json, 'modelCallIndex'), toFloat64(JSONExtractUInt(payload_json, 'modelCallIndex')), NULL) AS model_call_index,
                if(JSONHas(payload_json, 'invocationKind'), JSONExtractString(payload_json, 'invocationKind'), NULL) AS invocation_kind,
                if(JSONHas(payload_json, 'fallbackAttempt'), toFloat64(JSONExtractUInt(payload_json, 'fallbackAttempt')), NULL) AS fallback_attempt,
                if(JSONHas(payload_json, 'fallbackReason'), JSONExtractString(payload_json, 'fallbackReason'), NULL) AS fallback_reason,
                if(JSONHas(payload_json, 'inputTokens'), toFloat64(JSONExtractUInt(payload_json, 'inputTokens')), NULL) AS input_tokens,
                if(JSONHas(payload_json, 'outputTokens'), toFloat64(JSONExtractUInt(payload_json, 'outputTokens')), NULL) AS output_tokens,
                if(JSONHas(payload_json, 'cachedTokens'), toFloat64(JSONExtractUInt(payload_json, 'cachedTokens')), NULL) AS cached_tokens,
                if(JSONHas(payload_json, 'totalTokens'), toFloat64(JSONExtractUInt(payload_json, 'totalTokens')), NULL) AS total_tokens,
                if(JSONHas(payload_json, 'costUsdMicros'), toFloat64(JSONExtractUInt(payload_json, 'costUsdMicros')), NULL) AS cost_usd_micros,
                if(JSONHas(payload_json, 'providerRequestId'), JSONExtractString(payload_json, 'providerRequestId'), NULL) AS provider_request_id,
                if(JSONHas(payload_json, 'stopReason'), JSONExtractString(payload_json, 'stopReason'), NULL) AS stop_reason,
                payload_json
         FROM ${activeFactsSql({
           factTypes: ["span.finalized"],
           ingestionFenceSql: ingestionFence.sql,
           tenantSql: queryScope.partitionSql,
         })}
         WHERE fact_type = 'span.finalized' AND ${queryScope.sql} AND trace_id = {trace:String}
           AND occurred_at >= parseDateTime64BestEffort({retention_start:String}, 3)
           ${
             cursor
               ? "AND (occurred_at > parseDateTime64BestEffort({cursor_time:String}, 3) OR (occurred_at = parseDateTime64BestEffort({cursor_time:String}, 3) AND (span_id > {cursor_span:String} OR (span_id = {cursor_span:String} AND fact_id > {cursor_fact:String}))))"
               : ""
           }
         ORDER BY occurred_at ASC, span_id ASC, fact_id ASC LIMIT {limit:UInt32}`,
        {
          ...queryScope.parameters,
          ...ingestionFence.parameters,
          limit: String(pageLimit + 1),
          retention_start: retentionStart,
          snapshot: snapshotAt,
          trace: traceId,
          ...(cursor
            ? {
                cursor_fact: cursor.factId,
                cursor_span: cursor.spanId,
                cursor_time: cursor.occurredAt,
              }
            : {}),
        },
      );
      const items = rows.slice(0, pageLimit).map(metadataRow);
      const last = rows.length > pageLimit ? rows[pageLimit - 1] : undefined;
      return context.json({
        items,
        ...(last &&
        typeof last.fact_id === "string" &&
        typeof last.occurred_at === "string" &&
        typeof last.span_id === "string"
          ? {
              nextCursor: encodeSignedCursor(
                {
                  factId: last.fact_id,
                  occurredAt: last.occurred_at,
                  organizationId: requestedScope.organizationId,
                  ...(requestedScope.projectId ? { projectId: requestedScope.projectId } : {}),
                  ...(requestedScope.environmentId
                    ? { environmentId: requestedScope.environmentId }
                    : {}),
                  ...(requestedScope.workspaceId
                    ? { workspaceId: requestedScope.workspaceId }
                    : {}),
                  spanId: last.span_id,
                  snapshotAt,
                  snapshotWatermarks: snapshotWatermarks_,
                  traceId,
                },
                dependencies.serviceToken,
              ),
            }
          : {}),
      });
    } catch (cause) {
      return problem(cause);
    }
  });
  app.get("/runs/:runId/trace", async (context) => {
    try {
      const runId = identifier(context.req.param("runId"), "run_id", true)!;
      const requestedScope = scope(context.req.raw);
      const queryScope = scopeSql(requestedScope);
      const rows = await dependencies.clickhouse.query(
        `SELECT ${traceSelect()}
         FROM ${activeFactsSql({
           factTypes: ["span.finalized", "trace.finalized"],
           tenantSql: queryScope.partitionSql,
         })}
         WHERE fact_type = 'trace.finalized' AND ${queryScope.sql}
           AND occurred_at >= now() - INTERVAL ${TRACE_RETENTION_DAYS} DAY
           AND (
             run_id = {run:String}
             OR has(JSONExtract(payload_json, 'runIds', 'Array(String)'), {run:String})
             OR trace_id = (
               SELECT trace_id
               FROM ${activeFactsSql({ factTypes: ["span.finalized"], tenantSql: queryScope.partitionSql })}
               WHERE fact_type = 'span.finalized' AND ${queryScope.sql}
                 AND JSONExtractString(payload_json, 'kind') = 'run'
                 AND run_id = {run:String}
                 AND occurred_at >= now() - INTERVAL ${TRACE_RETENTION_DAYS} DAY
               ORDER BY source_record_version DESC, normalized_at DESC LIMIT 1
             )
           )
         ORDER BY source_record_version DESC, normalized_at DESC LIMIT 1`,
        { ...queryScope.parameters, run: runId },
      );
      if (!rows[0]) throw new QueryProblem(404, "trace_not_found", "No trace exists for the run.");
      return context.json(metadataRow(rows[0]));
    } catch (cause) {
      return problem(cause);
    }
  });
  app.get("/sessions/:sessionId/traces", async (context) => {
    try {
      const sessionId = identifier(context.req.param("sessionId"), "session_id", true)!;
      return context.json(
        await listTraces(dependencies, context.req.raw, `session:${sessionId}`, {
          session_id: sessionId,
        }),
      );
    } catch (cause) {
      return problem(cause);
    }
  });
  app.get("/metrics", async (context) => {
    try {
      return context.json(
        await metricSeries(
          dependencies.clickhouse,
          context.req.raw,
          dependencies.now?.() ?? new Date(),
        ),
      );
    } catch (cause) {
      return problem(cause);
    }
  });
  app.get("/tools", async (context) => {
    try {
      return context.json(
        await toolMetrics(
          dependencies.clickhouse,
          context.req.raw,
          dependencies.now?.() ?? new Date(),
        ),
      );
    } catch (cause) {
      return problem(cause);
    }
  });
  app.post("/exports", async (context) => {
    try {
      const bodyText = await context.req.text();
      let body: { readonly limit?: unknown } = {};
      if (bodyText.trim()) {
        try {
          const decoded: unknown = JSON.parse(bodyText);
          if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
            throw new Error("request body must be an object");
          }
          body = decoded as { readonly limit?: unknown };
        } catch (cause) {
          throw new QueryProblem(
            400,
            "invalid_export_body",
            cause instanceof Error ? cause.message : "Export body is invalid.",
          );
        }
      }
      // Non-scalar limits map to "" so limit() rejects them with invalid_limit.
      const exportLimit =
        body.limit === undefined
          ? MAX_EXPORT_LIMIT
          : limit(
              typeof body.limit === "number" || typeof body.limit === "string"
                ? String(body.limit)
                : "",
              MAX_EXPORT_LIMIT,
            );
      const url = new URL(context.req.url);
      const generatedAt = (dependencies.now?.() ?? new Date()).toISOString();
      const pages: unknown[] = [];
      let encodedBytes = Buffer.byteLength(JSON.stringify({ generatedAt, items: [] }));
      url.searchParams.set("limit", String(exportLimit));
      const page = await listTraces(
        dependencies,
        new Request(url.toString(), { headers: context.req.raw.headers }),
        "export",
        {},
        MAX_EXPORT_LIMIT,
        false,
      );
      for (const item of page.items) {
        const itemBytes = Buffer.byteLength(JSON.stringify(item)) + (pages.length > 0 ? 1 : 0);
        if (encodedBytes + itemBytes > MAX_EXPORT_BYTES) {
          throw new QueryProblem(
            413,
            "export_too_large",
            "The encoded export exceeds the synchronous response budget; request a smaller limit.",
          );
        }
        encodedBytes += itemBytes;
        pages.push(item);
      }
      return context.json({
        generatedAt,
        items: pages.slice(0, exportLimit),
      });
    } catch (cause) {
      return problem(cause);
    }
  });
  return app;
}
