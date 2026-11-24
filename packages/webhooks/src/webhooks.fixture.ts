import type { Ulid } from "@deployments-ai/db";
import type { SemanticEvent } from "@deployments-ai/events";
import {
  claimWebhookDeliveryAttempt,
  makeWebhookDeliveryRecord,
  type WebhookDelivery,
} from "./deliveries.ts";
import { makeWebhookEndpointRecord } from "./endpoints.ts";

const ORGANIZATION_ID = "01J00000000000000000000001" as Ulid;
const PROJECT_ID = "01J00000000000000000000002" as Ulid;
const ENVIRONMENT_ID = "01J00000000000000000000003" as Ulid;
export const ENDPOINT_ID = "01J00000000000000000000004" as Ulid;
export const EVENT_ID = "01J00000000000000000000005" as Ulid;
export const DELIVERY_ID = "01J00000000000000000000006" as Ulid;
export const AGGREGATE_ID = "01J00000000000000000000007" as Ulid;
export const CLAIM_ID = "01J00000000000000000000008" as Ulid;
export const SECOND_CLAIM_ID = "01J00000000000000000000009" as Ulid;

export const endpoint = makeWebhookEndpointRecord({
  environmentId: ENVIRONMENT_ID,
  eventTypes: ["user.created"],
  id: ENDPOINT_ID,
  name: "User lifecycle",
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  signingSecretRef: {
    credentialId: "01J0000000000000000000000C" as Ulid,
    generation: 0,
    store: "dynamodb-kms",
  },
  url: "https://example.com/webhooks",
  now: new Date("2026-07-20T00:00:00.000Z"),
});

export const event: SemanticEvent = {
  aggregateId: AGGREGATE_ID,
  aggregateType: "user",
  aggregateVersion: 1,
  environmentId: ENVIRONMENT_ID,
  eventId: EVENT_ID,
  eventType: "user.created",
  occurredAt: "2026-07-20T00:00:00.000Z",
  organizationId: ORGANIZATION_ID,
  payload: { email: "person@example.com" },
  projectId: PROJECT_ID,
};

export const delivery = makeWebhookDeliveryRecord({
  endpoint,
  event,
  id: DELIVERY_ID,
  now: new Date("2026-07-20T00:00:01.000Z"),
  retentionDays: 30,
});

export function claimed(record: WebhookDelivery, now: Date, claimId: Ulid = CLAIM_ID) {
  const claim = claimWebhookDeliveryAttempt({ claimId, delivery: record, now });
  if (claim.kind !== "claimed") throw new Error(`Expected a claim, got ${claim.kind}.`);
  return claim.record;
}

/** A clock that returns each instant in turn and repeats the last one. */
export function steppingClock(...instants: readonly string[]) {
  let index = 0;
  return () => new Date(instants[Math.min(index++, instants.length - 1)]!);
}
