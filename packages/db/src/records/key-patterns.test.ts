import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import { EXECUTION_QUEUE_SHARD_COUNT, canonicalRecordKeys } from "../record-keys.ts";
const ORG_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const BILLING_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const MESSAGE_1_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAY");
const MESSAGE_2_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAZ");

describe("record catalog", () => {
  test("stores run edges in the parent run partition", () => {
    const edge = canonicalRecordKeys(
      {
        data: {
          id: BILLING_ID,
          organizationId: ORG_ID,
          parentRunId: MESSAGE_1_ID,
        },
        itemType: "run-edge",
      },
      "execution",
    );

    expect(edge.pk).toBe(`ORG#${ORG_ID}#RUN#${MESSAGE_1_ID}`);
  });

  test("stores provider mutation claims in their run partition", () => {
    const claim = canonicalRecordKeys(
      {
        data: {
          id: BILLING_ID,
          idempotencyKey: "mutation/request-1",
          organizationId: ORG_ID,
          runId: MESSAGE_1_ID,
        },
        itemType: "provider-mutation-claim",
      },
      "execution",
    );

    expect(claim.pk).toBe(`ORG#${ORG_ID}#RUN#${MESSAGE_1_ID}`);
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

  test("keys one sandbox workspace per thread and execution target", () => {
    const workspace = (id: string, executionTargetKind: string, executionTargetId: string) =>
      canonicalRecordKeys(
        {
          data: {
            environmentId: BILLING_ID,
            executionTargetId,
            executionTargetKind,
            id,
            organizationId: ORG_ID,
            threadId: MESSAGE_1_ID,
            updatedAt: "2026-09-29T12:00:00.000Z",
          },
          itemType: "sandbox-workspace",
        },
        "execution",
      );
    const first = workspace(MESSAGE_2_ID, "agent-deployment", BILLING_ID);
    const recreated = workspace(ORG_ID, "agent-deployment", BILLING_ID);
    const otherDeployment = workspace(MESSAGE_2_ID, "agent-deployment", MESSAGE_2_ID);
    const bindingWithSameId = workspace(MESSAGE_2_ID, "execution-binding", BILLING_ID);

    expect(first.pk).toBe(`ORG#${ORG_ID}#THREAD#${MESSAGE_1_ID}`);
    expect(first.sk).toBe(`SANDBOX-WORKSPACE#agent-deployment#${BILLING_ID}`);
    expect(recreated.sk).toBe(first.sk);
    expect(otherDeployment.pk).toBe(first.pk);
    expect(otherDeployment.sk).not.toBe(first.sk);
    expect(bindingWithSameId.pk).toBe(first.pk);
    expect(bindingWithSameId.sk).toBe(`SANDBOX-WORKSPACE#execution-binding#${BILLING_ID}`);
    expect(first.gsi1pk).toBeUndefined();
    expect(first.gsi2pk).toBe(`ENV#${BILLING_ID}`);
  });

  test("partitions sandbox leases by execution target kind and id", () => {
    const lease = (executionTargetKind: string) =>
      canonicalRecordKeys(
        {
          data: {
            environmentId: BILLING_ID,
            executionTargetId: BILLING_ID,
            executionTargetKind,
            id: MESSAGE_1_ID,
            organizationId: ORG_ID,
          },
          itemType: "sandbox-lease",
        },
        "execution",
      );
    const deployment = lease("agent-deployment");
    const binding = lease("execution-binding");

    expect(deployment.pk).toBe(`ORG#${ORG_ID}#EXECUTION-TARGET#agent-deployment#${BILLING_ID}`);
    expect(binding.pk).toBe(`ORG#${ORG_ID}#EXECUTION-TARGET#execution-binding#${BILLING_ID}`);
    expect(binding.sk).toBe(deployment.sk);
    expect(deployment.sk).toBe(`SANDBOX-LEASE#${MESSAGE_1_ID}`);
  });
});
