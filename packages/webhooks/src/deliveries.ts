import {
  WebhookDeliveryAttemptRecord,
  WebhookDeliveryRecord,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import type { SemanticEvent } from "@deployments-ai/events";
import { Schema } from "effect";
import {
  normalizeWebhookUrl,
  webhookEndpointReceivesEvent,
  webhookEventReachesEndpoint,
  type WebhookEndpoint,
} from "./endpoints.ts";
import {
  MAX_WEBHOOK_DELIVERY_ATTEMPTS,
  WEBHOOK_DELIVERY_CLAIM_LEASE_MS,
  WEBHOOK_REQUEST_TIMEOUT_MS,
  isRetryableWebhookStatus,
  webhookRetryDelayMs,
} from "./retry-policy.ts";
import {
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  webhookSignatureHeader,
} from "./signing.ts";

export const WEBHOOK_USER_AGENT = "deployments-ai-webhooks/1.0";
export const MAX_WEBHOOK_RESPONSE_EXCERPT_BYTES = 1_024;
export const MAX_WEBHOOK_DELIVERY_RETENTION_DAYS = 3_650;

export type WebhookDelivery = typeof WebhookDeliveryRecord.Type;
export type WebhookDeliveryAttempt = typeof WebhookDeliveryAttemptRecord.Type;
export type WebhookDeliveryFailureReason = NonNullable<WebhookDelivery["data"]["failureReason"]>;

export interface WebhookPayload {
  readonly aggregateId: Ulid;
  readonly aggregateType: string;
  readonly aggregateVersion: number;
  readonly deliveryId: Ulid;
  readonly endpointId: Ulid;
  readonly eventId: Ulid;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly organizationId: Ulid;
  readonly payload: SemanticEvent["payload"];
  readonly source: "deployments-ai.platform";
  readonly version: 1;
}

export interface WebhookRequest {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly url: string;
}

export interface WebhookRequestSender {
  readonly send: (request: WebhookRequest) => Promise<Response>;
}

/** Permanent destination-security rejection; never retried. */
export class TerminalWebhookSenderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TerminalWebhookSenderError";
  }
}

export function webhookDeliveryRetentionExpiresAt(from: Date, retentionDays: number) {
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > MAX_WEBHOOK_DELIVERY_RETENTION_DAYS
  ) {
    throw new Error("Webhook delivery retention must be a whole number of days from 1 to 3650.");
  }
  return new Date(from.getTime() + retentionDays * 86_400_000).toISOString();
}

function deliveryRecord(data: WebhookDelivery["data"]) {
  return Schema.decodeUnknownSync(WebhookDeliveryRecord)(
    withCanonicalRecordKeys({
      data,
      itemType: "webhook-delivery",
      ttl: Math.floor(Date.parse(data.retentionExpiresAt) / 1_000),
    }),
  );
}

/** Next version of a delivery with `update` applied and `omitted` optional fields removed. */
function nextDelivery(
  delivery: WebhookDelivery,
  update: Partial<WebhookDelivery["data"]>,
  now: Date,
  omitted: readonly (keyof WebhookDelivery["data"])[],
) {
  const retained = Object.fromEntries(
    Object.entries(delivery.data).filter(
      ([name]) => !omitted.includes(name as keyof WebhookDelivery["data"]),
    ),
  ) as WebhookDelivery["data"];
  return deliveryRecord({
    ...retained,
    ...update,
    updatedAt: now.toISOString(),
    version: delivery.data.version + 1,
  });
}

export function makeWebhookDeliveryRecord(options: {
  readonly endpoint: WebhookEndpoint;
  readonly event: SemanticEvent;
  readonly id: Ulid;
  readonly now: Date;
  readonly retentionDays: number;
}): WebhookDelivery {
  if (!webhookEndpointReceivesEvent(options.endpoint, options.event)) {
    throw new Error("Webhook endpoint does not receive this semantic event.");
  }
  const now = options.now.toISOString();
  return deliveryRecord({
    aggregateId: options.event.aggregateId,
    aggregateType: options.event.aggregateType,
    aggregateVersion: options.event.aggregateVersion,
    attempt: 0,
    createdAt: now,
    environmentId: options.endpoint.data.environmentId,
    eventId: options.event.eventId,
    eventType: options.event.eventType,
    id: options.id,
    maxAttempts: MAX_WEBHOOK_DELIVERY_ATTEMPTS,
    nextAttemptAt: now,
    organizationId: options.endpoint.data.organizationId,
    projectId: options.endpoint.data.projectId,
    retentionExpiresAt: webhookDeliveryRetentionExpiresAt(options.now, options.retentionDays),
    status: "pending",
    updatedAt: now,
    version: 0,
    webhookEndpointId: options.endpoint.data.id,
  });
}

