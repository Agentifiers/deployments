import { Schema } from "effect";
import {
  type AthenaSender,
  type QueryClock,
  type QueryResult,
  runAthenaQuery,
  systemClock,
} from "./athena-query.ts";
import { type EventAnalyticsCoordinates, tableReference } from "./coordinates.ts";
import {
  type CannedQuery,
  eventTypeCountsQuery,
  EventTypeCountsRequest,
  InvalidRequestError,
  MAX_ROWS,
  recentEventsQuery,
  RecentEventsRequest,
  RunQueryRequest,
  SEMANTIC_EVENT_COLUMNS,
} from "./event-queries.ts";
import { guardReadOnlyQuery } from "./sql-guard.ts";

export const DEFAULT_QUERY_ROWS = 100;

export interface SchemaDescription {
  readonly columns: typeof SEMANTIC_EVENT_COLUMNS;
  readonly coordinates: EventAnalyticsCoordinates;
  readonly notes: readonly string[];
  readonly table: string;
}

export interface RanQuery extends QueryResult {
  readonly sql: string;
}

/** The operations the CLI and the MCP server expose, over one Athena client and one table. */
export interface EventAnalytics {
  readonly describeSchema: () => SchemaDescription;
  readonly eventTypeCounts: (request: unknown) => Promise<RanQuery>;
  readonly recentEvents: (request: unknown) => Promise<RanQuery>;
  readonly runQuery: (request: unknown) => Promise<RanQuery>;
}

function decoder<S extends Schema.ConstraintDecoder<unknown>>(schema: S) {
  const decode = Schema.decodeUnknownExit(schema);
  return (input: unknown): S["Type"] => {
    const exit = decode(input);
    if (exit._tag === "Success") return exit.value;
    throw new InvalidRequestError(String(exit.cause));
  };
}

const decodeRecentEvents = decoder(RecentEventsRequest);
const decodeEventTypeCounts = decoder(EventTypeCountsRequest);
const decodeRunQuery = decoder(RunQueryRequest);

export function createEventAnalytics(input: {
  readonly client: AthenaSender;
  readonly clock?: QueryClock;
  readonly coordinates: EventAnalyticsCoordinates;
  readonly timeoutMs?: number;
}): EventAnalytics {
  const { coordinates } = input;
  const clock = input.clock ?? systemClock;
  const run = async (query: CannedQuery): Promise<RanQuery> => ({
    ...(await runAthenaQuery({
      client: input.client,
      clock,
      coordinates,
      maxRows: query.maxRows,
      sql: query.sql,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    })),
    sql: query.sql,
  });
  return {
    describeSchema: () => ({
      columns: SEMANTIC_EVENT_COLUMNS,
      coordinates,
      notes: [
        `Query ${tableReference(coordinates)}, or events, which resolves to it.`,
        "The log holds every tenant's events. It is for platform operators only.",
        "Delivery is at least once: an event can appear more than once with the same event_id. Keep one row per event_id, ranked by ingested_at DESC then eventbridge_event_id DESC, or count DISTINCT event_id.",
        "occurred_at and ingested_at are ISO 8601 strings; compare them with from_iso8601_timestamp().",
        `The workgroup ${coordinates.workgroup} enforces a bytes-scanned cutoff per query, and results stop at ${String(MAX_ROWS)} rows.`,
      ],
      table: tableReference(coordinates),
    }),
    eventTypeCounts: async (request) =>
      run(
        eventTypeCountsQuery({
          coordinates,
          now: new Date(clock.now()),
          request: decodeEventTypeCounts(request),
        }),
      ),
    recentEvents: async (request) =>
      run(
        recentEventsQuery({
          coordinates,
          now: new Date(clock.now()),
          request: decodeRecentEvents(request),
        }),
      ),
    runQuery: async (request) => {
      const decoded = decodeRunQuery(request);
      const maxRows = decoded.max_rows ?? DEFAULT_QUERY_ROWS;
      return run({ maxRows, sql: guardReadOnlyQuery(decoded.sql, maxRows).sql });
    },
  };
}
