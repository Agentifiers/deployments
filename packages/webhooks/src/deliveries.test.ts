import { describe, expect, test } from "bun:test";
import type { Ulid } from "@deployments-ai/db";
import {
  TerminalWebhookSenderError,
  buildWebhookPayload,
  claimWebhookDeliveryAttempt,
  deliverWebhookAttempt,
  makeWebhookDeliveryRecord,
  rearmWebhookDeliveryForManualRetry,
  type WebhookDelivery,
  type WebhookRequest,
} from "./deliveries.ts";
import {
  normalizeWebhookResourceFilters,
  normalizeWebhookUrl,
  replaceWebhookEndpointRecord,
  webhookEndpointReceivesEvent,
} from "./endpoints.ts";
import { MAX_WEBHOOK_DELIVERY_ATTEMPTS } from "./retry-policy.ts";
import { verifyWebhookSignature } from "./signing.ts";
import {
  AGGREGATE_ID,
  CLAIM_ID,
  DELIVERY_ID,
  ENDPOINT_ID,
  EVENT_ID,
  SECOND_CLAIM_ID,
  claimed,
  delivery,
  endpoint,
  event,
  steppingClock,
} from "./webhooks.fixture.ts";

function sender(respond: (request: WebhookRequest) => Response | Promise<Response>) {
  const requests: WebhookRequest[] = [];
  return {
    requests,
    send: async (request: WebhookRequest) => {
      requests.push(request);
      return respond(request);
    },
  };
}

async function attempt(
  record: WebhookDelivery,
  respond: (request: WebhookRequest) => Response | Promise<Response>,
  instants: readonly [string, string] = ["2026-07-20T00:00:02.000Z", "2026-07-20T00:00:03.000Z"],
) {
  const transport = sender(respond);
  const outcome = await deliverWebhookAttempt({
    claimId: record.data.claimId!,
    clock: steppingClock(...instants),
    delivery: record,
    endpoint,
    event,
    random: () => 1,
    retentionDays: 30,
    sender: transport,
    signingSecrets: ["secret"],
  });
  return { outcome, requests: transport.requests };
}

describe("webhook endpoints", () => {
  test("rejects non-public and non-HTTPS destinations", () => {
    expect(() => normalizeWebhookUrl("http://example.com/hook")).toThrow("must use https");
    expect(() => normalizeWebhookUrl("https://127.0.0.1/hook")).toThrow("must be public");
    expect(() => normalizeWebhookUrl("https://169.254.169.254/latest")).toThrow("must be public");
    expect(() => normalizeWebhookUrl("https://10.1.2.3/hook")).toThrow("must be public");
    expect(() => normalizeWebhookUrl("https://[::1]/hook")).toThrow("must be public");
    expect(() => normalizeWebhookUrl("https://[fc00::1]/hook")).toThrow("must be public");
    expect(() => normalizeWebhookUrl("https://metadata.google.internal/hook")).toThrow(
      "must be public",
    );
    expect(() => normalizeWebhookUrl("https://user:pass@example.com/hook")).toThrow("credentials");
    expect(normalizeWebhookUrl("https://[2606:4700::1]/hook")).toBe("https://[2606:4700::1]/hook");
  });

  test("validates resource filters and fails closed for malformed stored values", () => {
    expect(normalizeWebhookResourceFilters({ aggregateIds: [AGGREGATE_ID, AGGREGATE_ID] })).toEqual(
      { aggregateIds: [AGGREGATE_ID] },
    );
    const malformed = {
      ...endpoint,
      data: { ...endpoint.data, resourceFilters: { aggregateIds: AGGREGATE_ID } },
    } as unknown as typeof endpoint;
    expect(webhookEndpointReceivesEvent(malformed, event)).toBe(false);
    const filtered = replaceWebhookEndpointRecord(endpoint, {
      resourceFilters: { aggregateIds: [AGGREGATE_ID] },
    });
    expect(
      replaceWebhookEndpointRecord(filtered, { resourceFilters: null }).data,
    ).not.toHaveProperty("resourceFilters");
    expect(webhookEndpointReceivesEvent(endpoint, { ...event, eventType: "user.deleted" })).toBe(
      false,
    );
    expect(
      webhookEndpointReceivesEvent(
        replaceWebhookEndpointRecord(endpoint, { status: "disabled" }),
        event,
      ),
    ).toBe(false);
  });
});

