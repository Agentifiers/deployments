import { describe, expect, test } from "bun:test";
import { webhookDeliveryAttemptPartition } from "@deployments-ai/db";
import { verifyWebhookSignature, type WebhookRequest } from "@deployments-ai/webhooks";
import { webhookApiFixture, now } from "./webhook-api.fixture.ts";
import {
  getWebhookDelivery,
  listWebhookDeliveries,
  listWebhookDeliveryAttempts,
  retryWebhookDelivery,
} from "./webhook-delivery-operations.ts";
import { createWebhook } from "./webhook-operations.ts";
import { createPinnedWebhookSender } from "./webhook-runtime.ts";
import { testWebhook } from "./webhook-secret-operations.ts";

describe("webhook delivery operations", () => {
  test("re-arms a failed delivery, enqueues it, and re-enqueues a pending manual retry", async () => {
    const f = webhookApiFixture();
    const endpoint = f.seedEndpoint();
    const delivery = f.seedDelivery(endpoint.data.id, {
      claimExpiresAt: now.toISOString(),
      claimId: f.caller.scope.projectId,
      failureReason: "attempts-exhausted",
    });
    const message = {
      deliveryId: delivery.data.id,
      environmentId: f.caller.scope.environmentId,
      organizationId: f.caller.scope.organizationId,
      version: 1 as const,
    };

    const retried = await retryWebhookDelivery(f.dependencies, f.caller, delivery.data.id);

    expect(retried).toMatchObject({
      manualRetryRequestedAt: now.toISOString(),
      maxAttempts: 4,
      status: "pending",
      version: 1,
    });
    expect(retried).not.toHaveProperty("claimId");
    expect(retried).not.toHaveProperty("failureReason");
    expect(f.memory.transactions.at(-1)).toContainEqual(
      expect.objectContaining({ kind: "condition-check" }),
    );
    expect(f.enqueued).toEqual([message]);

    // A retry whose enqueue was lost is recovered by asking again: no new write, one more message.
    expect(await retryWebhookDelivery(f.dependencies, f.caller, delivery.data.id)).toEqual(retried);
    expect(f.memory.transactions).toHaveLength(1);
    expect(f.enqueued).toEqual([message, message]);
  });

  test("refuses retries while in progress, after retention, or to an inactive endpoint", async () => {
    const f = webhookApiFixture();
    const endpoint = f.seedEndpoint();
    for (const status of ["sending", "retrying", "pending"] as const) {
      const delivery = f.seedDelivery(endpoint.data.id, { status });
      expect(
        retryWebhookDelivery(f.dependencies, f.caller, delivery.data.id),
      ).rejects.toMatchObject({ code: "webhook_delivery_in_progress", status: 409 });
    }
    const disabled = f.seedEndpoint({ data: { status: "disabled" } });
    const toDisabled = f.seedDelivery(disabled.data.id);
    expect(
      retryWebhookDelivery(f.dependencies, f.caller, toDisabled.data.id),
    ).rejects.toMatchObject({ code: "webhook_endpoint_inactive", status: 409 });

    const expiring = f.seedDelivery(endpoint.data.id);
    f.clock.now = new Date(Date.parse(expiring.data.retentionExpiresAt));
    expect(retryWebhookDelivery(f.dependencies, f.caller, expiring.data.id)).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    expect(getWebhookDelivery(f.dependencies, f.caller, expiring.data.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(f.memory.transactions).toEqual([]);
    expect(f.enqueued).toEqual([]);
  });

  test("answers 503 for retries when delivery scheduling is not configured", async () => {
    const f = webhookApiFixture({ webhookDeliveryQueue: false });
    const delivery = f.seedDelivery(f.seedEndpoint().data.id);
    expect(retryWebhookDelivery(f.dependencies, f.caller, delivery.data.id)).rejects.toMatchObject({
      code: "webhook_delivery_queue_unavailable",
      status: 503,
    });
    expect(f.memory.transactions).toEqual([]);
  });

  test("lists one delivery's attempts in attempt order from its own partition", async () => {
    const f = webhookApiFixture();
    const endpoint = f.seedEndpoint();
    const delivery = f.seedDelivery(endpoint.data.id);
    const other = f.seedDelivery(endpoint.data.id);
    for (const attempt of [3, 1, 2]) f.seedAttempt(delivery, attempt);
    f.seedAttempt(other, 1);

    const page = await listWebhookDeliveryAttempts(f.dependencies, f.caller, delivery.data.id, {});

    expect(page.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2, 3]);
    expect(page.attempts.every((attempt) => attempt.webhookDeliveryId === delivery.data.id)).toBe(
      true,
    );
    expect(page.attempts[0]).toMatchObject({ object: "webhook-delivery-attempt" });
    const query = f.memory.queries.at(-1)!;
    expect(query.ExpressionAttributeValues?.[":pk"]).toBe(
      webhookDeliveryAttemptPartition(f.caller.scope.organizationId, delivery.data.id).pk,
    );
    expect(query.ScanIndexForward).toBe(true);
    expect(query.KeyConditionExpression).toContain("#pk = :pk");
  });

  test("filters deliveries by status and hides worker lease fields", async () => {
    const f = webhookApiFixture();
    const endpoint = f.seedEndpoint();
    const failed = f.seedDelivery(endpoint.data.id, { claimId: f.caller.scope.projectId });
    f.seedDelivery(endpoint.data.id, { status: "delivered" });
    const page = await listWebhookDeliveries(f.dependencies, f.caller, { status: "failed" });
    expect(page.deliveries.map((delivery) => delivery.id)).toEqual([failed.data.id]);
    expect(page.deliveries[0]).not.toHaveProperty("claimId");
    expect(page.deliveries[0]).toMatchObject({ eventType: "run.completed", maxAttempts: 3 });
    expect(
      listWebhookDeliveries(f.dependencies, f.caller, { status: "lost" }),
    ).rejects.toMatchObject({ code: "invalid_webhook_delivery_status", status: 400 });
  });
});

describe("webhook test sends", () => {
  test("refuses destinations that resolve to metadata or private addresses", async () => {
    for (const address of ["169.254.169.254", "10.0.0.1"]) {
      const lookups: string[] = [];
      const f = webhookApiFixture({
        webhookSender: createPinnedWebhookSender({
          dnsLookup: (hostname) => {
            lookups.push(hostname);
            return [{ address, family: 4 }];
          },
        }),
      });
      const created = await createWebhook(f.dependencies, f.caller, {
        eventTypes: ["run.completed"],
        name: "Rebinding receiver",
        url: "https://hooks.example.com/platform",
      });
      const transactions = f.memory.transactions.length;

      const result = await testWebhook(f.dependencies, f.caller, created.id);

      expect(lookups).toEqual(["hooks.example.com"]);
      expect(result).toMatchObject({ delivered: false });
      expect(result).not.toHaveProperty("responseStatus");
      expect(result.error).toBeString();
      expect(f.memory.transactions).toHaveLength(transactions);
    }
  });

  test("sends a signed synthetic envelope without persisting it", async () => {
    const requests: WebhookRequest[] = [];
    const f = webhookApiFixture({
      webhookSender: {
        send: async (request) => {
          requests.push(request);
          return new Response(null, { status: 204 });
        },
      },
    });
    const created = await createWebhook(f.dependencies, f.caller, {
      eventTypes: ["run.completed"],
      name: "Receiver",
      url: "https://hooks.example.com/platform",
    });
    const transactions = f.memory.transactions.length;

    const result = await testWebhook(f.dependencies, f.caller, created.id);

    expect(result).toMatchObject({ delivered: true, responseStatus: 204 });
    expect(f.memory.transactions).toHaveLength(transactions);
    const [request] = requests;
    expect(request?.timeoutMs).toBe(10_000);
    const envelope = JSON.parse(request!.body);
    expect(envelope).toMatchObject({
      aggregateId: created.id,
      aggregateType: "webhook-endpoint",
      aggregateVersion: 1,
      endpointId: created.id,
      eventId: result.eventId,
      eventType: "webhook.test",
      organizationId: f.caller.scope.organizationId,
      payload: { test: true, webhookEndpointId: created.id },
      source: "deployments-ai.platform",
      version: 1,
    });
    expect(
      verifyWebhookSignature({
        body: request!.body,
        now,
        secrets: [created.signingSecret],
        signature: request!.headers["x-deployments-signature"],
        timestamp: request!.headers["x-deployments-timestamp"],
      }),
    ).toBe(true);

    const archived = f.seedEndpoint({ data: { status: "archived" } });
    expect(testWebhook(f.dependencies, f.caller, archived.data.id)).rejects.toMatchObject({
      code: "webhook_archived",
      status: 409,
    });
  });
});