export function buildWebhookPayload(
  delivery: WebhookDelivery,
  endpoint: WebhookEndpoint,
  event: SemanticEvent,
): WebhookPayload {
  if (
    delivery.data.eventId !== event.eventId ||
    delivery.data.aggregateId !== event.aggregateId ||
    delivery.data.aggregateType !== event.aggregateType ||
    delivery.data.aggregateVersion !== event.aggregateVersion ||
    delivery.data.webhookEndpointId !== endpoint.data.id ||
    delivery.data.organizationId !== endpoint.data.organizationId ||
    delivery.data.projectId !== endpoint.data.projectId ||
    delivery.data.environmentId !== endpoint.data.environmentId ||
    !webhookEventReachesEndpoint(endpoint, event)
  ) {
    throw new Error("Webhook delivery does not match its endpoint and semantic event.");
  }
  return {
    aggregateId: event.aggregateId,
    aggregateType: event.aggregateType,
    aggregateVersion: event.aggregateVersion,
    deliveryId: delivery.data.id,
    endpointId: endpoint.data.id,
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    organizationId: event.organizationId,
    payload: event.payload,
    source: "deployments-ai.platform",
    version: 1,
  };
}

/**
 * Signed request headers. The event ID is the receiver's idempotency key: it is stable across
 * every attempt and manual retry of the same event to the same endpoint.
 */
export function webhookRequestHeaders(options: {
  readonly body: string;
  readonly deliveryId: Ulid;
  readonly eventId: Ulid;
  readonly eventType: string;
  readonly signingSecrets: readonly string[];
  readonly timestampMs: number;
}) {
  return {
    "content-type": "application/json",
    "user-agent": WEBHOOK_USER_AGENT,
    "x-deployments-delivery-id": options.deliveryId,
    "x-deployments-event-id": options.eventId,
    "x-deployments-event-type": options.eventType,
    [WEBHOOK_SIGNATURE_HEADER]: webhookSignatureHeader(
      options.body,
      options.timestampMs,
      options.signingSecrets,
    ),
    [WEBHOOK_TIMESTAMP_HEADER]: String(options.timestampMs),
  };
}

export type WebhookClaimDecision =
  | { readonly kind: "claimed"; readonly record: WebhookDelivery }
  | { readonly kind: "terminal"; readonly record: WebhookDelivery }
  /** Not due yet, or another worker holds an unexpired lease: look again at `dueAt`. */
  | { readonly dueAt: Date; readonly kind: "wait"; readonly record: WebhookDelivery };

/**
 * Leases the next attempt. A `sending` record whose lease expired (a crashed worker) is
 * reclaimed without advancing the attempt number.
 */
export function claimWebhookDeliveryAttempt(options: {
  readonly claimId: Ulid;
  readonly delivery: WebhookDelivery;
  readonly leaseDurationMs?: number;
  readonly now: Date;
}): WebhookClaimDecision {
  const { delivery, now } = options;
  const leaseDurationMs = options.leaseDurationMs ?? WEBHOOK_DELIVERY_CLAIM_LEASE_MS;
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error("Webhook delivery claim leases must use positive integer milliseconds.");
  }
  const status = delivery.data.status;
  if (status === "delivered" || status === "failed") return { kind: "terminal", record: delivery };
  const dueAt = new Date(
    Date.parse(
      (status === "sending" ? delivery.data.claimExpiresAt : delivery.data.nextAttemptAt) ??
        delivery.data.updatedAt,
    ),
  );
  if (dueAt.getTime() > now.getTime()) return { dueAt, kind: "wait", record: delivery };
  if (status !== "sending" && delivery.data.attempt >= delivery.data.maxAttempts) {
    return { kind: "terminal", record: delivery };
  }
  const claimExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
  return {
    kind: "claimed",
    record: nextDelivery(
      delivery,
      {
        attempt: status === "sending" ? delivery.data.attempt : delivery.data.attempt + 1,
        claimExpiresAt,
        claimId: options.claimId,
        lastAttemptAt: now.toISOString(),
        nextAttemptAt: claimExpiresAt,
        status: "sending",
      },
      now,
      [],
    ),
  };
}

