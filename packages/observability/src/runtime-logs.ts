import { Schema } from "effect";
import type { CaptureMode } from "./capture.ts";
import { HOT_PLANE_RETENTION_DAYS } from "./retention.ts";

/** Severity, least to most severe; a `level` filter keeps that level and every later one. */
export const RUNTIME_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export const RuntimeLogLevel = Schema.Literals(RUNTIME_LOG_LEVELS);
export type RuntimeLogLevel = typeof RuntimeLogLevel.Type;

/**
 * What wrote a line: the run lifecycle, model generation, tool execution, sandbox lifecycle, or
 * the output of the customer's own hosted code.
 */
export const RUNTIME_LOG_SOURCES = ["runtime", "model", "tool", "sandbox", "hosted-code"] as const;
export const RuntimeLogSource = Schema.Literals(RUNTIME_LOG_SOURCES);
export type RuntimeLogSource = typeof RuntimeLogSource.Type;

export const RUNTIME_LOG_LIMITS = {
  /** Scalar attributes kept on one line. */
  attributes: 16,
  /** Characters kept of one string attribute value. */
  attributeValueCharacters: 256,
  /** Lines one stored batch holds. */
  batchLines: 50,
  /** Characters kept of one message; longer messages end in an ellipsis. */
  messageCharacters: 2_000,
  /** Process output lines kept from one hosted code execution. */
  processOutputLines: 200,
  /** Lines one claimed execution of a run keeps; a final warning marks the cut. */
  runExecutionLines: 1_000,
} as const;

/** Runtime logs are kept as long as hot-plane spans, so a log line's span link stays live. */
export const RUNTIME_LOG_RETENTION_DAYS = HOT_PLANE_RETENTION_DAYS.span;

export type RuntimeLogAttributeValue = boolean | number | string;

/**
 * How a run's capture mode shapes its log lines. Messages the platform writes are always kept and
 * pass the runtime secret redaction, except under `full-content`. Process output (what customer
 * code printed) and content-bearing attributes are captured only when the mode captures content.
 */
export const RUNTIME_LOG_CAPTURE_POLICY: Readonly<
  Record<
    CaptureMode,
    {
      readonly attributes: "all" | "metadata";
      readonly processOutput: boolean;
      readonly text: "redact" | "verbatim";
    }
  >
> = {
  "full-content": { attributes: "all", processOutput: true, text: "verbatim" },
  "metadata-only": { attributes: "metadata", processOutput: false, text: "redact" },
  "redacted-content": { attributes: "all", processOutput: true, text: "redact" },
};

export function runtimeLogLevelAtLeast(level: RuntimeLogLevel, minimum: RuntimeLogLevel) {
  return RUNTIME_LOG_LEVELS.indexOf(level) >= RUNTIME_LOG_LEVELS.indexOf(minimum);
}