describe("organization billing alerts", () => {
  const OTHER_PROJECT_ID = "01J0000000000000000000000P" as Ulid;
  const alert = {
    ...event,
    aggregateType: "budget-period",
    eventType: "budget.threshold-crossed",
    payload: { scope: "organization", threshold: 80 },
  };
  const { environmentId: _environmentId, projectId: _projectId, ...organizationAlert } = alert;
  const { environmentId: _unused, ...projectAlert } = alert;
  const named = replaceWebhookEndpointRecord(endpoint, {
    eventTypes: ["budget.threshold-crossed"],
  });

  test("reach every environment endpoint that names the type, within the event's project", () => {
    expect(webhookEndpointReceivesEvent(named, organizationAlert)).toBe(true);
    expect(webhookEndpointReceivesEvent(named, projectAlert)).toBe(true);
    expect(
      webhookEndpointReceivesEvent(named, { ...projectAlert, projectId: OTHER_PROJECT_ID }),
    ).toBe(false);
    const everything = replaceWebhookEndpointRecord(endpoint, { eventTypes: ["*"] });
    expect(webhookEndpointReceivesEvent(everything, organizationAlert)).toBe(false);
  });

  test("other events without an environment reach no endpoint", () => {
    const { environmentId: _drop, ...unscoped } = event;
    expect(webhookEndpointReceivesEvent(endpoint, unscoped)).toBe(false);
  });

  test("build a payload for the endpoint's environment", () => {
    const alertDelivery = makeWebhookDeliveryRecord({
      endpoint: named,
      event: organizationAlert,
      id: DELIVERY_ID,
      now: new Date("2026-07-20T00:00:01.000Z"),
      retentionDays: 30,
    });
    expect(alertDelivery.data).toMatchObject({
      environmentId: endpoint.data.environmentId,
      projectId: endpoint.data.projectId,
    });
    expect(buildWebhookPayload(alertDelivery, named, organizationAlert)).toMatchObject({
      eventType: "budget.threshold-crossed",
      payload: { scope: "organization", threshold: 80 },
    });
  });
});

