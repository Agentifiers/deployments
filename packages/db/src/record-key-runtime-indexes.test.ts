import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { Ulid } from "./ids.ts";
import { key } from "./keys.ts";
import { canonicalRecordKeys, EXECUTION_QUEUE_SHARD_COUNT } from "./record-keys.ts";
import { ProviderMutationClaimRecord } from "./records/execution.ts";
import { decodePlatformRecord, withCanonicalRecordKeys } from "./records/index.ts";

const ORG_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const BILLING_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const MESSAGE_1_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAY");
const MESSAGE_2_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAZ");
const WEBHOOK_ENDPOINT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FB0");

describe("keys", () => {
  test("keeps legacy provider mutation claims readable during key migration", async () => {
    const updatedAt = "2026-07-23T12:00:00.000Z";
    const canonical = Schema.decodeUnknownSync(ProviderMutationClaimRecord)(
      withCanonicalRecordKeys({
        data: {
          claimAttemptId: "attempt-1",
          connectionId: BILLING_ID,
          createdAt: updatedAt,
          environmentId: BILLING_ID,
          id: MESSAGE_2_ID,
          idempotencyKey: "mutation/request-1",
          immutableIdentityHash: "sha256:identity",
          operation: "shopify.fulfillments.create",
          organizationId: ORG_ID,
          projectId: BILLING_ID,
          runId: MESSAGE_1_ID,
          status: "succeeded" as const,
          threadId: MESSAGE_1_ID,
          toolCallId: MESSAGE_2_ID,
          updatedAt,
          version: 1,
        },
        itemType: "provider-mutation-claim" as const,
      }),
    );
    const legacy = {
      ...canonical,
      pk: key("ORG", canonical.data.organizationId, "ENV", canonical.data.environmentId),
      sk: key("PROVIDER-MUTATION-CLAIM", canonical.data.idempotencyKey),
      gsi2sk: key(
        "PROVIDER-MUTATION-CLAIM",
        canonical.data.status,
        updatedAt,
        canonical.data.idempotencyKey,
      ),
    };

    expect(Effect.runPromise(decodePlatformRecord(legacy))).resolves.toEqual(legacy);
  });

  test("keeps idempotent partitions stable when optional run associations change", () => {
    const meterWithoutRun = canonicalRecordKeys(
      {
        data: {
          environmentId: BILLING_ID,
          idempotencyKey: "meter/request-1",
          organizationId: ORG_ID,
        },
        itemType: "meter-event",
      },
      "usage",
    );
    const meterWithRun = canonicalRecordKeys(
      {
        data: {
          environmentId: BILLING_ID,
          idempotencyKey: "meter/request-1",
          organizationId: ORG_ID,
          runId: MESSAGE_1_ID,
        },
        itemType: "meter-event",
      },
      "usage",
    );
    const fireWithoutRun = canonicalRecordKeys(
      {
        data: {
          fireKey: "2026-07-20T12:00:00.000Z",
          organizationId: ORG_ID,
          scheduleId: MESSAGE_1_ID,
        },
        itemType: "schedule-fire",
      },
      "execution",
    );
    const fireWithRun = canonicalRecordKeys(
      {
        data: {
          fireKey: "2026-07-20T12:00:00.000Z",
          organizationId: ORG_ID,
          runId: MESSAGE_2_ID,
          scheduleId: MESSAGE_1_ID,
        },
        itemType: "schedule-fire",
      },
      "execution",
    );

    expect(meterWithRun.pk).toBe(meterWithoutRun.pk);
    expect(meterWithRun.sk).toBe(meterWithoutRun.sk);
    expect(fireWithRun.pk).toBe(fireWithoutRun.pk);
    expect(fireWithRun.sk).toBe(fireWithoutRun.sk);
  });

  test("indexes webhook deliveries under their endpoint newest-first", () => {
    const delivery = canonicalRecordKeys(
      {
        data: {
          createdAt: "2026-07-20T12:00:00.000Z",
          id: ORG_ID,
          status: "delivered",
          updatedAt: "2026-07-20T12:00:01.000Z",
          webhookEndpointId: WEBHOOK_ENDPOINT_ID,
        },
        itemType: "webhook-delivery",
      },
      "events",
    );

    expect(delivery.gsi1pk).toBe(`WEBHOOK-ENDPOINT#${WEBHOOK_ENDPOINT_ID}#DELIVERIES`);
    expect(delivery.gsi1sk).toBe(`WEBHOOK-DELIVERY#2026-07-20T12%3A00%3A00.000Z#${ORG_ID}`);
  });

  test("keeps webhook deliveries out of the due-work index and partitions attempts by delivery", () => {
    const retry = canonicalRecordKeys(
      {
        data: {
          createdAt: "2026-07-20T12:00:00.000Z",
          id: ORG_ID,
          nextAttemptAt: "2026-07-20T13:00:00.000Z",
          organizationId: ORG_ID,
          status: "retrying",
          updatedAt: "2026-07-20T12:00:00.000Z",
          webhookEndpointId: WEBHOOK_ENDPOINT_ID,
        },
        itemType: "webhook-delivery",
      },
      "events",
    );
    const attempt = canonicalRecordKeys(
      {
        data: {
          attempt: 3,
          createdAt: "2026-07-20T12:00:00.000Z",
          organizationId: ORG_ID,
          webhookDeliveryId: BILLING_ID,
        },
        itemType: "webhook-delivery-attempt",
      },
      "events",
    );

    // SQS message visibility schedules webhook retries; no shared due index is maintained.
    expect(retry.gsi2pk).toBeUndefined();
    expect(attempt.pk).toBe(`ORG#${ORG_ID}#WEBHOOK-DELIVERY#${BILLING_ID}`);
    expect(attempt.sk).toBe("WEBHOOK-DELIVERY-ATTEMPT#0000000000000003");
  });

  test("keeps queued work discoverable across time boundaries", () => {
    const queued = (updatedAt: string) =>
      canonicalRecordKeys(
        {
          data: {
            idempotencyKey: "run/request-1",
            organizationId: ORG_ID,
            priority: 10,
            status: "queued",
            threadId: MESSAGE_1_ID,
            updatedAt,
          },
          itemType: "run",
        },
        "execution",
      );
    const initial = queued("2026-07-20T12:00:00.000Z");
    const aged = queued("2026-07-21T12:00:00.000Z");

    expect(EXECUTION_QUEUE_SHARD_COUNT).toBe(16);
    expect(initial.gsi1pk).toMatch(/^QUEUE#RUN#queued#(?:0[0-9]|1[0-5])$/u);
    expect(aged.gsi1pk).toBe(initial.gsi1pk);
    expect(aged.gsi1sk).not.toBe(initial.gsi1sk);
  });

  test("indexes runs by deployment for bounded active-run checks", () => {
    const keys = canonicalRecordKeys(
      {
        data: {
          agentDeploymentId: MESSAGE_2_ID,
          environmentId: BILLING_ID,
          idempotencyKey: "run/request-1",
          organizationId: ORG_ID,
          priority: 10,
          status: "running",
          threadId: MESSAGE_1_ID,
          updatedAt: "2026-07-20T12:00:00.000Z",
        },
        itemType: "run",
      },
      "execution",
    );

    expect(keys.gsi2pk).toBe(`ENV#${BILLING_ID}#AGENT-DEPLOYMENT#${MESSAGE_2_ID}`);
    expect(keys.gsi2sk).toBe(`RUN#running#2026-07-20T12%3A00%3A00.000Z#run%2Frequest-1`);
  });

  test("orders internal release controls within an agent definition", () => {
    const control = canonicalRecordKeys(
      {
        data: {
          agentDefinitionId: MESSAGE_1_ID,
          id: MESSAGE_2_ID,
          organizationId: ORG_ID,
          releaseNumber: 12,
        },
        itemType: "agent-release-control",
      },
      "control",
    );
    const index = canonicalRecordKeys(
      {
        data: {
          agentDefinitionId: MESSAGE_1_ID,
          id: MESSAGE_1_ID,
          organizationId: ORG_ID,
        },
        itemType: "agent-definition-release-index",
      },
      "control",
    );

    expect(control.pk).toBe(`ORG#${ORG_ID}#AGENT-DEFINITION#${MESSAGE_1_ID}`);
    expect(control.sk).toBe(`AGENT-RELEASE-CONTROL#0000000000000012#${MESSAGE_2_ID}`);
    expect(index.pk).toBe(control.pk);
    expect(index.sk).toBe(`AGENT-DEFINITION-RELEASE-INDEX#${MESSAGE_1_ID}`);
  });

  test("normalizes legacy environment-scoped run index keys during decode", async () => {
    const canonical = withCanonicalRecordKeys({
      data: {
        agentDeploymentId: MESSAGE_2_ID,
        agentReleaseId: MESSAGE_1_ID,
        attempt: 1,
        captureMode: "metadata-only" as const,
        createdAt: "2026-07-20T12:00:00.000Z",
        environmentId: BILLING_ID,
        executor: "platform",
        id: ORG_ID,
        idempotencyKey: "run/request-1",
        organizationId: ORG_ID,
        priority: 10,
        projectId: MESSAGE_1_ID,
        redactionPolicyVersion: 1 as const,
        schemaVersion: 1 as const,
        spanId: "0123456789abcdef",
        status: "running" as const,
        threadId: MESSAGE_1_ID,
        trigger: "api",
        traceId: "0123456789abcdef0123456789abcdef",
        updatedAt: "2026-07-20T12:00:00.000Z",
        version: 1,
      },
      itemType: "run" as const,
    });

    const decoded = await Effect.runPromise(
      decodePlatformRecord({ ...canonical, gsi2pk: `ENV#${BILLING_ID}` }),
    );

    expect(decoded.gsi2pk).toBe(`ENV#${BILLING_ID}#AGENT-DEPLOYMENT#${MESSAGE_2_ID}`);
  });

  test("uses aggregate version as the semantic event base-table identity", () => {
    const first = canonicalRecordKeys(
      {
        data: {
          aggregateId: ORG_ID,
          aggregateType: "organization",
          aggregateVersion: 7,
          eventId: MESSAGE_1_ID,
        },
        itemType: "semantic-event",
      },
      "events",
    );
    const second = canonicalRecordKeys(
      {
        data: {
          aggregateId: ORG_ID,
          aggregateType: "organization",
          aggregateVersion: 7,
          eventId: MESSAGE_2_ID,
        },
        itemType: "semantic-event",
      },
      "events",
    );

    expect(first.pk).toBe(second.pk);
    expect(first.sk).toBe(second.sk);
    expect(first.sk).toBe("SEMANTIC-EVENT#0000000000000007");
  });

  test("rejects canonical keys beyond DynamoDB byte limits", () => {
    expect(() =>
      canonicalRecordKeys(
        {
          data: { namespace: "n".repeat(2_049), value: "value" },
          itemType: "unique-claim",
        },
        "control",
      ),
    ).toThrow();
    expect(() =>
      canonicalRecordKeys(
        {
          data: { idempotencyKey: "x".repeat(1_025), organizationId: ORG_ID },
          itemType: "idempotency",
        },
        "events",
      ),
    ).toThrow();
  });

  test("refuses to index an operator access record whose state has no kind", () => {
    const data = {
      expiresAt: "2100-01-01T00:00:00.000Z",
      grantId: MESSAGE_1_ID,
      organizationId: ORG_ID,
      principalId: BILLING_ID,
    };
    const keys = (state: Readonly<Record<string, unknown>> | undefined) =>
      canonicalRecordKeys(
        {
          data: { ...data, ...(state ? { state } : {}) },
          itemType: "organization-operator-access",
        },
        "control",
      );

    expect(keys({ kind: "closed" }).gsi2sk).toStartWith("closed#");
    expect(() => keys({})).toThrow("requires kind");
    expect(() => keys(undefined)).toThrow("requires kind");
  });

  test("separates provider webhook replay namespaces", () => {
    const first = canonicalRecordKeys(
      {
        data: {
          installationId: ORG_ID,
          providerEventIdOrHash: "event-123",
          replayNamespace: "live",
        },
        itemType: "provider-webhook-replay-claim",
      },
      "events",
    );
    const second = canonicalRecordKeys(
      {
        data: {
          installationId: ORG_ID,
          providerEventIdOrHash: "event-123",
          replayNamespace: "backfill",
        },
        itemType: "provider-webhook-replay-claim",
      },
      "events",
    );

    expect(first.sk).not.toBe(second.sk);
  });

  test("partitions rate-limit counters by scope", () => {
    const first = canonicalRecordKeys(
      {
        data: { limitKey: "api", scopeId: ORG_ID, window: "minute" },
        itemType: "rate-limit-counter",
      },
      "usage",
    );
    const second = canonicalRecordKeys(
      {
        data: { limitKey: "api", scopeId: BILLING_ID, window: "minute" },
        itemType: "rate-limit-counter",
      },
      "usage",
    );

    expect(first.pk).toBe(`SCOPE#${ORG_ID}`);
    expect(second.pk).toBe(`SCOPE#${BILLING_ID}`);
    expect(first.pk).not.toBe(second.pk);
  });
});
