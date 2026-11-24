/**
 * Longest a message stays hidden while its job waits. A hidden message blocks every newer message
 * in its FIFO group, which is one document, so this bounds how long a failing job delays a newer
 * job.
 */
const MAX_HOLD_SECONDS = 300;
const FAILED_DELIVERY_BASE_SECONDS = 2;

/**
 * Seconds until a delivery whose attempt threw is received again. The delay doubles with each
 * receive up to five minutes, and jitter spreads deliveries that conflicted together.
 */
export function failedDeliveryDelaySeconds(receiveCount: number, random: () => number) {
  const ceiling = Math.min(
    MAX_HOLD_SECONDS,
    FAILED_DELIVERY_BASE_SECONDS * 2 ** Math.max(0, (receiveCount || 1) - 1),
  );
  return Math.ceil((ceiling * (1 + random())) / 2);
}

/**
 * Seconds to hold a message until its job's due time, or undefined when the job is due later than
 * the hold allows. The caller then acknowledges the message and the dispatcher sweep sends the job
 * again once it is due, so a newer job for the same document runs first and supersedes it.
 */
export function dueDeliveryDelaySeconds(dueAt: string, now: Date) {
  const seconds = Math.max(1, Math.ceil((Date.parse(dueAt) - now.getTime()) / 1_000));
  return seconds <= MAX_HOLD_SECONDS ? seconds : undefined;
}
