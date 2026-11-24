import { describe, expect, test } from "bun:test";
import { prepareDynamoTransactionOperations, transactionItemCount } from "../dynamo-database.ts";
import { recordDataFields } from "../record-schema.ts";
import { RECORD_SCHEMAS, RECORD_TYPES_BY_TABLE, type ItemType } from "../records/index.ts";
import { makeSemanticEventRecord } from "../semantic-event-storage.ts";
import { THREAD_OWNERSHIP, governanceThreadIds } from "./ownership.ts";
import { stableTenantMutationCapacity } from "./transaction-capacity.ts";
import {
  REQUESTER,
  SCOPE,
  erasureTestDatabase,
  messageRecord,
  runRecord,
  seedRecords,
  testId,
  threadRecord,
  toolCallRecord,
} from "./erasure-test-support.ts";

const THREAD = testId("T1");
const SIBLING = testId("T2");

const THREAD_NAMING_TYPES_NOT_OWNED: ItemType[] = [
  "conversation-erasure-item",
  "inbox-message",
  "inbox-message-thread-alias",
  "inbox-message-thread-index",
  "thread-tombstone",
];

describe("thread ownership", () => {
  test("classifies every registered item type", () => {
    expect(Object.keys(THREAD_OWNERSHIP).sort()).toEqual(Object.keys(RECORD_SCHEMAS).sort());
  });

  test("owns every item type that names a thread unless it is listed as not owned", () => {
    const tenantTypes = Object.values(RECORD_TYPES_BY_TABLE).flat() as ItemType[];
    const unowned = tenantTypes
      .filter((itemType) => recordDataFields(RECORD_SCHEMAS[itemType]).includes("threadId"))
      .filter((itemType) => THREAD_OWNERSHIP[itemType].kind !== "owned")
      .sort();

    expect(unowned).toEqual(THREAD_NAMING_TYPES_NOT_OWNED);
  });

  test("attributes semantic events to a thread only on thread and run aggregates", () => {
    const event = (aggregateType: string, aggregateId: string, threadId?: string) =>
      governanceThreadIds(
        makeSemanticEventRecord({
          aggregateId: testId(aggregateId),
          aggregateType,
          aggregateVersion: 1,
          eventId: testId("E1"),
          eventType: `${aggregateType}.updated`,
          organizationId: SCOPE.organizationId,
          payload: threadId ? { threadId } : {},
        }),
      );

    expect(event("thread", "T1")).toEqual([THREAD]);
    expect(event("run", "R1", THREAD)).toEqual([THREAD]);
    expect(event("run", "R1")).toEqual([]);
    expect(event("approval", "A1", THREAD)).toEqual([]);
  });
});

describe("thread inventory", () => {
  test("lists the records the thread owns across partitions and nothing else", async () => {
    const { database, store } = erasureTestDatabase();
    await seedRecords(database, [
      threadRecord(THREAD),
      threadRecord(SIBLING),
      messageRecord(THREAD, testId("M1"), 1),
      messageRecord(SIBLING, testId("M2"), 1),
      runRecord(THREAD, testId("R1")),
      toolCallRecord(THREAD, testId("R1"), testId("C1")),
      toolCallRecord(SIBLING, testId("R2"), testId("C2")),
    ]);

    const page = await store.listThreadRecords(SCOPE.organizationId, THREAD);
    const rest = page.cursor
      ? await store.listThreadRecords(SCOPE.organizationId, THREAD, page.cursor)
      : { items: [] };
    const owned = [...page.items, ...rest.items];

    expect(owned.map((item) => item.record.itemType).sort()).toEqual([
      "message",
      "run",
      "run-locator",
      "thread",
      "tool-call",
    ]);
  });

  test("never lists another organization's records", async () => {
    const { database, store } = erasureTestDatabase();
    await seedRecords(database, [threadRecord(THREAD)]);

    const page = await store.listThreadRecords(testId("Z9"), THREAD);

    expect(page.items).toEqual([]);
  });
});

describe("transaction capacity", () => {
  test("reserves one condition per named thread", () => {
    expect(stableTenantMutationCapacity(0)).toBe(49);
    expect(stableTenantMutationCapacity(1)).toBe(49);
    expect(stableTenantMutationCapacity(2)).toBe(48);
  });

  test("a full batch for one thread fits only at the computed capacity", async () => {
    const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const batch = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        kind: "put" as const,
        record: messageRecord(
          THREAD,
          testId(`${crockford[index >> 5]}${crockford[index & 31]}`),
          index,
        ),
      }));

    expect(
      await prepareDynamoTransactionOperations(batch(stableTenantMutationCapacity(1))),
    ).toHaveLength(100);
    expect(prepareDynamoTransactionOperations(batch(50))).rejects.toMatchObject({
      cause: "DynamoDB transactions support at most 100 operations after invariant checks.",
    });
  });

  test("counts the items a batch sends with its companions, past the limit too", () => {
    const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const batch = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        kind: "put" as const,
        record: messageRecord(
          THREAD,
          testId(`${crockford[index >> 5]}${crockford[index & 31]}`),
          index,
        ),
      }));

    expect(transactionItemCount(batch(1))).toBe(4);
    expect(transactionItemCount(batch(49))).toBe(100);
    expect(transactionItemCount(batch(50))).toBe(102);
  });

  test("an erasure request of a thread commits", async () => {
    const { database, store } = erasureTestDatabase();
    await seedRecords(database, [threadRecord(THREAD)]);

    expect(
      (await store.requestThreadErasure({ requester: REQUESTER, scope: SCOPE, threadId: THREAD }))
        .kind,
    ).toBe("created");
  });
});
