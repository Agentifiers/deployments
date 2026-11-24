import { describe, expect, test } from "bun:test";
import { replaceWebhookEndpointRecord } from "./endpoints.ts";
import {
  activeWebhookSigningSecrets,
  rotateWebhookSigningSecretValues,
  verifyWebhookSignature,
  webhookSignature,
  webhookSignatureHeader,
} from "./signing.ts";
import { endpoint } from "./webhooks.fixture.ts";

const body = JSON.stringify({ eventId: "evt", version: 1 });
const sentAt = Date.parse("2026-07-20T12:00:00.000Z");

describe("webhook signing", () => {
  test("signs the timestamp and body with HMAC-SHA256", () => {
    expect(webhookSignature("{}", "secret", 123)).toBe(
      "v1=4468c5e304ca107335ae2982d764fdf304214175c7dc3ad06921848d275abb92",
    );
    expect(webhookSignatureHeader("{}", 123, ["secret", "older"])).toBe(
      `${webhookSignature("{}", "secret", 123)},${webhookSignature("{}", "older", 123)}`,
    );
    expect(() => webhookSignatureHeader("{}", 123, [])).toThrow("signing secret is required");
  });

  test("verifies against any accepted secret and rejects tampering and stale timestamps", () => {
    const signature = webhookSignatureHeader(body, sentAt, ["current"]);
    const verify = (overrides: Partial<Parameters<typeof verifyWebhookSignature>[0]>) =>
      verifyWebhookSignature({
        body,
        now: new Date(sentAt + 1_000),
        secrets: ["current"],
        signature,
        timestamp: String(sentAt),
        ...overrides,
      });
    expect(verify({})).toBe(true);
    expect(verify({ secrets: ["other", "current"] })).toBe(true);
    expect(verify({ secrets: ["other"] })).toBe(false);
    expect(verify({ body: `${body} ` })).toBe(false);
    expect(verify({ timestamp: String(sentAt + 1) })).toBe(false);
    expect(verify({ now: new Date(sentAt + 5 * 60_000 + 1) })).toBe(false);
    expect(verify({ signature: undefined })).toBe(false);
    expect(verify({ signature: "v0=abc" })).toBe(false);
  });

  test("signs with both secrets during the rotation overlap and only the new one after it", () => {
    const vault = { signingSecret: "old-secret" };
    const rotatedValues = rotateWebhookSigningSecretValues(vault, 3_600_000, "new-secret");
    expect(rotatedValues).toEqual({
      previousSigningSecret: "old-secret",
      signingSecret: "new-secret",
    });
    const rotatedAt = new Date(sentAt);
    const rotated = replaceWebhookEndpointRecord(endpoint, {
      now: rotatedAt,
      previousSigningSecretExpiresAt: new Date(sentAt + 3_600_000),
      signingSecretRotatedAt: rotatedAt,
    });

    const duringOverlap = new Date(sentAt + 3_599_000);
    const secrets = activeWebhookSigningSecrets(rotated, rotatedValues, duringOverlap);
    expect(secrets).toEqual(["new-secret", "old-secret"]);
    const header = webhookSignatureHeader(body, duringOverlap.getTime(), secrets);
    // A receiver still configured with only the old secret keeps verifying during the overlap,
    // and a receiver already switched to the new secret verifies too.
    for (const receiverSecrets of [["old-secret"], ["new-secret"], ["new-secret", "old-secret"]]) {
      expect(
        verifyWebhookSignature({
          body,
          now: duringOverlap,
          secrets: receiverSecrets,
          signature: header,
          timestamp: String(duringOverlap.getTime()),
        }),
      ).toBe(true);
    }

    const afterOverlap = new Date(sentAt + 3_600_000);
    const later = activeWebhookSigningSecrets(rotated, rotatedValues, afterOverlap);
    expect(later).toEqual(["new-secret"]);
    expect(
      verifyWebhookSignature({
        body,
        now: afterOverlap,
        secrets: ["old-secret"],
        signature: webhookSignatureHeader(body, afterOverlap.getTime(), later),
        timestamp: String(afterOverlap.getTime()),
      }),
    ).toBe(false);
  });

  test("drops the previous secret immediately with a zero overlap and bounds the overlap", () => {
    expect(rotateWebhookSigningSecretValues({ signingSecret: "old" }, 0, "new")).toEqual({
      signingSecret: "new",
    });
    expect(() => rotateWebhookSigningSecretValues({ signingSecret: "old" }, -1)).toThrow();
    expect(() =>
      rotateWebhookSigningSecretValues({ signingSecret: "old" }, 7 * 86_400_000 + 1),
    ).toThrow();
    expect(() => rotateWebhookSigningSecretValues({}, 1_000)).toThrow("unavailable");
    expect(() => activeWebhookSigningSecrets(endpoint, {}, new Date())).toThrow("unavailable");
  });
});
