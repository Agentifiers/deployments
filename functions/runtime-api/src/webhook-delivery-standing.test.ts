import { describe, expect, test } from "bun:test";
import type { Ulid } from "@deployments-ai/db";
import { organizationHolds } from "@deployments-ai/organization-admission/testing";
import { handleWebhookDeliveryMessages } from "./webhook-delivery-worker.ts";
import { deterministicWebhookDeliveryId, fanOutWebhookSemanticEvent } from "./webhook-fanout.ts";
import {
  ENDPOINT_ID,
  ENVIRONMENT_ID,
  ORGANIZATION_ID,
  sqsEvent,
  webhookHarness,
} from "./webhook-runtime.fixture.ts";

const HELD_EVENT_ID = "01J30000000000000000000002" as Ulid;
const RELEASED_EVENT_ID = "01J30000000000000000000003" as Ulid;

describe("webhook deliveries of a suspended organization", () => {
  test("are recorded as failed without an attempt and deliver again after release", async () => {
    const harness = webhookHarness();
    harness.seedEndpoint();
    const deliverEvent = async (eventId: Ulid) => {
      await fanOutWebhookSemanticEvent(
        { detail: harness.seedEvent(eventId, eventId).data, source: "deployments-ai.platform" },
        harness.dependencies,
      );
      const messages = harness.enqueued.splice(0);
      const result = await handleWebhookDeliveryMessages(sqsEvent(messages), harness.dependencies);
      const record = await harness.persistence.readDelivery(
        { environmentId: ENVIRONMENT_ID, organizationId: ORGANIZATION_ID },
        deterministicWebhookDeliveryId(eventId, ENDPOINT_ID),
      );
      return {
        batchItemFailures: result.batchItemFailures,
        failureReason: record?.data.failureReason,
        lastError: record?.data.lastError,
        status: record?.data.status,
      };
    };
    const holds = organizationHolds(harness.database, ORGANIZATION_ID);

    await holds.hold("payment");
    const held = await deliverEvent(HELD_EVENT_ID);
    const requestsWhileHeld = harness.requests.length;
    await holds.release("payment");
    const released = await deliverEvent(RELEASED_EVENT_ID);

    expect([held, requestsWhileHeld, released]).toEqual([
      {
        batchItemFailures: [],
        failureReason: "organization-suspended",
        lastError: "The organization is suspended.",
        status: "failed",
      },
      0,
      {
        batchItemFailures: [],
        failureReason: undefined,
        lastError: undefined,
        status: "delivered",
      },
    ]);
  });
});
