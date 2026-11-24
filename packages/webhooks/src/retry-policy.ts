/** Automatic attempts per delivery, including the first. */
export const MAX_WEBHOOK_DELIVERY_ATTEMPTS = 10;
export const INITIAL_WEBHOOK_RETRY_DELAY_MS = 60_000;
export const MAX_WEBHOOK_RETRY_DELAY_MS = 6 * 60 * 60_000;
export const WEBHOOK_REQUEST_TIMEOUT_MS = 15_000;
export const WEBHOOK_DELIVERY_CLAIM_LEASE_MS = 60_000;
/** Consecutive deliveries that exhaust their attempts before the endpoint is disabled. */
export const WEBHOOK_AUTO_DISABLE_THRESHOLD = 20;

export function isRetryableWebhookStatus(status: number | undefined) {
  return (
    status === undefined ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

/**
 * Delay after failed attempt `attempt` (1-based): exponential from one minute, doubling, capped
 * at six hours, with equal jitter so the delay lands uniformly in `[nominal / 2, nominal]`. With
 * ten attempts the nominal schedule spans 1+2+4+…+256 minutes, about 8.5 hours.
 */
export function webhookRetryDelayMs(attempt: number, random: () => number = Math.random) {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const nominal = Math.min(
    MAX_WEBHOOK_RETRY_DELAY_MS,
    INITIAL_WEBHOOK_RETRY_DELAY_MS * 2 ** (safeAttempt - 1),
  );
  const half = nominal / 2;
  return Math.round(half + half * Math.min(1, Math.max(0, random())));
}
