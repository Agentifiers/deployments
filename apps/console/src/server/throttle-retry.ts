import "@tanstack/react-start/server-only";
import { PlatformApiError } from "../errors.ts";

/** Base back-off before retrying a 429; each retry waits base plus up to base of jitter. */
const RETRY_DELAYS_MS = [250, 750, 1_500] as const;

export type Sleep = (milliseconds: number) => Promise<void>;

const sleepFor: Sleep = (milliseconds) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
};

const HELD_REFUSALS: Readonly<Record<string, true>> = {
  brain_upload_quota_exceeded: true,
  budget_exhausted: true,
};

/**
 * Runs `task`, retrying `429` responses (hot-plane concurrency caps, API Gateway throttling) with
 * jittered back-off. A 429 means the request was not processed, so retrying is safe for every
 * operation. The refusals in `HELD_REFUSALS` last until unfinished uploads expire, an upload or
 * budget period ends, or a budget changes, so they propagate at once, as do other failures and the
 * last 429.
 */
export async function retryThrottled<Result>(
  task: () => Promise<Result>,
  sleep: Sleep = sleepFor,
): Promise<Result> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      const throttled =
        error instanceof PlatformApiError &&
        error.problem.status === 429 &&
        !Object.hasOwn(HELD_REFUSALS, error.problem.code ?? "");
      if (!throttled || !delay) throw error;
      await sleep(delay + Math.random() * delay);
    }
  }
}
