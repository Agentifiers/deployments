import { METRIC_RANGES, oneOf, type MetricRange } from "./range.ts";

/** Trace outcomes (`ok`, `error`, `canceled`) plus `unknown` for traces finalized without one. */
export const TRACE_STATUSES = ["ok", "error", "canceled", "unknown"] as const;
export const EXECUTION_PURPOSES = ["customer", "evaluation", "preview"] as const;

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
/** The hot plane's identifier rule for error classes and trace IDs. */
export const OBSERVABILITY_IDENTIFIER = /^[A-Za-z0-9._:-]{1,160}$/u;

export interface TraceFilters {
  readonly agentDefinitionId?: string;
  readonly agentDeploymentId?: string;
  readonly agentReleaseId?: string;
  readonly errorClass?: string;
  readonly executionPurpose?: (typeof EXECUTION_PURPOSES)[number];
  readonly range: MetricRange;
  readonly status?: (typeof TRACE_STATUSES)[number];
}

function matching(pattern: RegExp, value: unknown) {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

/**
 * Reads trace-list filters from untrusted input (URL search or a server-function payload).
 * Invalid values are dropped rather than rejected, so a stale link still lists traces.
 */
export function parseTraceFilters(search: Readonly<Record<string, unknown>>): TraceFilters {
  const agentDefinitionId = matching(ULID, search.agentDefinitionId);
  const agentDeploymentId = matching(ULID, search.agentDeploymentId);
  const agentReleaseId = matching(ULID, search.agentReleaseId);
  const errorClass = matching(OBSERVABILITY_IDENTIFIER, search.errorClass);
  const executionPurpose = oneOf(EXECUTION_PURPOSES, search.executionPurpose);
  const status = oneOf(TRACE_STATUSES, search.status);
  return {
    range: oneOf(METRIC_RANGES, search.range) ?? "7d",
    ...(agentDefinitionId ? { agentDefinitionId } : {}),
    ...(agentDeploymentId ? { agentDeploymentId } : {}),
    ...(agentReleaseId ? { agentReleaseId } : {}),
    ...(errorClass ? { errorClass } : {}),
    ...(executionPurpose ? { executionPurpose } : {}),
    ...(status ? { status } : {}),
  };
}
