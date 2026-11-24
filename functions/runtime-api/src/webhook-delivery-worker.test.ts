import { describe, expect, test } from "bun:test";
import { webhookDeliveryAttemptPartition, type Ulid } from "@deployments-ai/db";
import {
  MAX_WEBHOOK_DELIVERY_ATTEMPTS,
  WEBHOOK_AUTO_DISABLE_THRESHOLD,
  verifyWebhookSignature,
} from "@deployments-ai/webhooks";
import { handleWebhookDeliveryMessages } from "./webhook-delivery-worker.ts";
import { createWebhookEventHandler } from "./webhook-event-handler.ts";
import { deterministicWebhookDeliveryId, fanOutWebhookSemanticEvent } from "./webhook-fanout.ts";
import { createPinnedWebhookSender } from "./webhook-runtime.ts";
import {
  ENDPOINT_ID,
  ENVIRONMENT_ID,
  ORGANIZATION_ID,
  SIGNING_SECRET,
  sqsEvent,
  webhookHarness,
} from "./webhook-runtime.fixture.ts";

const EVENT_ID = "01J30000000000000000000002" as Ulid;
const SECOND_EVENT_ID = "01J30000000000000000000003" as Ulid;

// Each event belongs to its own run aggregate so seeded events never share a version slot.
function bridgeEvent(harness: ReturnType<typeof webhookHarness>, eventId = EVENT_ID) {
  return { detail: harness.seedEvent(eventId, eventId).data, source: "deployments-ai.platform" };
}

async function fanOut(harness: ReturnType<typeof webhookHarness>, eventId = EVENT_ID) {
  await fanOutWebhookSemanticEvent(bridgeEvent(harness, eventId), harness.dependencies);
  return harness.enqueued.splice(0);
}

async function delivery(harness: ReturnType<typeof webhookHarness>, eventId = EVENT_ID) {
  return harness.persistence.readDelivery(
    { environmentId: ENVIRONMENT_ID, organizationId: ORGANIZATION_ID },
    deterministicWebhookDeliveryId(eventId, ENDPOINT_ID),
  );
}

describe("webhook fan-out", () => {
  test("creates one delivery per event and endpoint and converges on retries", async () => {
    const harness = webhookHarness();
    harness.seedEndpoint();
    const first = await fanOut(harness);
    expect(first).toEqual([
      {
        deliveryId: deterministicWebhookDeliveryId(EVENT_ID, ENDPOINT_ID),
        environmentId: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        version: 1,
      },
    ]);
    // An EventBridge retry of the same event finds the same not-yet-started delivery.
    expect(await fanOut(harness)).toEqual(first);
    expect(
      harness.dynamo.items("events").filter((item) => item.itemType === "webhook-delivery"),
    ).toHaveLength(1);

    await handleWebhookDeliveryMessages(sqsEvent(first), harness.dependencies);
    expect(await fanOut(harness)).toEqual([]);
    expect(harness.requests).toHaveLength(1);
  });

  test("ignores events outside the endpoint's subscriptions", async () => {
    const harness = webhookHarness();
    harness.seedEndpoint();
    await fanOutWebhookSemanticEvent(
      { detail: harness.seedEvent(EVENT_ID, EVENT_ID, "run.failed").data },
      harness.dependencies,
    );
    expect(harness.enqueued).toEqual([]);
  });
});

