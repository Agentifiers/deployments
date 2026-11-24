import { replaceWebhookEndpointRecord, type WebhookEndpoint } from "./endpoints.ts";
import { WEBHOOK_AUTO_DISABLE_THRESHOLD } from "./retry-policy.ts";

export type WebhookEndpointHealthChange =
  | { readonly kind: "unchanged" }
  | { readonly kind: "updated"; readonly record: WebhookEndpoint }
  /** The threshold was reached: the record is disabled and needs a `webhook.endpoint.disabled` event. */
  | { readonly kind: "disabled"; readonly record: WebhookEndpoint };

/**
 * Applies a terminal delivery outcome to the endpoint's consecutive-failure counter. Success
 * resets the counter (a write only when it was non-zero); a delivery that ends `failed` increments
 * it, and reaching the threshold disables an active endpoint.
 */
export function applyWebhookDeliveryOutcome(
  endpoint: WebhookEndpoint,
  outcome: "delivered" | "failed",
  now: Date,
  threshold = WEBHOOK_AUTO_DISABLE_THRESHOLD,
): WebhookEndpointHealthChange {
  const failures = endpoint.data.consecutiveFailures ?? 0;
  if (outcome === "delivered") {
    return failures === 0
      ? { kind: "unchanged" }
      : {
          kind: "updated",
          record: replaceWebhookEndpointRecord(endpoint, { consecutiveFailures: null, now }),
        };
  }
  if (endpoint.data.status === "archived") return { kind: "unchanged" };
  const next = failures + 1;
  if (endpoint.data.status === "active" && next >= threshold) {
    return {
      kind: "disabled",
      record: replaceWebhookEndpointRecord(endpoint, {
        consecutiveFailures: next,
        disabled: { at: now, reason: "consecutive-failures" },
        now,
        status: "disabled",
      }),
    };
  }
  return {
    kind: "updated",
    record: replaceWebhookEndpointRecord(endpoint, { consecutiveFailures: next, now }),
  };
}
