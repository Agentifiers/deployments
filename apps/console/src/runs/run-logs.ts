import { oneOf } from "../observability/range.ts";
import type { RunLogEntry } from "../server/runtime-log-data.ts";

/** Least to most severe, as the API orders them; a level filter keeps that level and later ones. */
export const RUN_LOG_LEVELS = [
  "debug",
  "info",
  "warn",
  "error",
] as const satisfies readonly RunLogEntry["level"][];

export const RUN_LOG_SOURCES = [
  "runtime",
  "model",
  "tool",
  "sandbox",
  "hosted-code",
] as const satisfies readonly RunLogEntry["source"][];

export interface RunLogFilters {
  readonly level?: (typeof RUN_LOG_LEVELS)[number];
  readonly source?: (typeof RUN_LOG_SOURCES)[number];
  readonly toolCallId?: string;
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

export function parseRunLogFilters(input: Readonly<Record<string, unknown>>): RunLogFilters {
  const level = oneOf(RUN_LOG_LEVELS, input.level);
  const source = oneOf(RUN_LOG_SOURCES, input.source);
  const toolCallId =
    typeof input.toolCallId === "string" && ULID.test(input.toolCallId)
      ? input.toolCallId
      : undefined;
  return {
    ...(level ? { level } : {}),
    ...(source ? { source } : {}),
    ...(toolCallId ? { toolCallId } : {}),
  };
}

export const RUN_LOG_LEVEL_COLOR = {
  debug: "zinc",
  error: "red",
  info: "blue",
  warn: "amber",
} as const satisfies Record<RunLogEntry["level"], string>;
