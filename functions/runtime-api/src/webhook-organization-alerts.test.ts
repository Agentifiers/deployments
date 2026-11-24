import { describe, expect, test } from "bun:test";
import type { PlatformRecord, Ulid } from "@deployments-ai/db";
import { makeSemanticEventRecord } from "@deployments-ai/events";
import { makeWebhookEndpointRecord, verifyWebhookSignature } from "@deployments-ai/webhooks";
import { handleWebhookDeliveryMessages } from "./webhook-delivery-worker.ts";
import { fanOutWebhookSemanticEvent } from "./webhook-fanout.ts";
import {
  ENVIRONMENT_ID,
  ORGANIZATION_ID,
  SIGNING_SECRET,
  sqsEvent,
  webhookHarness,
} from "./webhook-runtime.fixture.ts";

const PROJECT_ID = "01J10000000000000000000002" as Ulid;
const OTHER_PROJECT_ID = "01J10000000000000000000009" as Ulid;
const OTHER_ENVIRONMENT_ID = "01J1000000000000000000000A" as Ulid;
const OTHER_ENDPOINT_ID = "01J1000000000000000000000B" as Ulid;
const PERIOD_ID = "01J3000000000000000000000P" as Ulid;
const EVENT_ID = "01J3000000000000000000000E" as Ulid;

function seedOtherEnvironmentEndpoint(
  harness: ReturnType<typeof webhookHarness>,
  projectId: Ulid,
  eventTypes: readonly string[],
) {
  harness.dynamo.put(
    "control",
    makeWebhookEndpointRecord({
      environmentId: OTHER_ENVIRONMENT_ID,
      eventTypes,
      id: OTHER_ENDPOINT_ID,
      name: "Billing alerts",
      organizationId: ORGANIZATION_ID,
      projectId,
      signingSecretRef: {
        credentialId: "01J1000000000000000000000C" as Ulid,
        generation: 0,
        store: "dynamodb-kms",
      },
      url: "https://alerts.example.com/billing",
      now: harness.now(),
    }) as PlatformRecord,
  );
}

function seedAlert(
  harness: ReturnType<typeof webhookHarness>,
  scope: { readonly projectId?: Ulid },
) {
  const event = makeSemanticEventRecord({
    actor: { type: "system" },
    aggregateId: PERIOD_ID,
    aggregateType: "budget-period",
    aggregateVersion: 1,
    eventId: EVENT_ID,
    eventType: "budget.threshold-crossed",
    occurredAt: harness.now(),
    organizationId: ORGANIZATION_ID,
    payload: { budgetName: "Monthly cap", threshold: 80 },
    ...scope,
  });
  harness.dynamo.put("events", event);
  return { detail: event.data, source: "deployments-ai.platform" };
}

describe("organization billing alerts over webhooks", () => {
  test("an organization budget alert reaches every environment endpoint that names it", async () => {
    const harness = webhookHarness();
    harness.seedEndpoint({ update: { eventTypes: ["budget.threshold-crossed"] } });
    seedOtherEnvironmentEndpoint(harness, OTHER_PROJECT_ID, ["budget.threshold-crossed"]);
    await fanOutWebhookSemanticEvent(seedAlert(harness, {}), harness.dependencies);
    const messages = harness.enqueued.splice(0);
    expect(messages.map((message) => message.environmentId).toSorted()).toEqual(
      [ENVIRONMENT_ID, OTHER_ENVIRONMENT_ID].toSorted(),
    );

    await handleWebhookDeliveryMessages(sqsEvent(messages), harness.dependencies);
    expect(harness.requests.map((request) => request.url).toSorted()).toEqual([
      "https://alerts.example.com/billing",
      "https://hooks.example.com/platform",
    ]);
    const request = harness.requests[0]!;
    expect(
      verifyWebhookSignature({
        body: request.body,
        now: harness.now(),
        secrets: [SIGNING_SECRET],
        signature: request.headers["x-deployments-signature"],
        timestamp: request.headers["x-deployments-timestamp"],
      }),
    ).toBe(true);
    expect(JSON.parse(request.body)).toMatchObject({
      eventType: "budget.threshold-crossed",
      organizationId: ORGANIZATION_ID,
      payload: { budgetName: "Monthly cap", threshold: 80 },
    });
  });

  test("a project budget alert stays within that project", async () => {
    const harness = webhookHarness();
    harness.seedEndpoint({ update: { eventTypes: ["budget.threshold-crossed"] } });
    seedOtherEnvironmentEndpoint(harness, OTHER_PROJECT_ID, ["budget.threshold-crossed"]);
    await fanOutWebhookSemanticEvent(
      seedAlert(harness, { projectId: PROJECT_ID }),
      harness.dependencies,
    );
    expect(harness.enqueued.map((message) => message.environmentId)).toEqual([ENVIRONMENT_ID]);
  });

  test("an endpoint subscribed to every event does not receive organization alerts", async () => {
    const harness = webhookHarness();
    harness.seedEndpoint({ update: { eventTypes: ["*"] } });
    await fanOutWebhookSemanticEvent(seedAlert(harness, {}), harness.dependencies);
    expect(harness.enqueued).toEqual([]);
  });
});

