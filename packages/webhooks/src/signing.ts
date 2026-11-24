import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { WebhookEndpoint } from "./endpoints.ts";

export const WEBHOOK_SIGNATURE_HEADER = "x-deployments-signature";
export const WEBHOOK_TIMESTAMP_HEADER = "x-deployments-timestamp";
export const WEBHOOK_SIGNATURE_VERSION = "v1";
/** Receivers should reject requests whose timestamp is further than this from their clock. */
export const WEBHOOK_SIGNATURE_TOLERANCE_MS = 5 * 60_000;
export const DEFAULT_WEBHOOK_SECRET_OVERLAP_MS = 24 * 60 * 60_000;
export const MAX_WEBHOOK_SECRET_OVERLAP_MS = 7 * 24 * 60 * 60_000;

/** Vault document values of a webhook signing credential. */
export type WebhookSigningSecretValues = {
  readonly previousSigningSecret?: string;
  readonly signingSecret: string;
};

export function generateWebhookSigningSecret() {
  return randomBytes(32).toString("base64url");
}

/** `v1=` HMAC-SHA256 over `<timestampMs>.<body>`, hex encoded. */
export function webhookSignature(body: string, signingSecret: string, timestampMs: number) {
  return `${WEBHOOK_SIGNATURE_VERSION}=${createHmac("sha256", signingSecret)
    .update(`${timestampMs}.${body}`)
    .digest("hex")}`;
}

/** One signature per accepted secret, current secret first, comma separated. */
export function webhookSignatureHeader(
  body: string,
  timestampMs: number,
  signingSecrets: readonly string[],
) {
  if (signingSecrets.length === 0) throw new Error("A webhook signing secret is required.");
  return signingSecrets.map((secret) => webhookSignature(body, secret, timestampMs)).join(",");
}

/**
 * Secrets that sign a request right now: the current secret, plus the previous secret while the
 * endpoint's rotation overlap has not ended. The overlap end is checked logically; the vault
 * entry keeps the previous value until the next rotation replaces it.
 */
export function activeWebhookSigningSecrets(
  endpoint: WebhookEndpoint,
  values: Readonly<Record<string, string>>,
  now: Date,
) {
  const current = values.signingSecret?.trim();
  if (!current) throw new Error("Webhook signing secret is unavailable.");
  const previous = values.previousSigningSecret?.trim();
  const overlapEnds = endpoint.data.previousSigningSecretExpiresAt;
  return previous && overlapEnds && Date.parse(overlapEnds) > now.getTime()
    ? [current, previous]
    : [current];
}

/**
 * Builds the vault values for a rotation. The outgoing secret is kept as the previous secret
 * only when the overlap is positive; a zero overlap revokes it immediately.
 */
export function rotateWebhookSigningSecretValues(
  current: Readonly<Record<string, string>>,
  overlapMs: number,
  nextSecret = generateWebhookSigningSecret(),
): WebhookSigningSecretValues {
  if (
    !Number.isSafeInteger(overlapMs) ||
    overlapMs < 0 ||
    overlapMs > MAX_WEBHOOK_SECRET_OVERLAP_MS
  ) {
    throw new Error("Webhook secret overlap must be between zero seconds and seven days.");
  }
  const outgoing = current.signingSecret?.trim();
  if (!outgoing) throw new Error("Webhook signing secret is unavailable.");
  return overlapMs > 0
    ? { previousSigningSecret: outgoing, signingSecret: nextSecret }
    : { signingSecret: nextSecret };
}

export interface VerifyWebhookSignatureOptions {
  readonly body: string;
  readonly now?: Date;
  /** Every secret the receiver currently accepts, typically the new and the previous secret. */
  readonly secrets: readonly string[];
  readonly signature: string | null | undefined;
  readonly timestamp: string | null | undefined;
  readonly toleranceMs?: number;
}

/**
 * Receiver-side verification: the timestamp must be within tolerance and at least one `v1`
 * signature in the header must match one accepted secret, compared in constant time.
 */
export function verifyWebhookSignature(options: VerifyWebhookSignatureOptions) {
  const timestampMs = Number(options.timestamp);
  if (!options.signature || !Number.isSafeInteger(timestampMs)) return false;
  const now = (options.now ?? new Date()).getTime();
  if (Math.abs(now - timestampMs) > (options.toleranceMs ?? WEBHOOK_SIGNATURE_TOLERANCE_MS)) {
    return false;
  }
  const presented = options.signature
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${WEBHOOK_SIGNATURE_VERSION}=`))
    .map((entry) => Buffer.from(entry));
  return options.secrets.some((secret) => {
    const expected = Buffer.from(webhookSignature(options.body, secret, timestampMs));
    return presented.some(
      (candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected),
    );
  });
}