describe("webhook delivery worker", () => {
  test("delivers a signed event, records the attempt, and deletes the message", async () => {
    const harness = webhookHarness();
    harness.seedEndpoint();
    const result = await handleWebhookDeliveryMessages(
      sqsEvent(await fanOut(harness)),
      harness.dependencies,
    );
    expect(result.batchItemFailures).toEqual([]);
    expect((await delivery(harness))?.data).toMatchObject({ attempt: 1, status: "delivered" });
    const [request] = harness.requests;
    expect(
      verifyWebhookSignature({
        body: request!.body,
        now: harness.now(),
        secrets: [SIGNING_SECRET],
        signature: request!.headers["x-deployments-signature"],
        timestamp: request!.headers["x-deployments-timestamp"],
      }),
    ).toBe(true);
    const attempts = harness.dynamo
      .items("events")
      .filter((item) => item.itemType === "webhook-delivery-attempt");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.pk).toBe(
      webhookDeliveryAttemptPartition(
        ORGANIZATION_ID,
        deterministicWebhookDeliveryId(EVENT_ID, ENDPOINT_ID),
      ).pk,
    );
  });

  test("hides a failing delivery until each retry and fails it after the last attempt", async () => {
    const harness = webhookHarness();
    harness.seedEndpoint();
    const messages = await fanOut(harness);
    const delays: number[] = [];
    for (let attempt = 1; attempt <= MAX_WEBHOOK_DELIVERY_ATTEMPTS; attempt += 1) {
      harness.respondWith(() => new Response("unavailable", { status: 503 }));
      const result = await handleWebhookDeliveryMessages(sqsEvent(messages), harness.dependencies);
      const current = await delivery(harness);
      if (attempt < MAX_WEBHOOK_DELIVERY_ATTEMPTS) {
        expect(result.batchItemFailures).toEqual([{ itemIdentifier: "message-0" }]);
        expect(current?.data.status).toBe("retrying");
        const hidden = harness.visibility.at(-1)!.seconds;
        delays.push(hidden);
        // A redelivery before the retry is due is hidden again without an attempt.
        harness.advanceBy(1_000);
        await handleWebhookDeliveryMessages(sqsEvent(messages), harness.dependencies);
        expect(harness.requests).toHaveLength(attempt);
        harness.advanceTo(current!.data.nextAttemptAt!);
      } else {
        expect(result.batchItemFailures).toEqual([]);
        expect(current?.data).toMatchObject({
          attempt: MAX_WEBHOOK_DELIVERY_ATTEMPTS,
          failureReason: "attempts-exhausted",
          status: "failed",
        });
      }
    }
    expect(delays).toEqual([60, 120, 240, 480, 960, 1_920, 3_840, 7_680, 15_360]);
    expect(harness.requests).toHaveLength(MAX_WEBHOOK_DELIVERY_ATTEMPTS);
    expect(
      harness.dynamo.items("events").filter((item) => item.itemType === "webhook-delivery-attempt"),
    ).toHaveLength(MAX_WEBHOOK_DELIVERY_ATTEMPTS);
    const endpoint = await harness.persistence.readEndpoint(
      { environmentId: ENVIRONMENT_ID, organizationId: ORGANIZATION_ID },
      ENDPOINT_ID,
    );
    expect(endpoint?.data.consecutiveFailures).toBe(1);
    // A late duplicate of a terminal delivery is acknowledged without another request.
    const late = await handleWebhookDeliveryMessages(sqsEvent(messages), harness.dependencies);
    expect(late.batchItemFailures).toEqual([]);
    expect(harness.requests).toHaveLength(MAX_WEBHOOK_DELIVERY_ATTEMPTS);
  });

  test("sends exactly once when duplicate messages race for the same delivery", async () => {
    const harness = webhookHarness();
    harness.seedEndpoint();
    const [message] = await fanOut(harness);
    // The winner's request completes only after both other invocations settled, so they must
    // have observed the winner's lease rather than a finished delivery.
    const { promise: losersSettled, resolve: releaseWinner } = Promise.withResolvers<void>();
    harness.respondWith(async () => {
      await losersSettled;
      return new Response(null, { status: 204 });
    });
    const duplicate = sqsEvent([message!, message!]);
    let settled = 0;
    const racing = [
      { Records: [duplicate.Records[0]!] },
      { Records: [duplicate.Records[1]!] },
      duplicate,
    ].map((input) =>
      handleWebhookDeliveryMessages(input, harness.dependencies).finally(() => {
        settled += 1;
        if (settled === 2) releaseWinner();
      }),
    );
    const results = await Promise.all(racing);
    expect(harness.requests).toHaveLength(1);
    expect((await delivery(harness))?.data).toMatchObject({ attempt: 1, status: "delivered" });
    // Three of the four messages lost: each was hidden until the winner's lease could expire.
    expect(results.flatMap((result) => result.batchItemFailures)).toHaveLength(3);
    expect(harness.visibility).toHaveLength(3);
    for (const hidden of harness.visibility) expect(hidden.seconds).toBeLessThanOrEqual(60);
    harness.advanceBy(60_000);
    const retried = await handleWebhookDeliveryMessages(duplicate, harness.dependencies);
    expect(retried.batchItemFailures).toEqual([]);
    expect(harness.requests).toHaveLength(1);
  });

  test("disables the endpoint at the failure threshold and stops sending", async () => {
    const harness = webhookHarness();
    harness.seedEndpoint({
      update: { consecutiveFailures: WEBHOOK_AUTO_DISABLE_THRESHOLD - 1 },
    });
    const first = await fanOut(harness);
    const second = await fanOut(harness, SECOND_EVENT_ID);
    harness.respondWith(() => new Response("gone", { status: 410 }));
    await handleWebhookDeliveryMessages(sqsEvent(first), harness.dependencies);
    const endpoint = await harness.persistence.readEndpoint(
      { environmentId: ENVIRONMENT_ID, organizationId: ORGANIZATION_ID },
      ENDPOINT_ID,
    );
    expect(endpoint?.data).toMatchObject({
      consecutiveFailures: WEBHOOK_AUTO_DISABLE_THRESHOLD,
      disabledReason: "consecutive-failures",
      status: "disabled",
    });
    const disabledEvent = harness.dynamo
      .items("events")
      .find(
        (item) =>
          item.itemType === "semantic-event" &&
          typeof item.data === "object" &&
          item.data !== null &&
          "eventType" in item.data &&
          item.data.eventType === "webhook.endpoint.disabled",
      );
    expect(disabledEvent?.data).toMatchObject({
      aggregateId: ENDPOINT_ID,
      payload: { reason: "consecutive-failures", webhookEndpointId: ENDPOINT_ID },
    });
    const result = await handleWebhookDeliveryMessages(sqsEvent(second), harness.dependencies);
    expect(result.batchItemFailures).toEqual([]);
    expect(harness.requests).toHaveLength(1);
    expect((await delivery(harness, SECOND_EVENT_ID))?.data).toMatchObject({
      failureReason: "endpoint-inactive",
      status: "failed",
    });
    // New events no longer fan out to the disabled endpoint.
    expect(await fanOut(harness, "01J30000000000000000000004" as Ulid)).toEqual([]);
  });

  test("refuses egress to private and metadata addresses without retrying", async () => {
    for (const address of ["169.254.169.254", "10.0.0.7", "127.0.0.1"]) {
      const lookups: string[] = [];
      const harness = webhookHarness({
        sender: createPinnedWebhookSender({
          dnsLookup: (hostname) => {
            lookups.push(hostname);
            return [{ address, family: 4 }];
          },
        }),
      });
      harness.seedEndpoint({ url: "https://hooks.example.com/platform" });
      const result = await handleWebhookDeliveryMessages(
        sqsEvent(await fanOut(harness)),
        harness.dependencies,
      );
      // The public hostname resolved to a refused address, so the sender never connected and
      // the delivery failed terminally instead of retrying.
      expect(lookups).toEqual(["hooks.example.com"]);
      expect(result.batchItemFailures).toEqual([]);
      const current = await delivery(harness);
      expect(current?.data).toMatchObject({ failureReason: "non-retryable", status: "failed" });
      expect(current?.data.lastError).toContain("egress refused");
    }
  });

  test("signs with both secrets during a rotation overlap", async () => {
    const harness = webhookHarness({
      vaultValues: { previousSigningSecret: "previous-secret", signingSecret: "rotated-secret" },
    });
    harness.seedEndpoint({
      update: {
        previousSigningSecretExpiresAt: new Date("2026-07-21T00:00:00.000Z"),
        signingSecretRotatedAt: new Date("2026-07-20T00:00:00.000Z"),
      },
    });
    await handleWebhookDeliveryMessages(sqsEvent(await fanOut(harness)), harness.dependencies);
    const [request] = harness.requests;
    for (const secrets of [["previous-secret"], ["rotated-secret"]]) {
      expect(
        verifyWebhookSignature({
          body: request!.body,
          now: harness.now(),
          secrets,
          signature: request!.headers["x-deployments-signature"],
          timestamp: request!.headers["x-deployments-timestamp"],
        }),
      ).toBe(true);
    }
  });

  test("routes EventBridge and SQS inputs through one lazily composed handler", async () => {
    const harness = webhookHarness();
    harness.seedEndpoint();
    let compositions = 0;
    const handler = createWebhookEventHandler(() => {
      compositions += 1;
      return harness.dependencies;
    });
    await handler(bridgeEvent(harness), { awsRequestId: "context" });
    const result = await handler(sqsEvent(harness.enqueued.splice(0)));
    expect(compositions).toBe(1);
    expect(result).toEqual({ batchItemFailures: [] });
    expect(harness.requests).toHaveLength(1);
  });
});
