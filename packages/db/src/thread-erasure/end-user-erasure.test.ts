import { Schema } from "effect";
import { describe, expect, test } from "bun:test";
import { makeDynamoGovernanceStore } from "../governance/dynamo-store.ts";
import { EndUserKey } from "../records/conversation-erasure.ts";
import { EndUserErasureInProgressError } from "./fences.ts";
import {
  ENVIRONMENT_ID,
  ORGANIZATION_ID,
  REQUESTER,
  SCOPE,
  TABLE_NAMES,
  erasureTestDatabase,
  runRecord,
  seedRecords,
  testId,
  threadRecord,
} from "./erasure-test-support.ts";

const SUBJECT = Schema.decodeUnknownSync(EndUserKey)(`v1.${"a".repeat(43)}`);
const OTHER_SUBJECT = Schema.decodeUnknownSync(EndUserKey)(`v1.${"b".repeat(43)}`);

async function subjectWithThreads() {
  const context = erasureTestDatabase();
  await seedRecords(context.database, [
    threadRecord(testId("T1"), { endUserKey: SUBJECT }),
    threadRecord(testId("T2"), { endUserKey: SUBJECT }),
    threadRecord(testId("T3"), { endUserKey: OTHER_SUBJECT }),
    threadRecord(testId("T4")),
  ]);
  const request = await context.store.requestEndUserErasure({
    endUserKey: SUBJECT,
    environmentId: ENVIRONMENT_ID,
    organizationId: ORGANIZATION_ID,
    requester: REQUESTER,
  });
  return { ...context, operation: request.operation, request };
}

describe("end-user erasure persistence", () => {
  test("planning finds exactly the subject's threads", async () => {
    const { operation, store } = await subjectWithThreads();

    expect(await store.planEndUserItems(operation)).toBe(2);
    expect((await store.listItems(operation)).map((item) => item.data.threadId)).toEqual([
      testId("T1"),
      testId("T2"),
    ]);
  });

  test("a new thread for the subject is refused while the erasure runs", async () => {
    const { database } = await subjectWithThreads();

    const refused = await seedRecords(database, [
      threadRecord(testId("T5"), { endUserKey: SUBJECT }),
    ]).catch((cause: unknown) => cause);
    expect(refused).toBeInstanceOf(EndUserErasureInProgressError);
    await seedRecords(database, [threadRecord(testId("T6"), { endUserKey: OTHER_SUBJECT })]);
  });

  test("a replayed request returns the running operation", async () => {
    const { operation, store } = await subjectWithThreads();

    const replay = await store.requestEndUserErasure({
      endUserKey: SUBJECT,
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      requester: REQUESTER,
    });

    expect(replay).toEqual({ kind: "replayed", operation });
  });

  test("fencing waits for active runs and then tombstones the thread", async () => {
    const { database, operation, store } = await subjectWithThreads();
    await seedRecords(database, [runRecord(testId("T1"), testId("R1"), "running")]);
    await store.planEndUserItems(operation);
    const [first] = await store.listItems(operation);

    const blocked = await store.fenceItem(operation, first!);
    expect(blocked.kind === "runs-active" && blocked.runs.map((run) => run.data.id)).toEqual([
      testId("R1"),
    ]);

    const [, second] = await store.listItems(operation);
    const fenced = await store.fenceItem(operation, second!);
    expect(fenced).toMatchObject({ item: { data: { stage: "fenced" } }, kind: "fenced" });
    expect(await store.getThreadTombstone(ORGANIZATION_ID, testId("T2"))).toMatchObject({
      data: { operationId: operation.id, threadId: testId("T2") },
    });
  });

  test("finalizing drops the subject from the receipt and releases the subject", async () => {
    const { database, operation, store } = await subjectWithThreads();
    await store.planEndUserItems(operation);

    const completed = await store.finalize(operation);

    expect(completed).toMatchObject({
      conversationErasure: { target: { kind: "end-user" } },
      status: "completed",
    });
    expect(JSON.stringify(await store.getOperation(ORGANIZATION_ID, operation.id))).not.toContain(
      SUBJECT,
    );
    expect(await store.listItems(operation)).toEqual([]);
    await seedRecords(database, [threadRecord(testId("T7"), { endUserKey: SUBJECT })]);
  });

  test("both conversation erasure kinds appear in the organization's governance history", async () => {
    const { fake, operation, store } = await subjectWithThreads();
    const thread = await store.requestThreadErasure({
      requester: REQUESTER,
      scope: SCOPE,
      threadId: testId("T4"),
    });

    const history = await makeDynamoGovernanceStore(fake.client, TABLE_NAMES).listOperations({
      limit: 50,
      organizationId: ORGANIZATION_ID,
    });

    expect(thread.kind).toBe("created");
    expect(
      history.items
        .map((item) => ({ id: item.id, kind: item.kind, status: item.status }))
        .sort((left, right) => left.kind.localeCompare(right.kind)),
    ).toEqual([
      { id: operation.id, kind: "end-user-erasure", status: "pending" },
      {
        id: thread.kind === "created" ? thread.operation.id : "",
        kind: "thread-erasure",
        status: "pending",
      },
    ]);
  });
});
