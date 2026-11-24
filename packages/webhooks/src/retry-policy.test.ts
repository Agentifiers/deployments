import { describe, expect, test } from "bun:test";
import { applyWebhookDeliveryOutcome } from "./health.ts";
import { replaceWebhookEndpointRecord } from "./endpoints.ts";
import {
  MAX_WEBHOOK_DELIVERY_ATTEMPTS,
  WEBHOOK_AUTO_DISABLE_THRESHOLD,
  isRetryableWebhookStatus,
  webhookRetryDelayMs,
} from "./retry-policy.ts";
import { endpoint } from "./webhooks.fixture.ts";

describe("webhook retry policy", () => {
  test("doubles from one minute with equal jitter and a six-hour cap", () => {
    expect(webhookRetryDelayMs(1, () => 0)).toBe(30_000);
    expect(webhookRetryDelayMs(1, () => 1)).toBe(60_000);
    expect(webhookRetryDelayMs(3, () => 0.5)).toBe(180_000);
    expect(webhookRetryDelayMs(20, () => 1)).toBe(6 * 3_600_000);
    for (let attempt = 1; attempt < MAX_WEBHOOK_DELIVERY_ATTEMPTS; attempt += 1) {
      const delay = webhookRetryDelayMs(attempt);
      const nominal = 60_000 * 2 ** (attempt - 1);
      expect(delay).toBeGreaterThanOrEqual(nominal / 2);
      expect(delay).toBeLessThanOrEqual(nominal);
    }
    const nominalWindow = Array.from({ length: MAX_WEBHOOK_DELIVERY_ATTEMPTS - 1 }, (_, index) =>
      webhookRetryDelayMs(index + 1, () => 1),
    ).reduce((total, delay) => total + delay, 0);
    expect(nominalWindow).toBe(511 * 60_000);
  });

  test("retries network errors, throttling, conflicts, and server errors only", () => {
    for (const status of [undefined, 408, 409, 425, 429, 500, 503]) {
      expect(isRetryableWebhookStatus(status)).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 410, 422]) {
      expect(isRetryableWebhookStatus(status)).toBe(false);
    }
  });
});

describe("webhook endpoint health", () => {
  const now = new Date("2026-07-21T00:00:00.000Z");

  test("disables an active endpoint at the consecutive-failure threshold", () => {
    let current = endpoint;
    for (let failure = 1; failure < WEBHOOK_AUTO_DISABLE_THRESHOLD; failure += 1) {
      const change = applyWebhookDeliveryOutcome(current, "failed", now);
      if (change.kind !== "updated") throw new Error(`Expected an update, got ${change.kind}.`);
      expect(change.record.data).toMatchObject({ consecutiveFailures: failure, status: "active" });
      current = change.record;
    }
    const change = applyWebhookDeliveryOutcome(current, "failed", now);
    expect(change.kind).toBe("disabled");
    if (change.kind !== "disabled") return;
    expect(change.record.data).toMatchObject({
      consecutiveFailures: WEBHOOK_AUTO_DISABLE_THRESHOLD,
      disabledAt: now.toISOString(),
      disabledReason: "consecutive-failures",
      status: "disabled",
      version: endpoint.data.version + WEBHOOK_AUTO_DISABLE_THRESHOLD,
    });
  });

  test("resets the counter on success and writes nothing when it is already zero", () => {
    expect(applyWebhookDeliveryOutcome(endpoint, "delivered", now)).toEqual({ kind: "unchanged" });
    const failing = replaceWebhookEndpointRecord(endpoint, { consecutiveFailures: 7, now });
    const change = applyWebhookDeliveryOutcome(failing, "delivered", now);
    if (change.kind !== "updated") throw new Error("Expected a reset.");
    expect(change.record.data).not.toHaveProperty("consecutiveFailures");
  });

  test("never revives or re-disables a disabled or archived endpoint", () => {
    const disabled = replaceWebhookEndpointRecord(endpoint, {
      consecutiveFailures: WEBHOOK_AUTO_DISABLE_THRESHOLD,
      disabled: { at: now, reason: "consecutive-failures" },
      now,
      status: "disabled",
    });
    const change = applyWebhookDeliveryOutcome(disabled, "failed", now);
    expect(change).toMatchObject({ kind: "updated" });
    expect(change.kind === "updated" && change.record.data.status).toBe("disabled");
    const archived = replaceWebhookEndpointRecord(endpoint, { now, status: "archived" });
    expect(applyWebhookDeliveryOutcome(archived, "failed", now)).toEqual({ kind: "unchanged" });
  });
});
