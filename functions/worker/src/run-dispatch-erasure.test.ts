import { describe, expect, test } from "bun:test";
import { withCanonicalRecordKeys, type PlatformRecord, type Ulid } from "@deployments-ai/db";
import {
  REQUESTER,
  SCOPE,
  erasureTestDatabase,
  runRecord,
  seedRecords,
  testId,
  threadRecord,
} from "@deployments-ai/db/erasure-testing";
import { runRequestedEvent } from "./run-mutations.ts";

type RunRecordValue = Extract<PlatformRecord, { readonly itemType: "run" }>;

describe("run dispatch erasure", () => {
  test("a thread erasure reaches the dispatch event that carries the caller's idempotency key", async () => {
    const { database, store } = erasureTestDatabase();
    const threadId = testId("T1");
    const seeded = runRecord(threadId, testId("R1")) as RunRecordValue;
    const run = withCanonicalRecordKeys({
      data: {
        ...seeded.data,
        idempotencyKey: "reorder-for-jane@example.com",
        userMessageId: testId("M1"),
        userMessageSequence: 1,
      },
      itemType: "run" as const,
    }) as RunRecordValue;
    const dispatch = runRequestedEvent(
      run,
      testId("D1") as Ulid,
      new Date("2026-10-07T11:00:00.000Z"),
    );
    await seedRecords(database, [threadRecord(threadId), run, dispatch]);

    await store.requestThreadErasure({ requester: REQUESTER, scope: SCOPE, threadId });
    const inventory = await store.listThreadRecords(SCOPE.organizationId, threadId);

    expect(
      inventory.items
        .filter(({ record }) => record.itemType === "semantic-event")
        .map(({ record }) => {
          const data = record.data as Readonly<Record<string, unknown>>;
          const payload = data.payload as Readonly<Record<string, unknown>>;
          return [data.aggregateType, data.eventType, payload.idempotencyKey];
        }),
    ).toEqual([["run-dispatch", "run.requested", "reorder-for-jane@example.com"]]);
  });
});
