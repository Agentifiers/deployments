import { createHash } from "node:crypto";
import { SemanticEventData, type Ulid, type WebhookPersistence } from "@deployments-ai/db";
import { semanticEventIsInternal } from "@deployments-ai/events";
import {
  makeWebhookDeliveryRecord,
  ORGANIZATION_WEBHOOK_EVENT_TYPES,
  webhookEndpointReceivesEvent,
  type WebhookEndpoint,
} from "@deployments-ai/webhooks";
import { Schema } from "effect";
import type { WebhookDeliveryMessage, WebhookDeliveryQueue } from "./webhook-runtime.ts";

export interface WebhookFanoutDependencies {
  readonly emitMetrics?: (metrics: Readonly<Record<string, number>>) => void;
  readonly now: () => Date;
  readonly persistence: WebhookPersistence;
  readonly queue: WebhookDeliveryQueue;
  readonly retentionDays: number;
}

export interface SemanticEventBridgeInput {
  readonly detail: unknown;
  readonly source?: string;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Idempotency key of one event to one endpoint: the event's ULID time prefix plus a hash of both
 * IDs, so every fan-out retry of the same event addresses the same delivery record.
 */
export function deterministicWebhookDeliveryId(eventId: Ulid, endpointId: Ulid): Ulid {
  const digest = createHash("sha256").update(`${eventId}:${endpointId}`).digest();
  let accumulator = 0;
  let bits = 0;
  let encoded = "";
  for (const byte of digest) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5 && encoded.length < 16) {
      bits -= 5;
      encoded += CROCKFORD[(accumulator >>> bits) & 31];
      accumulator &= (1 << bits) - 1;
    }
    if (encoded.length === 16) break;
  }
  return `${eventId.slice(0, 10)}${encoded}` as Ulid;
}

/**
 * EventBridge target: writes one delivery record per matching active endpoint (create-only, so
 * retries converge) and enqueues one SQS message per delivery that has not started. Deliveries
 * already in flight keep their own queue message and are not re-enqueued.
 */
export async function fanOutWebhookSemanticEvent(
  input: SemanticEventBridgeInput,
  dependencies: WebhookFanoutDependencies,
) {
  if (input.source !== undefined && input.source !== "deployments-ai.platform") return;
  const event = Schema.decodeUnknownSync(SemanticEventData)(input.detail);
  if (semanticEventIsInternal(event)) return;
  let pages: AsyncGenerator<readonly WebhookEndpoint[]>;
  if (event.environmentId && event.projectId) {
    pages = dependencies.persistence.activeEndpointPages({
      environmentId: event.environmentId,
      organizationId: event.organizationId,
    });
  } else if (!event.environmentId && ORGANIZATION_WEBHOOK_EVENT_TYPES.includes(event.eventType)) {
    pages = dependencies.persistence.activeOrganizationEndpointPages(event.organizationId);
  } else {
    return;
  }
  let created = 0;
  for await (const endpoints of pages) {
    const deliveries = await Promise.all(
      endpoints
        .filter((endpoint) => webhookEndpointReceivesEvent(endpoint, event))
        .map((endpoint) =>
          dependencies.persistence.createDelivery(
            makeWebhookDeliveryRecord({
              endpoint,
              event,
              id: deterministicWebhookDeliveryId(event.eventId, endpoint.data.id),
              now: dependencies.now(),
              retentionDays: dependencies.retentionDays,
            }),
          ),
        ),
    );
    const messages: WebhookDeliveryMessage[] = deliveries.flatMap(({ created: isNew, record }) => {
      if (isNew) created += 1;
      return record.data.status === "pending" && record.data.attempt === 0
        ? [
            {
              deliveryId: record.data.id,
              environmentId: record.data.environmentId,
              organizationId: record.data.organizationId,
              version: 1 as const,
            },
          ]
        : [];
    });
    if (messages.length > 0) await dependencies.queue.enqueue(messages);
  }
  if (created > 0) dependencies.emitMetrics?.({ DeliveriesCreated: created });
}