function seedMonitorAlert(
  harness: ReturnType<typeof webhookHarness>,
  input: { readonly deliverWebhooks: boolean; readonly environmentId?: Ulid },
) {
  const event = makeSemanticEventRecord({
    actor: { type: "system" },
    aggregateId: PERIOD_ID,
    aggregateType: "monitor-incident",
    aggregateVersion: 1,
    ...(input.environmentId ? { environmentId: input.environmentId, projectId: PROJECT_ID } : {}),
    eventId: EVENT_ID,
    eventType: "alert.fired",
    occurredAt: harness.now(),
    organizationId: ORGANIZATION_ID,
    payload: {
      deliverEmail: true,
      deliverWebhooks: input.deliverWebhooks,
      monitorName: "Budget alerts",
      status: "firing",
      summary: "Budget Production reached 80%.",
    },
  });
  harness.dynamo.put("events", event);
  return { detail: event.data, source: "deployments-ai.platform" };
}

describe("monitor alerts over webhooks", () => {
  test("an organization monitor's alert reaches every environment endpoint that names alert.fired", async () => {
    const harness = webhookHarness();
    harness.seedEndpoint({ update: { eventTypes: ["alert.fired"] } });
    seedOtherEnvironmentEndpoint(harness, OTHER_PROJECT_ID, ["alert.fired"]);
    await fanOutWebhookSemanticEvent(
      seedMonitorAlert(harness, { deliverWebhooks: true }),
      harness.dependencies,
    );
    expect(harness.enqueued.map((message) => message.environmentId).toSorted()).toEqual(
      [ENVIRONMENT_ID, OTHER_ENVIRONMENT_ID].toSorted(),
    );
  });

  test("an environment monitor's alert reaches its own environment, including wildcard endpoints", async () => {
    const harness = webhookHarness();
    harness.seedEndpoint({ update: { eventTypes: ["*"] } });
    seedOtherEnvironmentEndpoint(harness, PROJECT_ID, ["alert.fired"]);
    await fanOutWebhookSemanticEvent(
      seedMonitorAlert(harness, { deliverWebhooks: true, environmentId: ENVIRONMENT_ID }),
      harness.dependencies,
    );
    expect(harness.enqueued.map((message) => message.environmentId)).toEqual([ENVIRONMENT_ID]);
  });

  test("an alert from a monitor that does not notify webhooks reaches no endpoint", async () => {
    const harness = webhookHarness();
    harness.seedEndpoint({ update: { eventTypes: ["*", "alert.fired"] } });
    await fanOutWebhookSemanticEvent(
      seedMonitorAlert(harness, { deliverWebhooks: false, environmentId: ENVIRONMENT_ID }),
      harness.dependencies,
    );
    expect(harness.enqueued).toEqual([]);
  });
});