/** Terminal failure decided without sending (inactive endpoint, missing canonical event). */
export function failWebhookDelivery(
  delivery: WebhookDelivery,
  reason: WebhookDeliveryFailureReason,
  message: string,
  now: Date,
) {
  return nextDelivery(
    delivery,
    { failureReason: reason, lastError: message.slice(0, 2_000), status: "failed" },
    now,
    ["claimExpiresAt", "claimId", "manualRetryRequestedAt", "nextAttemptAt"],
  );
}

/**
 * Re-arms a terminal delivery for exactly one more attempt. Manual retries share the delivery's
 * event ID, so receivers that deduplicate on it treat a replay of a delivered event as a repeat.
 */
export function rearmWebhookDeliveryForManualRetry(delivery: WebhookDelivery, now: Date) {
  if (delivery.data.status !== "delivered" && delivery.data.status !== "failed") {
    throw new Error("Only delivered or failed webhook deliveries can be retried.");
  }
  if (Date.parse(delivery.data.retentionExpiresAt) <= now.getTime()) {
    throw new Error("Webhook delivery retention has expired.");
  }
  return nextDelivery(
    delivery,
    {
      manualRetryRequestedAt: now.toISOString(),
      maxAttempts: delivery.data.attempt + 1,
      nextAttemptAt: now.toISOString(),
      status: "pending",
    },
    now,
    ["claimExpiresAt", "claimId", "failureReason"],
  );
}

async function responseExcerpt(response: Response) {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_WEBHOOK_RESPONSE_EXCERPT_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = Buffer.concat(chunks).subarray(0, MAX_WEBHOOK_RESPONSE_EXCERPT_BYTES);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
  return text || undefined;
}

const INSPECTABLE_RESPONSE_HEADERS: Readonly<Record<string, true>> = {
  "content-length": true,
  "content-type": true,
  date: true,
  "retry-after": true,
  "x-amzn-requestid": true,
  "x-correlation-id": true,
  "x-request-id": true,
};

function inspectableHeaders(headers: Headers) {
  return Object.fromEntries(
    [...headers.entries()]
      .filter(([name]) => INSPECTABLE_RESPONSE_HEADERS[name.toLowerCase()])
      .map(([name, value]) => [name.toLowerCase(), value.slice(0, 1_000)]),
  );
}

export type WebhookAttemptOutcome =
  | { readonly kind: "not-claimed"; readonly record: WebhookDelivery }
  | {
      readonly attempt: WebhookDeliveryAttempt;
      readonly kind: "delivered" | "failed" | "retrying";
      readonly record: WebhookDelivery;
      readonly retryDelayMs?: number;
    };

/**
 * Sends one claimed attempt and returns the next delivery record plus the immutable attempt
 * record. Retries are scheduled from request completion with jittered exponential backoff.
 */
