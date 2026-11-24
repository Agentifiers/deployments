import type { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import { makeDynamoDatabase } from "./client.ts";
import {
  auditEventRecord,
  ENVIRONMENT_ID,
  EVENT_ID,
  ORG_ID,
  PROJECT_ID,
  recordingClient,
  TENANT_GATE_LANE_CONDITION,
} from "./database-write-test-support.ts";
import {
  makeSemanticEventRecord,
  transactWithSemanticEvents,
  transactWithSemanticEventsForErasure,
} from "./semantic-event-storage.ts";

const ERASURE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

function event() {
  return makeSemanticEventRecord({
    aggregateId: ORG_ID,
    aggregateType: "organization",
    aggregateVersion: 1,
    environmentId: ENVIRONMENT_ID,
    eventId: EVENT_ID,
    eventType: "organization.created",
    occurredAt: "2026-07-20T00:00:00.000Z",
    organizationId: ORG_ID,
    payload: {},
    projectId: PROJECT_ID,
  });
}

function sentFence(transactions: readonly TransactWriteCommand[]) {
  const items = transactions[0]?.input.TransactItems ?? [];
  const organizationChecks = items.flatMap((item) =>
    item.ConditionCheck?.Key?.pk === `ORG#${ORG_ID}` ? [item.ConditionCheck] : [],
  );
  return {
    eventTypes: items.flatMap((item) =>
      item.Put?.Item?.itemType === "semantic-event" ? [item.Put.Item.data.eventType] : [],
    ),
    fences: organizationChecks.map((check) => ({
      condition: check.ConditionExpression,
      sk: check.Key?.sk,
      values: check.ExpressionAttributeValues,
    })),
  };
}

describe("transactWithSemanticEvents", () => {
  test("passes only the named erasure through the organization fence when given an owner", async () => {
    const owned = recordingClient();
    await transactWithSemanticEventsForErasure(
      makeDynamoDatabase(owned.client),
      [{ kind: "put", record: await auditEventRecord() }],
      [event()],
      { operationId: ERASURE_ID, organizationId: ORG_ID },
    );
    const plain = recordingClient();
    await transactWithSemanticEvents(
      makeDynamoDatabase(plain.client),
      [{ kind: "put", record: await auditEventRecord() }],
      [event()],
    );

    expect({ owned: sentFence(owned.transactions), plain: sentFence(plain.transactions) }).toEqual({
      owned: {
        eventTypes: ["organization.created"],
        fences: [
          {
            condition:
              "attribute_exists(pk) AND #gate.#gateFence.#gateFenceOperation = :gateFenceOperation",
            sk: "ORGANIZATION-GATE-LANE#30",
            values: { ":gateFenceOperation": ERASURE_ID },
          },
        ],
      },
      plain: {
        eventTypes: ["organization.created"],
        fences: [
          {
            condition: TENANT_GATE_LANE_CONDITION,
            sk: "ORGANIZATION-GATE-LANE#30",
            values: { ":gateObservedAt": expect.any(String) },
          },
        ],
      },
    });
  });
});
