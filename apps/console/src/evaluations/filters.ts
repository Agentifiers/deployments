import { oneOf } from "../observability/range.ts";

export const RESOURCE_STATUSES = ["active", "archived"] as const;
export const RUN_STATUSES = ["queued", "running", "completed", "failed", "canceled"] as const;
export const COMPARISON_STATUSES = ["queued", "running", "completed", "failed"] as const;

export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

/** Datasets and scorers list one status at a time, or both when the filter is absent. */
export interface ResourceFilters {
  readonly status?: ResourceStatus;
}

export interface EvaluationRunFilters {
  readonly agentReleaseId?: string;
  readonly datasetId?: string;
  readonly status?: (typeof RUN_STATUSES)[number];
}

export interface ComparisonFilters {
  readonly baselineReleaseId?: string;
  readonly candidateReleaseId?: string;
  readonly status?: (typeof COMPARISON_STATUSES)[number];
}

function ulid(value: unknown) {
  return typeof value === "string" && ULID.test(value) ? value : undefined;
}

/*
 * The parsers read untrusted input (URL search or a server-function payload). Invalid values are
 * dropped rather than rejected, so a stale link still lists something.
 */

export function parseResourceFilters(search: Readonly<Record<string, unknown>>): ResourceFilters {
  const status = oneOf(RESOURCE_STATUSES, search.status);
  return status ? { status } : {};
}

export function parseRunFilters(search: Readonly<Record<string, unknown>>): EvaluationRunFilters {
  const agentReleaseId = ulid(search.agentReleaseId);
  const datasetId = ulid(search.datasetId);
  const status = oneOf(RUN_STATUSES, search.status);
  return {
    ...(agentReleaseId ? { agentReleaseId } : {}),
    ...(datasetId ? { datasetId } : {}),
    ...(status ? { status } : {}),
  };
}

export function parseComparisonFilters(
  search: Readonly<Record<string, unknown>>,
): ComparisonFilters {
  const baselineReleaseId = ulid(search.baselineReleaseId);
  const candidateReleaseId = ulid(search.candidateReleaseId);
  const status = oneOf(COMPARISON_STATUSES, search.status);
  return {
    ...(baselineReleaseId ? { baselineReleaseId } : {}),
    ...(candidateReleaseId ? { candidateReleaseId } : {}),
    ...(status ? { status } : {}),
  };
}
