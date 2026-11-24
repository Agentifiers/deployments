import type {
  RuntimeLogEntryResponse,
  ListRunLogsResponse,
} from "@deployments-ai/api-contract/runtime";
import {
  RUNTIME_LOG_BATCH_PREFIX,
  makeRuntimeLogPersistence,
  runtimeLogBatchPartition,
  type RuntimeLogBatchRecordValue,
} from "@deployments-ai/db";
import {
  RUNTIME_LOG_LEVELS,
  RUNTIME_LOG_SOURCES,
  runtimeLogLevelAtLeast,
  type RuntimeLogLevel,
  type RuntimeLogSource,
} from "@deployments-ai/observability";
import { decodeCursor, encodeCursor, loadRunById } from "./runtime-cursors.ts";
import type { RuntimeRouteContext } from "./runtime-handler.ts";
import type { HttpApiResult } from "./runtime-support.ts";
import { RuntimeApiError, id, requireScope, response } from "./runtime-support.ts";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
/** Batches one request reads at most, so a filter that matches little still answers quickly. */
const MAX_SCANNED_BATCHES = 100;
const BATCH_QUERY_PAGE = 25;

/** Where the next page starts: the batch, then the first line sequence in it not yet returned. */
interface LogPosition {
  readonly attempt: number;
  readonly batch: number;
  readonly sequence: number;
}

interface LogFilters {
  readonly from?: number;
  readonly level?: RuntimeLogLevel;
  readonly source?: RuntimeLogSource;
  readonly to?: number;
  readonly toolCallId?: string;
}

export async function handleRuntimeLogRoutes(
  context: RuntimeRouteContext,
): Promise<HttpApiResult | undefined> {
  const { dependencies, event, method, path, principal } = context;
  const match = /^\/v1\/runs\/([^/]+)\/logs$/u.exec(path);
  if (method !== "GET" || !match) return undefined;
  requireScope(principal, "runs:read");
  const run = await loadRunById(dependencies, principal, id(match[1], "runId"));
  const query = event.queryStringParameters ?? {};
  const limit = logLimit(query.limit);
  const filters = logFilters(query);
  const scope = {
    environmentId: run.data.environmentId,
    organizationId: run.data.organizationId,
    projectId: run.data.projectId,
    runId: run.data.id,
  };
  const cursorBinding = {
    ":pk": runtimeLogBatchPartition(scope),
    ":prefix": RUNTIME_LOG_BATCH_PREFIX,
  };
  const cursorContext = { ...filters, route: "listRunLogs" };
  let position = decodePosition(
    decodeCursor(
      query.cursor,
      dependencies.sessionTokenSecret,
      undefined,
      cursorBinding,
      cursorContext,
    ),
  );
  const logs: RuntimeLogEntryResponse[] = [];
  const persistence = makeRuntimeLogPersistence(dependencies.database);
  const now = dependencies.now?.() ?? new Date();
  let scanned = 0;
  let caughtUp = false;
  let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
  scan: do {
    const page = await persistence.listRunBatches(scope, {
      exclusiveStartKey,
      from: position,
      limit: BATCH_QUERY_PAGE,
      now,
    });
    for (const batch of page.batches) {
      scanned += 1;
      const { attempt, batch: number } = batch.data;
      const startSequence =
        attempt === position.attempt && number === position.batch ? position.sequence : 0;
      for (const line of batch.data.lines) {
        if (line.sequence < startSequence) continue;
        position = { attempt, batch: number, sequence: line.sequence + 1 };
        if (!matches(line, filters)) continue;
        logs.push(entry(batch, line));
        if (logs.length === limit) break scan;
      }
      position = { attempt, batch: number, sequence: maxSequence(batch) + 1 };
      if (scanned === MAX_SCANNED_BATCHES) break scan;
    }
    exclusiveStartKey = page.lastEvaluatedKey;
    caughtUp = exclusiveStartKey === undefined;
  } while (exclusiveStartKey);
  const body: ListRunLogsResponse = {
    caughtUp,
    logs,
    nextCursor: encodeCursor(
      { pk: cursorBinding[":pk"], sk: positionSortKey(position) },
      dependencies.sessionTokenSecret,
      undefined,
      cursorBinding,
      cursorContext,
    ),
  };
  return response(200, body);
}