describe("webhook deliveries", () => {
  test("creates a due delivery with retention and claims its first attempt", () => {
    expect(delivery.data).toMatchObject({
      attempt: 0,
      eventType: "user.created",
      maxAttempts: MAX_WEBHOOK_DELIVERY_ATTEMPTS,
      retentionExpiresAt: "2026-08-19T00:00:01.000Z",
      status: "pending",
    });
    expect(delivery.ttl).toBe(Date.parse("2026-08-19T00:00:01.000Z") / 1_000);
    const record = claimed(delivery, new Date("2026-07-20T00:00:02.000Z"));
    expect(record.data).toMatchObject({
      attempt: 1,
      claimExpiresAt: "2026-07-20T00:01:02.000Z",
      claimId: CLAIM_ID,
      status: "sending",
    });
    expect(buildWebhookPayload(delivery, endpoint, event)).toMatchObject({
      deliveryId: DELIVERY_ID,
      endpointId: ENDPOINT_ID,
      eventId: EVENT_ID,
      source: "deployments-ai.platform",
      version: 1,
    });
    expect(() =>
      buildWebhookPayload(delivery, endpoint, { ...event, aggregateVersion: 2 }),
    ).toThrow("does not match");
  });

  test("waits for an unexpired lease and reclaims an expired one without spending an attempt", () => {
    const sending = claimed(delivery, new Date("2026-07-20T00:00:02.000Z"));
    const early = claimWebhookDeliveryAttempt({
      claimId: SECOND_CLAIM_ID,
      delivery: sending,
      now: new Date("2026-07-20T00:00:30.000Z"),
    });
    expect(early).toMatchObject({ dueAt: new Date("2026-07-20T00:01:02.000Z"), kind: "wait" });
    const reclaimed = claimed(sending, new Date("2026-07-20T00:01:02.000Z"), SECOND_CLAIM_ID);
    expect(reclaimed.data).toMatchObject({ attempt: 1, claimId: SECOND_CLAIM_ID });
  });

  test("signs the request, records success, and writes an attempt record", async () => {
    const { outcome, requests } = await attempt(
      claimed(delivery, new Date("2026-07-20T00:00:02.000Z")),
      () => new Response("accepted", { headers: { "x-request-id": "req-1" }, status: 202 }),
    );
    if (outcome.kind === "not-claimed") throw new Error("Expected an attempt.");
    expect(outcome.kind).toBe("delivered");
    expect(outcome.record.data).toMatchObject({
      attempt: 1,
      responseCode: 202,
      status: "delivered",
    });
    expect(outcome.record.data).not.toHaveProperty("claimId");
    expect(outcome.attempt.data).toMatchObject({
      attempt: 1,
      durationMs: 1_000,
      manual: false,
      outcome: "delivered",
      responseBodyExcerpt: "accepted",
      responseHeaders: { "x-request-id": "req-1" },
      webhookDeliveryId: DELIVERY_ID,
    });
    expect(outcome.attempt.pk).toBe(
      `ORG#${delivery.data.organizationId}#WEBHOOK-DELIVERY#${DELIVERY_ID}`,
    );
    expect(outcome.attempt.sk).toBe("WEBHOOK-DELIVERY-ATTEMPT#0000000000000001");
    const [request] = requests;
    expect(request?.headers["x-deployments-event-id"]).toBe(EVENT_ID);
    expect(
      verifyWebhookSignature({
        body: request!.body,
        now: new Date("2026-07-20T00:00:02.000Z"),
        secrets: ["secret"],
        signature: request!.headers["x-deployments-signature"],
        timestamp: request!.headers["x-deployments-timestamp"],
      }),
    ).toBe(true);
  });

  test("schedules jittered retries from completion and fails after the last attempt", async () => {
    let record = delivery;
    const outcomes: string[] = [];
    let now = Date.parse("2026-07-20T00:00:02.000Z");
    for (let index = 0; index < MAX_WEBHOOK_DELIVERY_ATTEMPTS; index += 1) {
      const started = new Date(now).toISOString();
      const completed = new Date(now + 500).toISOString();
      const { outcome } = await attempt(
        claimed(record, new Date(started)),
        () => new Response("down", { status: 503 }),
        [started, completed],
      );
      if (outcome.kind === "not-claimed") throw new Error("Expected an attempt.");
      outcomes.push(outcome.kind);
      record = outcome.record;
      if (outcome.kind === "retrying") {
        // random() = 1 lands on the top of the equal-jitter window: the nominal delay.
        expect(outcome.retryDelayMs).toBe(Math.min(60_000 * 2 ** index, 6 * 3_600_000));
        expect(Date.parse(record.data.nextAttemptAt!)).toBe(now + 500 + outcome.retryDelayMs!);
        now = Date.parse(record.data.nextAttemptAt!);
      }
    }
    expect(outcomes).toEqual([
      ...Array(MAX_WEBHOOK_DELIVERY_ATTEMPTS - 1).fill("retrying"),
      "failed",
    ]);
    expect(record.data).toMatchObject({
      attempt: MAX_WEBHOOK_DELIVERY_ATTEMPTS,
      failureReason: "attempts-exhausted",
      responseCode: 503,
      status: "failed",
    });
    expect(
      claimWebhookDeliveryAttempt({ claimId: CLAIM_ID, delivery: record, now: new Date(now) }),
    ).toMatchObject({ kind: "terminal" });
  });

  test("does not retry permanent client errors or destination-security refusals", async () => {
    const gone = await attempt(
      claimed(delivery, new Date("2026-07-20T00:00:02.000Z")),
      () => new Response("gone", { status: 410 }),
    );
    expect(gone.outcome).toMatchObject({ kind: "failed" });
    expect(gone.outcome.record.data.failureReason).toBe("non-retryable");

    const refused = await attempt(claimed(delivery, new Date("2026-07-20T00:00:02.000Z")), () => {
      throw new TerminalWebhookSenderError("Destination resolves to a private address.");
    });
    expect(refused.outcome).toMatchObject({ kind: "failed" });
    expect(refused.outcome.record.data).toMatchObject({
      failureReason: "non-retryable",
      lastError: "Destination resolves to a private address.",
    });

    const network = await attempt(claimed(delivery, new Date("2026-07-20T00:00:02.000Z")), () => {
      throw new Error("ECONNRESET");
    });
    expect(network.outcome).toMatchObject({ kind: "retrying" });
    expect(network.outcome.record.data).not.toHaveProperty("responseCode");
  });

  test("refuses to send after the claim lease expired", async () => {
    const sending = claimed(delivery, new Date("2026-07-20T00:00:02.000Z"));
    const { outcome, requests } = await attempt(
      sending,
      () => new Response(null, { status: 204 }),
      ["2026-07-20T00:01:02.000Z", "2026-07-20T00:01:02.000Z"],
    );
    expect(outcome.kind).toBe("not-claimed");
    expect(requests).toHaveLength(0);
  });

  test("re-arms a terminal delivery for exactly one manual attempt", async () => {
    const failed = (
      await attempt(
        claimed(delivery, new Date("2026-07-20T00:00:02.000Z")),
        () => new Response("gone", { status: 410 }),
      )
    ).outcome.record;
    expect(() => rearmWebhookDeliveryForManualRetry(delivery, new Date())).toThrow();
    const rearmed = rearmWebhookDeliveryForManualRetry(
      failed,
      new Date("2026-07-21T00:00:00.000Z"),
    );
    expect(rearmed.data).toMatchObject({
      manualRetryRequestedAt: "2026-07-21T00:00:00.000Z",
      maxAttempts: 2,
      status: "pending",
    });
    expect(rearmed.data).not.toHaveProperty("failureReason");
    const { outcome } = await attempt(
      claimed(rearmed, new Date("2026-07-21T00:00:00.000Z")),
      () => new Response("still down", { status: 500 }),
      ["2026-07-21T00:00:00.000Z", "2026-07-21T00:00:01.000Z"],
    );
    if (outcome.kind === "not-claimed") throw new Error("Expected an attempt.");
    expect(outcome.kind).toBe("failed");
    expect(outcome.attempt.data).toMatchObject({ attempt: 2, manual: true });
    expect(outcome.record.data).not.toHaveProperty("manualRetryRequestedAt");
    expect(() =>
      rearmWebhookDeliveryForManualRetry(outcome.record, new Date("2026-09-01T00:00:00.000Z")),
    ).toThrow("retention has expired");
  });
});
