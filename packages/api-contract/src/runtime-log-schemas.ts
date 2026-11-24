import { RuntimeLogLevel, RuntimeLogSource } from "@deployments-ai/observability";
import { Schema } from "effect";
import { Cursor, Timestamp } from "./primitives.ts";

export const RuntimeLogEntryResponse = Schema.Struct({
  /** Bounded scalar attributes; content-bearing ones are present only when the run captures content. */
  attributes: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([Schema.Boolean, Schema.Number, Schema.String])),
  ),
  /** Claimed execution of the run that wrote the line, counting from 1. */
  attempt: Schema.Number,
  /** Stable position of the line in the run's log. */
  id: Schema.String,
  level: RuntimeLogLevel,
  message: Schema.String,
  runId: Schema.String,
  source: RuntimeLogSource,
  spanId: Schema.optional(Schema.String),
  threadId: Schema.String,
  time: Timestamp,
  toolCallId: Schema.optional(Schema.String),
  traceId: Schema.String,
});

export const ListRunLogsResponse = Schema.Struct({
  /**
   * True when no stored line remained after `nextCursor` when this page was read. A short or empty
   * page with `caughtUp` false stopped early, so the client should keep paging.
   */
  caughtUp: Schema.Boolean,
  /** Lines in the order the run wrote them. */
  logs: Schema.Array(RuntimeLogEntryResponse),
  /**
   * Continues after the last line returned. Present on every page, including the last one, so a
   * follower can poll it for lines written later.
   */
  nextCursor: Cursor,
});

export type RuntimeLogEntryResponse = typeof RuntimeLogEntryResponse.Type;
export type ListRunLogsResponse = typeof ListRunLogsResponse.Type;

export const RUNTIME_LOG_API_SCHEMAS = { ListRunLogsResponse, RuntimeLogEntryResponse } as const;