type RuntimeLogLineValue = RuntimeLogBatchRecordValue["data"]["lines"][number];

function matches(line: RuntimeLogLineValue, filters: LogFilters) {
  const time = Date.parse(line.time);
  return (
    (filters.level === undefined || runtimeLogLevelAtLeast(line.level, filters.level)) &&
    (filters.source === undefined || line.source === filters.source) &&
    (filters.toolCallId === undefined || line.toolCallId === filters.toolCallId) &&
    (filters.from === undefined || time >= filters.from) &&
    (filters.to === undefined || time < filters.to)
  );
}

function entry(batch: RuntimeLogBatchRecordValue, line: RuntimeLogLineValue) {
  const { attempt, batch: number, runId, threadId, traceId } = batch.data;
  return {
    ...(line.attributes ? { attributes: line.attributes } : {}),
    attempt,
    id: `${attempt}-${number}-${line.sequence}`,
    level: line.level,
    message: line.message,
    runId,
    source: line.source,
    ...(line.spanId ? { spanId: line.spanId } : {}),
    threadId,
    time: line.time,
    ...(line.toolCallId ? { toolCallId: line.toolCallId } : {}),
    traceId,
  } satisfies RuntimeLogEntryResponse;
}

function maxSequence(batch: RuntimeLogBatchRecordValue) {
  return Math.max(...batch.data.lines.map((line) => line.sequence));
}

function positionSortKey(position: LogPosition) {
  return `${RUNTIME_LOG_BATCH_PREFIX}${[position.attempt, position.batch, position.sequence]
    .map((value) => String(value).padStart(8, "0"))
    .join("#")}`;
}

function decodePosition(cursor: Readonly<Record<string, unknown>> | undefined): LogPosition {
  if (!cursor) return { attempt: 0, batch: 0, sequence: 0 };
  const parts = String(cursor.sk).slice(RUNTIME_LOG_BATCH_PREFIX.length).split("#");
  const [attempt, batch, sequence] = parts.map(Number);
  if (
    parts.length !== 3 ||
    ![attempt, batch, sequence].every((value) => Number.isSafeInteger(value) && value! >= 0)
  ) {
    throw new RuntimeApiError(400, "invalid_cursor", "cursor is invalid.");
  }
  return { attempt: attempt!, batch: batch!, sequence: sequence! };
}

function logLimit(value: string | undefined) {
  if (value === undefined) return DEFAULT_LIMIT;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RuntimeApiError(
      400,
      "invalid_limit",
      `limit must be an integer from 1 to ${MAX_LIMIT}.`,
    );
  }
  return limit;
}

function logFilters(query: Readonly<Record<string, string | undefined>>): LogFilters {
  const level = query.level;
  if (level !== undefined && !(RUNTIME_LOG_LEVELS as readonly string[]).includes(level)) {
    throw new RuntimeApiError(
      400,
      "invalid_level",
      `level must be one of ${RUNTIME_LOG_LEVELS.join(", ")}.`,
    );
  }
  const source = query.source;
  if (source !== undefined && !(RUNTIME_LOG_SOURCES as readonly string[]).includes(source)) {
    throw new RuntimeApiError(
      400,
      "invalid_source",
      `source must be one of ${RUNTIME_LOG_SOURCES.join(", ")}.`,
    );
  }
  const from = timeFilter(query.from, "from");
  const to = timeFilter(query.to, "to");
  if (from !== undefined && to !== undefined && from >= to) {
    throw new RuntimeApiError(400, "invalid_time_range", "from must be earlier than to.");
  }
  return {
    ...(from === undefined ? {} : { from }),
    ...(level === undefined ? {} : { level: level as RuntimeLogLevel }),
    ...(source === undefined ? {} : { source: source as RuntimeLogSource }),
    ...(to === undefined ? {} : { to }),
    ...(query.toolCallId === undefined ? {} : { toolCallId: id(query.toolCallId, "toolCallId") }),
  };
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

function timeFilter(value: string | undefined, name: "from" | "to") {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  if (!RFC3339.test(value) || Number.isNaN(time)) {
    throw new RuntimeApiError(400, "invalid_time", `${name} must be an RFC 3339 timestamp.`);
  }
  return time;
}
