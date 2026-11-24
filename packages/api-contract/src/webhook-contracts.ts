import { Schema } from "effect";
import { Cursor, Metadata, PublicId, Timestamp } from "./primitives.ts";
import {
  RuntimeMutableFields,
  RuntimeTenantFields,
  WebhookEventTypes,
  WebhookResourceFilters,
  trimmedText,
} from "./runtime-request-contracts.ts";

export const DEFAULT_WEBHOOK_PREVIOUS_SECRET_EXPIRES_IN_SECONDS = 86_400;
export const MAX_WEBHOOK_PREVIOUS_SECRET_EXPIRES_IN_SECONDS = 604_800;

export const WebhookDeliveryStatus = Schema.Literals([
  "delivered",
  "failed",
  "pending",
  "retrying",
  "sending",
]);

export const UpdateWebhookRequest = Schema.Struct({
  eventTypes: Schema.optional(WebhookEventTypes),
  name: Schema.optional(trimmedText("Webhook name", 120)),
  resourceFilters: Schema.optional(Schema.NullOr(WebhookResourceFilters)),
  url: Schema.optional(trimmedText("Webhook URL", 2_048)),
}).pipe(
  Schema.check(
    Schema.isMinProperties(1, { message: "Webhook updates must change at least one field." }),
  ),
);

export const RotateWebhookSecretRequest = Schema.Struct({
  previousSecretExpiresInSeconds: Schema.optional(
    Schema.Number.pipe(
      Schema.check(
        Schema.isInt({ message: "previousSecretExpiresInSeconds must be an integer." }),
        Schema.isBetween(
          { minimum: 0, maximum: MAX_WEBHOOK_PREVIOUS_SECRET_EXPIRES_IN_SECONDS },
          {
            message: `previousSecretExpiresInSeconds must be between 0 and ${MAX_WEBHOOK_PREVIOUS_SECRET_EXPIRES_IN_SECONDS}.`,
          },
        ),
      ),
    ),
  ),
});

export const WebhookResponseFields = {
  ...RuntimeMutableFields,
  ...RuntimeTenantFields,
  consecutiveFailures: Schema.Number,
  disabledAt: Schema.optional(Timestamp),
  disabledReason: Schema.optional(Schema.Literals(["consecutive-failures", "manual"])),
  eventTypes: Schema.Array(Schema.String),
  id: PublicId,
  name: Schema.String,
  object: Schema.Literal("webhook-endpoint"),
  previousSigningSecretExpiresAt: Schema.optional(Timestamp),
  resourceFilters: Schema.optional(WebhookResourceFilters),
  signingSecretRotatedAt: Schema.optional(Timestamp),
  status: Schema.Literals(["active", "archived", "disabled"]),
  url: Schema.String,
} as const;

export const WebhookResponse = Schema.Struct(WebhookResponseFields);

export const CreateWebhookResponse = Schema.Struct({
  ...WebhookResponseFields,
  signingSecret: Schema.String,
});

/** The new signing secret is returned once; the previous secret keeps signing until it expires. */
export const RotateWebhookSecretResponse = Schema.Struct({
  ...WebhookResponseFields,
  signingSecret: Schema.String,
});

export const TestWebhookResponse = Schema.Struct({
  delivered: Schema.Boolean,
  durationMs: Schema.Number,
  error: Schema.optional(Schema.String),
  eventId: PublicId,
  responseStatus: Schema.optional(Schema.Number),
});

export const WebhookDeliveryResponse = Schema.Struct({
  ...RuntimeMutableFields,
  ...RuntimeTenantFields,
  aggregateId: PublicId,
  aggregateType: Schema.String,
  aggregateVersion: Schema.Number,
  attempt: Schema.Number,
  eventId: PublicId,
  eventType: Schema.String,
  failureReason: Schema.optional(
    Schema.Literals([
      "attempts-exhausted",
      "endpoint-inactive",
      "event-unavailable",
      "non-retryable",
      "organization-suspended",
    ]),
  ),
  id: PublicId,
  lastAttemptAt: Schema.optional(Timestamp),
  lastError: Schema.optional(Schema.String),
  manualRetryRequestedAt: Schema.optional(Timestamp),
  maxAttempts: Schema.Number,
  nextAttemptAt: Schema.optional(Timestamp),
  object: Schema.Literal("webhook-delivery"),
  responseCode: Schema.optional(Schema.Number),
  responseHeaders: Schema.optional(Metadata),
  retentionExpiresAt: Timestamp,
  status: WebhookDeliveryStatus,
  webhookEndpointId: PublicId,
});

export const WebhookDeliveryAttemptResponse = Schema.Struct({
  ...RuntimeMutableFields,
  ...RuntimeTenantFields,
  attempt: Schema.Number,
  completedAt: Timestamp,
  durationMs: Schema.Number,
  error: Schema.optional(Schema.String),
  eventId: PublicId,
  manual: Schema.Boolean,
  nextAttemptAt: Schema.optional(Timestamp),
  object: Schema.Literal("webhook-delivery-attempt"),
  outcome: Schema.Literals(["delivered", "failed", "retrying"]),
  responseBodyExcerpt: Schema.optional(Schema.String),
  responseCode: Schema.optional(Schema.Number),
  responseHeaders: Schema.optional(Metadata),
  retentionExpiresAt: Timestamp,
  startedAt: Timestamp,
  webhookDeliveryId: PublicId,
  webhookEndpointId: PublicId,
});

export const ListWebhooksResponse = Schema.Struct({
  nextCursor: Schema.optional(Cursor),
  webhooks: Schema.Array(WebhookResponse),
});

export const ListWebhookDeliveriesResponse = Schema.Struct({
  deliveries: Schema.Array(WebhookDeliveryResponse),
  nextCursor: Schema.optional(Cursor),
});

export const ListWebhookDeliveryAttemptsResponse = Schema.Struct({
  attempts: Schema.Array(WebhookDeliveryAttemptResponse),
  nextCursor: Schema.optional(Cursor),
});

export const WEBHOOK_API_SCHEMAS = {
  CreateWebhookResponse,
  ListWebhookDeliveriesResponse,
  ListWebhookDeliveryAttemptsResponse,
  ListWebhooksResponse,
  RotateWebhookSecretRequest,
  RotateWebhookSecretResponse,
  TestWebhookResponse,
  UpdateWebhookRequest,
  WebhookDeliveryAttemptResponse,
  WebhookDeliveryResponse,
  WebhookResponse,
} as const;

export type UpdateWebhookRequest = typeof UpdateWebhookRequest.Type;
export type RotateWebhookSecretRequest = typeof RotateWebhookSecretRequest.Type;
export type WebhookResponse = typeof WebhookResponse.Type;
export type CreateWebhookResponse = typeof CreateWebhookResponse.Type;
export type RotateWebhookSecretResponse = typeof RotateWebhookSecretResponse.Type;
export type TestWebhookResponse = typeof TestWebhookResponse.Type;
export type WebhookDeliveryResponse = typeof WebhookDeliveryResponse.Type;
export type WebhookDeliveryAttemptResponse = typeof WebhookDeliveryAttemptResponse.Type;
export type ListWebhooksResponse = typeof ListWebhooksResponse.Type;
export type ListWebhookDeliveriesResponse = typeof ListWebhookDeliveriesResponse.Type;
export type ListWebhookDeliveryAttemptsResponse = typeof ListWebhookDeliveryAttemptsResponse.Type;
