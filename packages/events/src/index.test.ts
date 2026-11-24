import { marshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, test } from "bun:test";
import {
  executionEventPayload,
  type DynamoDatabaseService,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { Effect } from "effect";
import {
  classifyAggregateDelivery,
  crudActionForOperation,
  crudEventType,
  makeConsumerCheckpointRecord,
  makeCrudSemanticEventRecord,
  makeDeliveryDeduplicationRecord,
  makeSemanticEventRecord,
  parseSemanticEvent,
  replaySemanticEvents,
  semanticEventBridgeEntry,
  semanticEventIsInternal,
  semanticEventRecordFromStreamRecord,
  transactWithSemanticEvents,
} from "./index.ts";

const ORG_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;

function eventRecord(version = 1) {
  return makeCrudSemanticEventRecord({
    action: "created",
    actor: { id: PROJECT_ID, type: "principal" },
    aggregateId: ORG_ID,
    aggregateType: "organization",
    aggregateVersion: version,
    entity: "organization",
    environmentId: ENVIRONMENT_ID,
    eventId: EVENT_ID,
    occurredAt: "2026-07-20T00:00:00.000Z",
    organizationId: ORG_ID,
    payload: { id: ORG_ID },
    projectId: PROJECT_ID,
  });
}

function fakeDatabase(overrides: Partial<DynamoDatabaseService>): DynamoDatabaseService {
  return {
    deleteRecord: () => Promise.reject(new Error("not implemented")),
    getRecord: () => Promise.reject(new Error("not implemented")),
    putRecord: () => Promise.reject(new Error("not implemented")),
    queryRecords: () => Promise.reject(new Error("not implemented")),
    transactWrite: () => Promise.reject(new Error("not implemented")),
    ...overrides,
  };
}

describe("semantic events", () => {
  test("ports CRUD operation and topic normalization", () => {
    expect(crudActionForOperation("PUT")).toBe("updated");
    expect(crudActionForOperation("delete")).toBe("deleted");
    expect(crudEventType("provider_connection", "created")).toBe("provider-connection.created");
  });

  test("creates an ordered semantic event outbox record", () => {
    const record = eventRecord();

    expect(record.pk).toBe(`ORG#${ORG_ID}#AGGREGATE#organization#${ORG_ID}`);
    expect(record.sk).toBe("SEMANTIC-EVENT#0000000000000001");
    expect(record.gsi1sk).toBe(`VERSION#0000000000000001#${EVENT_ID}`);
    expect(record.data.eventType).toBe("organization.created");
  });

  test("keeps customer run events webhook-visible while preview and evaluation runs stay internal", () => {
    const runEvent = (pins: Parameters<typeof executionEventPayload>[0]) =>
      makeSemanticEventRecord({
        aggregateId: ORG_ID,
        aggregateType: "run",
        aggregateVersion: 4,
        environmentId: ENVIRONMENT_ID,
        eventId: EVENT_ID,
        eventType: "run.completed",
        occurredAt: "2026-07-20T00:00:00.000Z",
        organizationId: ORG_ID,
        payload: executionEventPayload(pins, { status: "completed", threadId: ORG_ID }),
        projectId: PROJECT_ID,
      });

    const customer = runEvent({ agentDeploymentId: PROJECT_ID, agentReleaseId: ENVIRONMENT_ID });
    expect(semanticEventIsInternal(customer)).toBe(false);
    expect(customer.data.payload).toEqual({ status: "completed", threadId: ORG_ID });
    for (const executionPurpose of ["preview", "evaluation"]) {
      expect(
        semanticEventIsInternal(runEvent({ executionBindingId: PROJECT_ID, executionPurpose })),
      ).toBe(true);
    }
  });

  test("rejects aggregate types that alias after key normalization", () => {
    expect(() =>
      makeCrudSemanticEventRecord({
        action: "created",
        aggregateId: ORG_ID,
        aggregateType: " organization ",
        aggregateVersion: 1,
        entity: "organization",
        eventId: EVENT_ID,
        organizationId: ORG_ID,
        payload: {},
      }),
    ).toThrow("surrounding whitespace");
  });

  test("bounds analytical envelope strings", () => {
    expect(() =>
      makeCrudSemanticEventRecord({
        action: "created",
        aggregateId: ORG_ID,
        aggregateType: "x".repeat(129),
        aggregateVersion: 1,
        entity: "organization",
        eventId: EVENT_ID,
        organizationId: ORG_ID,
        payload: {},
      }),
    ).toThrow("must not exceed 128 characters");
    expect(() =>
      makeCrudSemanticEventRecord({
        action: "created",
        aggregateId: ORG_ID,
        aggregateType: "organization",
        aggregateVersion: 1,
        entity: "organization",
        eventId: EVENT_ID,
        organizationId: ORG_ID,
        payload: {},
        traceId: "x".repeat(257),
      }),
    ).toThrow("must not exceed 256 characters");
  });

  test("rejects event types that EventBridge cannot accept", () => {
    expect(() =>
      makeCrudSemanticEventRecord({
        action: "created",
        aggregateId: ORG_ID,
        aggregateType: "organization",
        aggregateVersion: 1,
        entity: "x".repeat(129),
        eventId: EVENT_ID,
        organizationId: ORG_ID,
        payload: {},
      }),
    ).toThrow();
  });

  test("reserves headroom for event delivery failure envelopes", () => {
    expect(() =>
      makeCrudSemanticEventRecord({
        action: "created",
        aggregateId: ORG_ID,
        aggregateType: "organization",
        aggregateVersion: 1,
        entity: "organization",
        eventId: EVENT_ID,
        organizationId: ORG_ID,
        payload: { body: "\0".repeat(180_000) },
      }),
    ).toThrow();
  });

  test("keeps canonical event acceptance independent from optional analytics encoding", () => {
    const record = makeCrudSemanticEventRecord({
      action: "created",
      aggregateId: ORG_ID,
      aggregateType: "organization",
      aggregateVersion: 1,
      entity: "organization",
      eventId: EVENT_ID,
      organizationId: ORG_ID,
      payload: { body: '\\"'.repeat(50_000) },
    });

    expect(record.data.eventId).toBe(EVENT_ID);
  });

  test("commits resource mutations and semantic outbox records in one transaction", async () => {
    const operations: TransactionOperation[] = [];
    let committed: readonly TransactionOperation[] = [];
    const database = fakeDatabase({
      transactWrite: async (transactionOperations) => {
        committed = transactionOperations;
      },
    });

    await transactWithSemanticEvents(database, operations, [eventRecord()]);

    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({
      kind: "put",
      record: { itemType: "semantic-event" },
    });
  });

  test("rejects multiple event appends for one aggregate in one transaction", () => {
    const database = fakeDatabase({});

    expect(() =>
      transactWithSemanticEvents(database, [], [eventRecord(1), eventRecord(2)]),
    ).toThrow("at most one semantic event per aggregate");
  });

  test("rejects semantic event mutations that bypass the sequenced event argument", () => {
    const database = fakeDatabase({});
    const event = eventRecord(1);

    expect(() =>
      transactWithSemanticEvents(database, [{ kind: "put", record: event }], []),
    ).toThrow("must use the events argument");
    expect(() =>
      transactWithSemanticEvents(database, [{ kind: "delete", record: event }], []),
    ).toThrow("must use the events argument");
  });

  test("replays one aggregate from the strongly consistent base-table log", async () => {
    let query: Record<string, unknown> | undefined;
    const record = eventRecord();
    const database = fakeDatabase({
      queryRecords: async (_table, input) => {
        query = input;
        return { items: [record] };
      },
    });

    const result = await replaySemanticEvents(database, {
      aggregateId: ORG_ID,
      aggregateType: "organization",
      fromVersion: 1,
      organizationId: ORG_ID,
      toVersion: 10,
    });

    expect(result.events).toEqual([record]);
    expect(query).toMatchObject({
      ConsistentRead: true,
      KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
      ScanIndexForward: true,
    });
    expect(query?.ExpressionAttributeValues).toEqual({
      ":from": "SEMANTIC-EVENT#0000000000000001",
      ":pk": `ORG#${ORG_ID}#AGGREGATE#organization#${ORG_ID}`,
      ":to": "SEMANTIC-EVENT#0000000000000010",
    });
  });

  test("decodes only inserted semantic event stream records", async () => {
    const semantic = eventRecord();
    const decoded = await Effect.runPromise(
      semanticEventRecordFromStreamRecord({
        dynamodb: { NewImage: marshall(semantic) },
        eventID: "stream-record-1",
        eventName: "INSERT",
      }),
    );
    const ignored = await Effect.runPromise(
      semanticEventRecordFromStreamRecord({
        dynamodb: { NewImage: marshall(semantic) },
        eventName: "MODIFY",
      }),
    );

    expect(decoded).toEqual(semantic);
    expect(ignored).toBeUndefined();
  });

  test("serializes the standalone semantic envelope for EventBridge", () => {
    const entry = semanticEventBridgeEntry(eventRecord(), "platform-dev");

    expect(entry).toMatchObject({
      DetailType: "organization.created",
      EventBusName: "platform-dev",
      Source: "deployments-ai.platform",
    });
    expect(JSON.parse(entry.Detail)).toMatchObject({
      aggregateVersion: 1,
      eventId: EVENT_ID,
    });
  });

  test("decodes standalone EventBridge detail through the canonical schema", () => {
    const detail = eventRecord().data;

    expect(parseSemanticEvent(detail)).toEqual(detail);
    expect(() => parseSemanticEvent({ ...detail, aggregateVersion: 0 })).toThrow();
  });

  test("enforces envelope lengths when decoding standalone events", () => {
    const detail = eventRecord().data;

    expect(() => parseSemanticEvent({ ...detail, aggregateType: "x".repeat(129) })).toThrow();
    expect(() => parseSemanticEvent({ ...detail, traceId: "x".repeat(257) })).toThrow();
  });

  test("classifies duplicate, next, and out-of-order aggregate versions", () => {
    expect(classifyAggregateDelivery(eventRecord(2).data, 2)).toEqual({
      kind: "duplicate",
      lastAggregateVersion: 2,
    });
    expect(classifyAggregateDelivery(eventRecord(2).data, 1)).toEqual({ kind: "next" });
    expect(classifyAggregateDelivery(eventRecord(3).data, 1)).toEqual({
      expectedAggregateVersion: 2,
      kind: "gap",
    });
  });

  test("builds canonical deduplication and checkpoint records", () => {
    const deduplication = makeDeliveryDeduplicationRecord({
      consumer: "webhook-delivery",
      deliveredAt: "2026-07-20T00:01:00.000Z",
      eventId: EVENT_ID,
      expiresAt: "2026-07-27T00:01:00.000Z",
    });
    const checkpoint = makeConsumerCheckpointRecord({
      consumer: "eventbridge-dispatcher",
      cursor: "1234",
      lastEventId: EVENT_ID,
      now: "2026-07-20T00:01:00.000Z",
      shardId: "shard-1",
    });

    expect(deduplication.sk).toBe(`DELIVERY-DEDUPLICATION#webhook-delivery#${EVENT_ID}`);
    expect(deduplication.ttl).toBe(Math.floor(Date.parse("2026-07-27T00:01:00.000Z") / 1_000));
    expect(checkpoint.sk).toBe("CONSUMER-CHECKPOINT#eventbridge-dispatcher#shard-1");
  });
});
