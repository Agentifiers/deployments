import { Schema } from "effect";
import { type EventAnalyticsCoordinates, tableReference } from "./coordinates.ts";

/** Largest number of rows any operator query returns. */
export const MAX_ROWS = 1000;

/**
 * The columns of the semantic event Iceberg table, in table order. `platform-data` defines the
 * table; a test keeps this list in step with it.
 */
export const SEMANTIC_EVENT_COLUMNS = [
  { name: "event_id", type: "string", description: "Canonical event ULID. Unique per event." },
  {
    name: "event_type",
    type: "string",
    description: "Dotted event type, such as an entity and action.",
  },
  {
    name: "event_source",
    type: "string",
    description: "EventBridge source, such as deployments-ai.platform.",
  },
  { name: "event_entity", type: "string", description: "Event type before its last dot." },
  { name: "event_action", type: "string", description: "Event type after its last dot." },
  {
    name: "eventbridge_event_id",
    type: "string",
    description: "EventBridge delivery ID; differs per redelivery.",
  },
  {
    name: "eventbridge_detail_type",
    type: "string",
    description: "EventBridge detail-type; equals event_type.",
  },
  { name: "aws_account_id", type: "string", description: "Account that published the event." },
  { name: "aws_region", type: "string", description: "Region that published the event." },
  { name: "organization_id", type: "string", description: "Tenant organization ULID." },
  { name: "project_id", type: "string", description: "Project ULID, when the event has one." },
  {
    name: "environment_id",
    type: "string",
    description: "Environment ULID, when the event has one.",
  },
  { name: "aggregate_type", type: "string", description: "Kind of resource the event changed." },
  { name: "aggregate_id", type: "string", description: "ULID of the resource the event changed." },
  { name: "aggregate_version", type: "long", description: "Resource version after the change." },
  { name: "actor_id", type: "string", description: "Who caused the event, when known." },
  { name: "actor_type", type: "string", description: "Kind of actor, when known." },
  {
    name: "trace_id",
    type: "string",
    description: "Trace ID of the request that caused the event.",
  },
  { name: "occurred_at", type: "string", description: "ISO 8601 time the change happened." },
  {
    name: "ingested_at",
    type: "string",
    description: "ISO 8601 time EventBridge accepted the delivery.",
  },
  { name: "payload_json", type: "string", description: "Event payload as a JSON document." },
] as const;

const RECENT_COLUMNS = [
  "event_id",
  "event_type",
  "organization_id",
  "project_id",
  "environment_id",
  "aggregate_type",
  "aggregate_id",
  "aggregate_version",
  "actor_type",
  "actor_id",
  "occurred_at",
  "ingested_at",
  "trace_id",
] as const;

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const EVENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}\*?$/u;
const TIME_PATTERN =
  /^(?:[0-9]{1,5}[mhd]|[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9:.]+(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?)$/u;

const OrganizationId = Schema.String.annotate({
  description: "Only events of this tenant organization (a 26-character ULID).",
}).check(Schema.isPattern(ULID_PATTERN));
const EventType = Schema.String.annotate({
  description: "Only events of this type. End it with * to match a prefix, such as agent.*.",
}).check(Schema.isPattern(EVENT_TYPE_PATTERN));
const Since = Schema.String.annotate({
  description:
    "Window start on occurred_at: a relative age such as 30m, 24h, or 7d, or an ISO 8601 date or timestamp.",
}).check(Schema.isPattern(TIME_PATTERN));
const Until = Schema.String.annotate({
  description: "Window end on occurred_at, in the same forms as since. Defaults to now.",
}).check(Schema.isPattern(TIME_PATTERN));
const rowLimit = (description: string) =>
  Schema.Number.annotate({ description }).check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: MAX_ROWS }),
  );

export const RecentEventsRequest = Schema.Struct({
  organization_id: Schema.optionalKey(OrganizationId),
  event_type: Schema.optionalKey(EventType),
  since: Schema.optionalKey(Since),
  until: Schema.optionalKey(Until),
  limit: Schema.optionalKey(rowLimit("Most events to return, newest first. Defaults to 50.")),
  include_payload: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Include each event's payload_json. Defaults to false.",
    }),
  ),
});
export type RecentEventsRequest = typeof RecentEventsRequest.Type;

export const EventTypeCountsRequest = Schema.Struct({
  organization_id: Schema.optionalKey(OrganizationId),
  event_type: Schema.optionalKey(EventType),
  since: Schema.optionalKey(Since),
  until: Schema.optionalKey(Until),
  limit: Schema.optionalKey(
    rowLimit("Most event types to return, busiest first. Defaults to 100."),
  ),
});
export type EventTypeCountsRequest = typeof EventTypeCountsRequest.Type;