export async function deliverWebhookAttempt(options: {
  readonly claimId: Ulid;
  readonly clock: () => Date;
  readonly delivery: WebhookDelivery;
  readonly endpoint: WebhookEndpoint;
  readonly event: SemanticEvent;
  readonly random?: () => number;
  readonly retentionDays: number;
  readonly sender: WebhookRequestSender;
  readonly signingSecrets: readonly string[];
  readonly timeoutMs?: number;
}): Promise<WebhookAttemptOutcome> {
  const { delivery, endpoint, event } = options;
  const startedAt = options.clock();
  const claimExpiresAt = Date.parse(delivery.data.claimExpiresAt ?? "");
  if (
    delivery.data.status !== "sending" ||
    delivery.data.claimId !== options.claimId ||
    !Number.isFinite(claimExpiresAt) ||
    claimExpiresAt <= startedAt.getTime() ||
    delivery.data.attempt < 1 ||
    delivery.data.attempt > delivery.data.maxAttempts
  ) {
    return { kind: "not-claimed", record: delivery };
  }
  const attempt = delivery.data.attempt;
  const body = JSON.stringify(buildWebhookPayload(delivery, endpoint, event));
  let response: Response | undefined;
  let excerpt: string | undefined;
  let failure: unknown;
  try {
    if (endpoint.data.status !== "active") {
      throw new TerminalWebhookSenderError("Webhook endpoint is not active.");
    }
    let url: string;
    try {
      url = normalizeWebhookUrl(endpoint.data.url);
    } catch (cause) {
      throw new TerminalWebhookSenderError("Webhook destination is not a public HTTPS URL.", {
        cause,
      });
    }
    response = await options.sender.send({
      body,
      headers: webhookRequestHeaders({
        body,
        deliveryId: delivery.data.id,
        eventId: event.eventId,
        eventType: event.eventType,
        signingSecrets: options.signingSecrets,
        timestampMs: startedAt.getTime(),
      }),
      timeoutMs: Math.max(
        1,
        Math.min(
          options.timeoutMs ?? WEBHOOK_REQUEST_TIMEOUT_MS,
          claimExpiresAt - startedAt.getTime(),
        ),
      ),
      url,
    });
    excerpt = await responseExcerpt(response).catch(() => undefined);
    if (!response.ok) failure = new Error(`Webhook endpoint returned ${response.status}.`);
  } catch (cause) {
    failure = cause;
  }
  const completedAt = options.clock();
  const retentionExpiresAt = webhookDeliveryRetentionExpiresAt(completedAt, options.retentionDays);
  const retryableStatus =
    !(failure instanceof TerminalWebhookSenderError) && isRetryableWebhookStatus(response?.status);
  const retryable = failure !== undefined && retryableStatus && attempt < delivery.data.maxAttempts;
  const retryDelayMs = retryable ? webhookRetryDelayMs(attempt, options.random) : undefined;
  const nextAttemptAt =
    retryDelayMs === undefined
      ? undefined
      : new Date(completedAt.getTime() + retryDelayMs).toISOString();
  const kind = failure === undefined ? "delivered" : retryable ? "retrying" : "failed";
  const error =
    failure === undefined
      ? undefined
      : failure instanceof Error
        ? failure.message.slice(0, 2_000)
        : "Webhook delivery failed.";
  const responseFields = response
    ? { responseCode: response.status, responseHeaders: inspectableHeaders(response.headers) }
    : {};
  const record = nextDelivery(
    delivery,
    {
      ...(error ? { lastError: error } : {}),
      ...(kind === "failed"
        ? { failureReason: retryableStatus ? "attempts-exhausted" : "non-retryable" }
        : {}),
      ...(nextAttemptAt ? { nextAttemptAt } : {}),
      ...responseFields,
      lastAttemptAt: startedAt.toISOString(),
      retentionExpiresAt,
      status: kind,
    },
    completedAt,
    [
      "claimExpiresAt",
      "claimId",
      "failureReason",
      "manualRetryRequestedAt",
      "nextAttemptAt",
      ...(error ? [] : (["lastError"] as const)),
      ...(response ? [] : (["responseCode", "responseHeaders"] as const)),
    ],
  );
  const attemptRecord = Schema.decodeUnknownSync(WebhookDeliveryAttemptRecord)(
    withCanonicalRecordKeys({
      data: {
        attempt,
        completedAt: completedAt.toISOString(),
        createdAt: completedAt.toISOString(),
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
        environmentId: delivery.data.environmentId,
        ...(error ? { error } : {}),
        eventId: delivery.data.eventId,
        manual: delivery.data.manualRetryRequestedAt !== undefined,
        ...(nextAttemptAt ? { nextAttemptAt } : {}),
        organizationId: delivery.data.organizationId,
        outcome: kind,
        projectId: delivery.data.projectId,
        ...(excerpt ? { responseBodyExcerpt: excerpt } : {}),
        ...responseFields,
        retentionExpiresAt,
        startedAt: startedAt.toISOString(),
        updatedAt: completedAt.toISOString(),
        version: 0,
        webhookDeliveryId: delivery.data.id,
        webhookEndpointId: delivery.data.webhookEndpointId,
      },
      itemType: "webhook-delivery-attempt",
      ttl: Math.floor(Date.parse(retentionExpiresAt) / 1_000),
    }),
  );
  return {
    attempt: attemptRecord,
    kind,
    record,
    ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
  };
}
