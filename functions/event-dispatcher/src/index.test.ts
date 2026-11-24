import { marshall } from "@aws-sdk/util-dynamodb";
import type { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { describe, expect, mock, test } from "bun:test";
import {
  internalSemanticEventPayload,
  makeSemanticEventRecord,
  type Ulid,
} from "@deployments-ai/events";
import { handleSemanticEventStream, type EventBridgeSender } from "./index.ts";

const ORG_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;

function streamRecord(
  eventId = "stream-record-1",
  sequenceNumber = "100",
  payload: Parameters<typeof makeSemanticEventRecord>[0]["payload"] = { id: ORG_ID },
) {
  const event = makeSemanticEventRecord({
    aggregateId: ORG_ID,
    aggregateType: "organization",
    aggregateVersion: 1,
    eventId: EVENT_ID,
    eventType: "organization.created",
    occurredAt: "2026-07-20T00:00:00.000Z",
    organizationId: ORG_ID,
    payload,
  });
  return {
    dynamodb: { NewImage: marshall(event), SequenceNumber: sequenceNumber },
    eventID: eventId,
    eventName: "INSERT",
  };
}

describe("event dispatcher", () => {
  test("publishes inserted semantic events to the standalone EventBridge bus", async () => {
    const commands: unknown[] = [];
    const sender: EventBridgeSender = {
      send: async (command) => {
        commands.push(command);
        return { Entries: [{ EventId: "eventbridge-1" }], FailedEntryCount: 0 };
      },
    };

    const result = await handleSemanticEventStream(
      { Records: [streamRecord()] },
      { eventBridge: sender, eventBusName: "platform-dev" },
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(commands).toHaveLength(1);
    expect((commands[0] as { input: { Entries: unknown[] } }).input.Entries).toEqual([
      expect.objectContaining({
        DetailType: "organization.created",
        EventBusName: "platform-dev",
        Source: "deployments-ai.platform",
      }),
    ]);
  });

  test("ignores non-insert records defensively", async () => {
    const sender: EventBridgeSender = {
      send: async () => {
        throw new Error("should not publish");
      },
    };
    const record = { ...streamRecord(), eventName: "MODIFY" };

    const result = await handleSemanticEventStream(
      { Records: [record] },
      { eventBridge: sender, eventBusName: "platform-dev" },
    );

    expect(result).toEqual({ batchItemFailures: [] });
  });

  test("does not publish internal thread-sequencing events", async () => {
    const commands: PutEventsCommand[] = [];
    const sender: EventBridgeSender = {
      send: async (command) => {
        commands.push(command);
        return { Entries: [{ EventId: "unexpected" }], FailedEntryCount: 0 };
      },
    };

    const result = await handleSemanticEventStream(
      {
        Records: [
          streamRecord(
            "internal-stream-record",
            "200",
            internalSemanticEventPayload({ messageId: EVENT_ID }),
          ),
        ],
      },
      { eventBridge: sender, eventBusName: "platform-dev" },
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(commands).toEqual([]);
  });

  test("returns only rejected EventBridge entries as partial batch failures", async () => {
    const sender: EventBridgeSender = {
      send: async () => ({
        Entries: [{ EventId: "eventbridge-1" }, { ErrorCode: "InternalFailure" }],
        FailedEntryCount: 1,
      }),
    };

    const result = await handleSemanticEventStream(
      { Records: [streamRecord("stream-1", "100"), streamRecord("stream-2", "101")] },
      { eventBridge: sender, eventBusName: "platform-dev" },
    );

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: "101" }],
    });
  });

  test("packs EventBridge requests below both count and byte limits", async () => {
    const commands: PutEventsCommand[] = [];
    const sender: EventBridgeSender = {
      send: async (command) => {
        commands.push(command);
        return {
          Entries: command.input.Entries?.map(() => ({ EventId: "eventbridge" })),
          FailedEntryCount: 0,
        };
      },
    };
    const records = Array.from({ length: 10 }, (_, index) =>
      streamRecord(`stream-${index}`, String(100 + index), {
        body: "x".repeat(160_000),
      }),
    );

    const result = await handleSemanticEventStream(
      { Records: records },
      { eventBridge: sender, eventBusName: "platform-dev" },
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      const entries = command.input.Entries ?? [];
      const bytes = entries.reduce(
        (total, entry) =>
          total +
          new TextEncoder().encode(entry.Source ?? "").byteLength +
          new TextEncoder().encode(entry.DetailType ?? "").byteLength +
          new TextEncoder().encode(entry.Detail ?? "").byteLength,
        0,
      );
      expect(entries.length).toBeLessThanOrEqual(10);
      expect(bytes).toBeLessThan(1_048_576);
    }
  });

  test("does not log payload-bearing EventBridge exceptions", async () => {
    const originalConsoleError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError;
    const sender: EventBridgeSender = {
      send: async () => {
        throw {
          name: "EventBridgeFailure",
          request: { Detail: "must-not-reach-logs" },
        };
      },
    };

    try {
      const result = await handleSemanticEventStream(
        { Records: [streamRecord("stream-secret", "777")] },
        { eventBridge: sender, eventBusName: "platform-dev" },
      );

      expect(result).toEqual({
        batchItemFailures: [{ itemIdentifier: "777" }],
      });
      expect(JSON.stringify(consoleError.mock.calls)).toContain("EventBridgeFailure");
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("must-not-reach-logs");
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("retries malformed stream records instead of dropping them", async () => {
    const originalConsoleError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError;
    const sender: EventBridgeSender = {
      send: async () => ({ Entries: [], FailedEntryCount: 0 }),
    };

    try {
      const invalidEvent = {
        ...makeSemanticEventRecord({
          aggregateId: ORG_ID,
          aggregateType: "organization",
          aggregateVersion: 1,
          eventId: EVENT_ID,
          eventType: "organization.created",
          occurredAt: "2026-07-20T00:00:00.000Z",
          organizationId: ORG_ID,
          payload: { secret: "must-not-reach-logs" },
        }),
        itemType: "unknown-record",
      };
      const result = await handleSemanticEventStream(
        {
          Records: [
            {
              dynamodb: { NewImage: marshall(invalidEvent), SequenceNumber: "999" },
              eventID: "bad-record",
              eventName: "INSERT",
            },
          ],
        },
        { eventBridge: sender, eventBusName: "platform-dev" },
      );

      expect(result).toEqual({
        batchItemFailures: [{ itemIdentifier: "999" }],
      });
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("must-not-reach-logs");
    } finally {
      console.error = originalConsoleError;
    }
  });
});
