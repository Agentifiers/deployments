import { MemorySearchPlacementError } from "./placement.ts";
import type { MemoryIndexJob } from "./platform-types.ts";

/** Total claims a memory index job may consume before it fails terminally. */
export const INDEX_MAX_ATTEMPTS = 8;
/** Claims allowed when placement resolution rejects the job's target configuration. */
const INDEX_MAX_CONFIGURATION_ATTEMPTS = 2;
const INDEX_RETRY_BASE_MS = 5_000;
const INDEX_RETRY_GROWTH = 4;
const INDEX_RETRY_MAX_MS = 6 * 60 * 60_000;

const TERMINAL_FAILURE_REASONS: Readonly<Record<string, true>> = {
  "configuration-failure": true,
  "retries-exhausted": true,
  "target-draining": true,
};

/** Terminal jobs are never claimed or swept again unless an index request explicitly requeues them. */
export function isTerminalIndexJob(job: MemoryIndexJob) {
  return (
    job.data.status === "succeeded" ||
    (job.data.status === "failed" &&
      job.data.skipReason !== undefined &&
      TERMINAL_FAILURE_REASONS[job.data.skipReason] === true)
  );
}

/** A retryable failure is claimable only once its backoff elapses, whoever redelivers it. */
export function isIndexRetryPending(job: MemoryIndexJob, now: Date) {
  return (
    job.data.status === "failed" &&
    job.data.retryAt !== undefined &&
    Date.parse(job.data.retryAt) > now.getTime()
  );
}

/** A job that failed for good may be replaced once the delay its next retry would have waited passes. */
export function indexRetryBackoffElapsed(job: MemoryIndexJob, now: Date) {
  return Date.parse(job.data.updatedAt) + indexRetryDelayMs(job.data.attempt) <= now.getTime();
}

/** Seconds-scale first retries clear transient conflicts; the budget still spans about 7.6 hours. */
function indexRetryDelayMs(attempt: number) {
  const exponent = Math.min(Math.max(attempt - 1, 0), 30);
  return Math.min(INDEX_RETRY_MAX_MS, INDEX_RETRY_BASE_MS * INDEX_RETRY_GROWTH ** exponent);
}

/**
 * Classifies a failure raised while resolving the job's search routing or provider placement.
 * Provider registries reject invalid target configuration (for example an unapproved OpenSearch
 * endpoint) with `TypeError`; placement errors without a phase mean the organization has no usable
 * placement at all. Phase-bearing placement errors describe transitions and stay retryable.
 */
export function isIndexConfigurationFailure(cause: unknown) {
  return (
    cause instanceof TypeError ||
    (cause instanceof MemorySearchPlacementError && cause.phase === undefined)
  );
}

export function indexFailureOutcome(
  job: MemoryIndexJob,
  configurationFailure: boolean,
): { readonly retryAfterMs: number } | { readonly skipReason: string } {
  if (configurationFailure && job.data.attempt >= INDEX_MAX_CONFIGURATION_ATTEMPTS) {
    return { skipReason: "configuration-failure" };
  }
  if (job.data.attempt >= INDEX_MAX_ATTEMPTS) return { skipReason: "retries-exhausted" };
  return { retryAfterMs: indexRetryDelayMs(job.data.attempt) };
}
