import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { makeDynamoDatabase } from "../dynamo-database.ts";
import { Ulid } from "../ids.ts";
import { WebhookDeliveryRecord } from "../records/events.ts";
import {
  decodePlatformRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "../records/index.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";
import { makeUniqueClaimRecord, uniqueClaimRequirements } from "../unique-claims.ts";
import { Effect } from "effect";
import { WebhookWriteConflictError, makeWebhookPersistence } from "./persistence.ts";

const id = (suffix: string) => Schema.decodeUnknownSync(Ulid)(`01J4000000000000000000000${suffix}`);
const organizationId = id("1");
const projectId = id("2");
const environmentId = id("3");
const endpointId = id("4");
const deliveryId = id("5");
const now = "2026-07-20T00:00:00.000Z";
const retentionExpiresAt = "2026-08-19T00:00:00.000Z";
const scope = { environmentId, organizationId };

function endpoint(status: "active" | "archived" | "disabled", version = 0) {
  return withCanonicalRecordKeys({
    data: {
      createdAt: now,
      environmentId,
      eventTypes: ["*"],
      id: endpointId,
      name: "Endpoint",
      organizationId,
      projectId,
      quotaSlot: 0,
      signingSecretRef: { credentialId: id("6"), generation: 0, store: "dynamodb-kms" },
      status,
      updatedAt: now,
      url: "https://hooks.example.com/",
      version,
    },
    itemType: "webhook-endpoint",
  }) as Extract<PlatformRecord, { readonly itemType: "webhook-endpoint" }>;
}

function delivery(status: "pending" | "sending", version = 0) {
  return Schema.decodeUnknownSync(WebhookDeliveryRecord)(
    withCanonicalRecordKeys({
      data: {
        aggregateId: id("7"),
        aggregateType: "run",
        aggregateVersion: 1,
        attempt: status === "sending" ? 1 : 0,
        createdAt: now,
        environmentId,
        eventId: id("8"),
        eventType: "run.completed",
        id: deliveryId,
        maxAttempts: 10,
        organizationId,
        projectId,
        retentionExpiresAt,
        status,
        updatedAt: now,
        version,
        webhookEndpointId: endpointId,
      },
      itemType: "webhook-delivery",
      ttl: Date.parse(retentionExpiresAt) / 1_000,
    }),
  );
}
function harness(...seed: PlatformRecord[]) {
  const dynamo = fakeDynamoDocumentClient();
  // Tenant writes are fenced on the organization record existing.
  dynamo.put(
    "control",
    withCanonicalRecordKeys({
      data: {
        createdAt: now,
        id: organizationId,
        name: "Organization",
        slug: "organization",
        status: "active",
        updatedAt: now,
        version: 1,
      },
      itemType: "organization",
    }),
  );
  for (const record of seed) {
    dynamo.put(record.itemType === "webhook-delivery" ? "events" : "control", record);
  }
  return { dynamo, persistence: makeWebhookPersistence(makeDynamoDatabase(dynamo.client)) };
}

describe("webhook persistence", () => {
  test("requires the retention TTL to match the delivery's logical expiration", async () => {
    const record = delivery("pending");
    expect(record.ttl).toBe(Date.parse(retentionExpiresAt) / 1_000);
    const mismatched = Effect.runPromise(decodePlatformRecord({ ...record, ttl: record.ttl! + 1 }));
    expect(mismatched).rejects.toThrow();
  });

  test("converges concurrent fan-out writes on one delivery record", async () => {
    const { dynamo, persistence } = harness(endpoint("active"));
    const results = await Promise.all([
      persistence.createDelivery(delivery("pending")),
      persistence.createDelivery(delivery("pending")),
    ]);
    expect(
      results
        .map((result) => result.created)
        .toSorted((left, right) => Number(left) - Number(right)),
    ).toEqual([false, true]);
    expect(dynamo.items("events")).toHaveLength(1);
  });

  test("rejects a stale delivery transition and a claim against an inactive endpoint", async () => {
    const pending = delivery("pending");
    const active = endpoint("active");
    const { persistence, dynamo } = harness(active, pending);
    const claimed = delivery("sending", 1);
    await persistence.replaceDelivery(pending, claimed, { activeEndpoint: active });
    expect(
      persistence.replaceDelivery(pending, delivery("sending", 1), { activeEndpoint: active }),
    ).rejects.toBeInstanceOf(WebhookWriteConflictError);

    const disabled = endpoint("disabled", 1);
    dynamo.put("control", disabled);
    expect(
      persistence.replaceDelivery(claimed, delivery("sending", 2), { activeEndpoint: active }),
    ).rejects.toBeInstanceOf(WebhookWriteConflictError);
    expect((await persistence.readDelivery(scope, deliveryId))?.data.version).toBe(1);
  });

  test("keeps the quota slot claim while an endpoint is disabled", async () => {
    const active = endpoint("active");
    const claim = makeUniqueClaimRecord(uniqueClaimRequirements(active)[0]!, now) as PlatformRecord;
    const { persistence } = harness(active, claim);
    expect(uniqueClaimRequirements(endpoint("disabled"))).toEqual(uniqueClaimRequirements(active));
    expect(uniqueClaimRequirements(endpoint("archived"))).toEqual([]);
    // Transaction invariants accept active -> disabled without touching the claim.
    await persistence.replaceEndpoint(active, endpoint("disabled", 1));
    expect((await persistence.readEndpoint(scope, endpointId))?.data.status).toBe("disabled");
  });
});
