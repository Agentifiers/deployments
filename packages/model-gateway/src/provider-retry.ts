import type { ModelGatewayRequestError } from "./types.ts";

/**
 * Transient provider failures (upstream rate limits, gateway/upstream 5xx, capacity envelopes,
 * transient mid-stream error events, idle streams) are retried against the same request body.
 * Chat completions and embeddings are stateless, so resending is idempotent; any in-body
 * `fallbacks` are re-evaluated by Bifrost on each attempt, so the primary route is always retried
 * before a fallback model serves the request. A streamed attempt that already delivered assistant
 * text is never replayed (see `readChatCompletionEventStream`).
 *
 * Budget: at most 3 retries × 10 s capped waits = 30 s of backoff, and no retry starts once 60 s
 * have elapsed since the first attempt, so a slow terminal failure (e.g. a 504 after a long
 * upstream wait) is surfaced to the runtime's model fallback chain instead of being repeated.
 */
const PROVIDER_RETRY_MAX_RETRIES = 3;
const PROVIDER_RETRY_MAX_DELAY_MS = 10_000;
const PROVIDER_RETRY_BASE_DELAY_MS = 1_000;
const PROVIDER_RETRY_WINDOW_MS = 60_000;

const RETRYABLE_PROVIDER_STATUSES: Record<number, true> = {
  429: true,
  502: true,
  503: true,
  504: true,
};
/** OpenRouter's generic upstream failure; transient when paired with a 5xx status. */
const UPSTREAM_PROVIDER_ERROR_PATTERN = /provider returned error/iu;
/** In-body provider error codes (HTTP 200 envelopes) that signal transient capacity loss. */
export const RETRYABLE_PROVIDER_ERROR_CODES: Record<string, true> = { capacity_exhausted: true };
/**
 * Model gateway 502 refusals for organization-funded requests. A retry cannot fix either one, and
 * resending after `funding_mismatch` would repeat a call the operator's pool key already paid for.
 */
const TERMINAL_GATEWAY_ERROR_CODES: Record<string, true> = {
  funding_mismatch: true,
  model_credential_store_unavailable: true,
};

export type ProviderRetrySleep = (
  delayMs: number,
  signal: AbortSignal | undefined,
) => Promise<void>;

export type ProviderAttemptResult<T> =
  | { readonly kind: "succeeded"; readonly value: T }
  | {
      readonly failure: ModelGatewayRequestError;
      readonly kind: "retryable";
      /** Response headers of the failed attempt, consulted for `Retry-After`. */
      readonly headers: Headers;
    };

export function retryableProviderStatus(
  status: number,
  providerMessage: string | undefined,
  providerCode: string | undefined,
) {
  if (providerCode !== undefined && TERMINAL_GATEWAY_ERROR_CODES[providerCode]) return false;
  if (RETRYABLE_PROVIDER_STATUSES[status]) return true;
  return (
    status >= 500 &&
    status < 600 &&
    providerMessage !== undefined &&
    UPSTREAM_PROVIDER_ERROR_PATTERN.test(providerMessage)
  );
}

/** Parses `Retry-After` as delta-seconds or an HTTP-date; unparseable values are ignored. */
function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/u.test(value)) return Math.round(Number(value) * 1_000);
  const retryAt = Date.parse(value);
  return Number.isNaN(retryAt) ? undefined : Math.max(0, retryAt - now);
}

/** Honors a capped `Retry-After`; otherwise exponential backoff with equal jitter. */
function providerRetryDelayMs(retry: number, retryAfter: number | undefined) {
  if (retryAfter !== undefined) return Math.min(retryAfter, PROVIDER_RETRY_MAX_DELAY_MS);
  const ceiling = PROVIDER_RETRY_BASE_DELAY_MS * 2 ** retry;
  return Math.min(ceiling / 2 + (Math.random() * ceiling) / 2, PROVIDER_RETRY_MAX_DELAY_MS);
}

async function sleepUnlessAborted(delayMs: number, signal: AbortSignal | undefined) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs `attempt` until it succeeds, throws a non-retryable error, or the retry budget is spent;
 * on exhaustion the last attempt's terminal error is thrown unchanged.
 */
export async function requestWithProviderRetry<T>(options: {
  readonly attempt: () => Promise<ProviderAttemptResult<T>>;
  readonly signal?: AbortSignal;
  readonly sleep?: ProviderRetrySleep;
}): Promise<T> {
  const sleep = options.sleep ?? sleepUnlessAborted;
  const startedAt = Date.now();
  for (let retry = 0; ; retry += 1) {
    options.signal?.throwIfAborted();
    const result = await options.attempt();
    if (result.kind === "succeeded") return result.value;
    if (retry >= PROVIDER_RETRY_MAX_RETRIES || Date.now() - startedAt >= PROVIDER_RETRY_WINDOW_MS) {
      throw result.failure;
    }
    const retryAfter = retryAfterMs(result.headers);
    await sleep(providerRetryDelayMs(retry, retryAfter), options.signal);
  }
}