export const RunQueryRequest = Schema.Struct({
  sql: Schema.String.annotate({
    description:
      "One read-only SELECT or WITH statement, without comments. The table is events; it holds every delivery, so deduplicate by event_id.",
  }).check(Schema.isMinLength(1)),
  max_rows: Schema.optionalKey(rowLimit("Most rows to return. Defaults to 100.")),
});
export type RunQueryRequest = typeof RunQueryRequest.Type;

export class InvalidRequestError extends Error {
  override readonly name = "InvalidRequestError";
}

function instant(value: string, now: Date, field: string) {
  const relative = /^([0-9]+)([mhd])$/u.exec(value);
  if (relative) {
    const [, amount = "0", unit] = relative;
    const unitMilliseconds = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000;
    return new Date(now.getTime() - Number(amount) * unitMilliseconds);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new InvalidRequestError(`${field} is not a valid time: ${JSON.stringify(value)}.`);
  }
  return new Date(milliseconds);
}

export interface TimeWindow {
  readonly since: Date;
  readonly until: Date;
}

/** Resolves `since` and `until` against `now`; `since` defaults to `defaultSince` ago. */
export function timeWindow(input: {
  readonly defaultSince: string;
  readonly now: Date;
  readonly since: string | undefined;
  readonly until: string | undefined;
}): TimeWindow {
  const since = instant(input.since ?? input.defaultSince, input.now, "since");
  const until = input.until === undefined ? input.now : instant(input.until, input.now, "until");
  if (since.getTime() >= until.getTime()) {
    throw new InvalidRequestError("since must be earlier than until.");
  }
  return { since, until };
}

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function filters(input: {
  readonly eventType: string | undefined;
  readonly organizationId: string | undefined;
  readonly window: TimeWindow;
}) {
  const conditions = [
    `from_iso8601_timestamp(occurred_at) >= from_iso8601_timestamp(${sqlString(input.window.since.toISOString())})`,
    `from_iso8601_timestamp(occurred_at) < from_iso8601_timestamp(${sqlString(input.window.until.toISOString())})`,
  ];
  if (input.organizationId !== undefined) {
    conditions.push(`organization_id = ${sqlString(input.organizationId)}`);
  }
  if (input.eventType?.endsWith("*")) {
    conditions.push(`starts_with(event_type, ${sqlString(input.eventType.slice(0, -1))})`);
  } else if (input.eventType !== undefined) {
    conditions.push(`event_type = ${sqlString(input.eventType)}`);
  }
  return conditions.join("\n    AND ");
}

export interface CannedQuery {
  /** Rows the caller returns; the SQL asks for one more to detect truncation. */
  readonly maxRows: number;
  readonly sql: string;
}

/**
 * Newest semantic events first. Delivery is at least once, so each event ID keeps only its latest
 * delivery, ranked by ingestion time and then EventBridge delivery ID.
 */
export function recentEventsQuery(input: {
  readonly coordinates: EventAnalyticsCoordinates;
  readonly now: Date;
  readonly request: RecentEventsRequest;
}): CannedQuery {
  const { request } = input;
  const maxRows = request.limit ?? 50;
  const columns = [
    ...RECENT_COLUMNS,
    ...(request.include_payload === true ? ["payload_json"] : []),
  ];
  const where = filters({
    eventType: request.event_type,
    organizationId: request.organization_id,
    window: timeWindow({
      defaultSince: "24h",
      now: input.now,
      since: request.since,
      until: request.until,
    }),
  });
  return {
    maxRows,
    sql: `WITH ranked AS (
  SELECT ${columns.join(", ")},
    row_number() OVER (
      PARTITION BY event_id
      ORDER BY ingested_at DESC, eventbridge_event_id DESC
    ) AS delivery_rank
  FROM ${tableReference(input.coordinates)}
  WHERE ${where}
)
SELECT ${columns.join(", ")}
FROM ranked
WHERE delivery_rank = 1
ORDER BY from_iso8601_timestamp(occurred_at) DESC, event_id DESC
LIMIT ${String(maxRows + 1)}`,
  };
}

/** Distinct semantic events per event type, busiest first, counting each event ID once. */
export function eventTypeCountsQuery(input: {
  readonly coordinates: EventAnalyticsCoordinates;
  readonly now: Date;
  readonly request: EventTypeCountsRequest;
}): CannedQuery {
  const { request } = input;
  const maxRows = request.limit ?? 100;
  const where = filters({
    eventType: request.event_type,
    organizationId: request.organization_id,
    window: timeWindow({
      defaultSince: "24h",
      now: input.now,
      since: request.since,
      until: request.until,
    }),
  });
  return {
    maxRows,
    sql: `SELECT event_type, count(DISTINCT event_id) AS event_count
FROM ${tableReference(input.coordinates)}
WHERE ${where}
GROUP BY event_type
ORDER BY event_count DESC, event_type ASC
LIMIT ${String(maxRows + 1)}`,
  };
}
