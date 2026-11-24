import type { PutRecordCommand } from "@aws-sdk/client-firehose";
import { describe, expect, mock, test } from "bun:test";
import type { Ulid } from "@deployments-ai/events";
import { projectSemanticEvent, semanticEventAnalyticsRecord } from "./index.ts";

const ORG_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;

function envelope() {
  return {
    account: "123456789012",
    detail: {
      actor: { id: ORG_ID, type: "principal" },
      aggregateId: ORG_ID,
      aggregateType: "organization",
      aggregateVersion: 2,
      eventId: EVENT_ID,
      eventType: "organization.updated",
      occurredAt: "2026-07-21T00:00:00.000Z",
      organizationId: ORG_ID,
      payload: { name: "Acme" },
      traceId: "trace-1",
    },
    "detail-type": "organization.updated",
    id: "eventbridge-1",
    region: "us-east-1",
    source: "deployments-ai.platform",
    time: "2026-07-21T00:00:01Z",
  } as const;
}

describe("event analytics projector", () => {
  test("flattens the semantic envelope without losing its canonical JSON", () => {
    const record = semanticEventAnalyticsRecord(envelope());

    expect(record).toMatchObject({
      actor_type: "principal",
      aggregate_version: 2,
      event_action: "updated",
      event_entity: "organization",
      event_id: EVENT_ID,
      event_type: "organization.updated",
      ingested_at: "2026-07-21T00:00:01.000Z",
      organization_id: ORG_ID,
    });
    expect(JSON.parse(record.payload_json)).toEqual({ name: "Acme" });
  });

  test("records the source of an event the install added to the log", () => {
    const record = semanticEventAnalyticsRecord({ ...envelope(), source: "acme.orders" });

    expect(record.event_source).toBe("acme.orders");
  });

  test("writes one newline-delimited record to Firehose", async () => {
    const commands: PutRecordCommand[] = [];
    const result = await projectSemanticEvent(envelope(), {
      deliveryStreamName: "platform-dev-semantic-events",
      firehose: {
        send: async (command) => {
          commands.push(command);
          return { RecordId: "record-1" };
        },
      },
    });

    expect(result).toEqual({ eventId: EVENT_ID });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.input.DeliveryStreamName).toBe("platform-dev-semantic-events");
    const data = commands[0]?.input.Record?.Data;
    expect(data).toBeDefined();
    const encoded = Buffer.from(data ?? []).toString("utf8");
    expect(encoded.endsWith("\n")).toBe(true);
    expect(JSON.parse(encoded)).toMatchObject({ event_id: EVENT_ID });
  });

  test("rejects malformed details without logging payloads", async () => {
    const originalConsoleError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError;
    const invalid = {
      ...envelope(),
      detail: { ...envelope().detail, aggregateVersion: 0, secret: "do-not-log" },
    };

    try {
      expect(projectSemanticEvent(invalid)).rejects.toThrow(
        "Semantic event analytical projection failed.",
      );
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("do-not-log");
    } finally {
      console.error = originalConsoleError;
    }
  });
});
