import { describe, expect, test } from "bun:test";
import { makeInboundPersistence } from "../inbound.ts";
import { ThreadErasedError } from "./fences.ts";
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

async function erasedThread() {
  const context = erasureTestDatabase();
  await seedRecords(context.database, [
    threadRecord(THREAD),
    threadRecord(SIBLING),
    messageRecord(THREAD, testId("M1"), 1),
    runRecord(THREAD, testId("R1")),
  ]);
  const result = await context.store.requestThreadErasure({
    requester: REQUESTER,
    scope: SCOPE,
    threadId: THREAD,
  });
  return { ...context, result };
}

describe("thread erasure fence", () => {
  test("starting an erasure removes the thread and returns a pending operation", async () => {
    const { result, database } = await erasedThread();

    expect(result.kind).toBe("created");
    expect(result.kind === "created" && result.operation).toMatchObject({
      conversationErasure: { phase: "mail", target: { kind: "thread", threadId: THREAD } },
      kind: "thread-erasure",
      status: "pending",
    });
    expect(await database.getRecord("execution", threadRecord(THREAD))).toBeUndefined();
  });

  test("a put naming the erased thread fails with ThreadErasedError", async () => {
    const { database } = await erasedThread();

    const write = seedRecords(database, [messageRecord(THREAD, testId("M2"), 2)]);

    expect(write).rejects.toBeInstanceOf(ThreadErasedError);
    expect(write).rejects.toMatchObject({ threadIds: [THREAD] });
  });

  test("a late createThreadIfMissing cannot recreate the erased thread", async () => {
    const { database } = await erasedThread();

    expect(seedRecords(database, [threadRecord(THREAD)])).rejects.toBeInstanceOf(ThreadErasedError);
  });

  test("run-scoped records that name the thread are fenced too", async () => {
    const { database } = await erasedThread();

    expect(
      seedRecords(database, [toolCallRecord(THREAD, testId("R1"), testId("C1"))]),
    ).rejects.toBeInstanceOf(ThreadErasedError);
  });

  test("deletes of the erased thread's records still succeed", async () => {
    const { database } = await erasedThread();
    const message = messageRecord(THREAD, testId("M1"), 1);

    await database.transactWrite([{ kind: "delete", record: message }]);

    expect(await database.getRecord("execution", message)).toBeUndefined();
  });

  test("a sibling thread keeps accepting writes", async () => {
    const { database } = await erasedThread();
    const message = messageRecord(SIBLING, testId("M3"), 1);

    await seedRecords(database, [message]);

    expect(await database.getRecord("execution", message)).toMatchObject({
      data: { threadId: SIBLING },
    });
  });

  test("a replayed request returns the same operation", async () => {
    const { result, store } = await erasedThread();

    const replay = await store.requestThreadErasure({
      requester: REQUESTER,
      scope: SCOPE,
      threadId: THREAD,
    });

    expect(replay).toEqual({
      kind: "replayed",
      operation: result.kind === "created" ? result.operation : undefined!,
    });
  });

  test("a thread with an active run is refused", async () => {
    const { database, store } = erasureTestDatabase();
    await seedRecords(database, [threadRecord(THREAD), runRecord(THREAD, testId("R1"), "running")]);

    const result = await store.requestThreadErasure({
      requester: REQUESTER,
      scope: SCOPE,
      threadId: THREAD,
    });

    expect(result).toEqual({ kind: "thread-active" });
  });

  test("a thread of another environment is not found", async () => {
    const { database, store } = erasureTestDatabase();
    await seedRecords(database, [threadRecord(THREAD)]);

    const result = await store.requestThreadErasure({
      requester: REQUESTER,
      scope: { ...SCOPE, environmentId: testId("E9") },
      threadId: THREAD,
    });

    expect(result).toEqual({ kind: "not-found" });
  });
});

describe("inbound routes of an erased thread", () => {
  test("the next inbound message reserves a new thread for the same route", async () => {
    const { database, store } = erasureTestDatabase();
    const reserved = [THREAD, testId("T9")];
    const inbound = makeInboundPersistence({ database, generateId: async () => reserved.shift()! });
    const route = {
      ...SCOPE,
      agentDeploymentId: testId("D1"),
      channel: "sms",
      createdAt: "2026-10-01T00:00:00.000Z",
      externalChannelId: "+15550100",
      externalThreadKey: "sms:+15550100",
      ingressRouteId: "a".repeat(64),
      provider: "aws_end_user_messaging_rcs",
      sourceId: testId("B1"),
      sourceKind: "channel-binding" as const,
    };
    expect(await inbound.reserveThreadRoute(route)).toBe(THREAD);
    await seedRecords(database, [threadRecord(THREAD)]);
    await store.requestThreadErasure({ requester: REQUESTER, scope: SCOPE, threadId: THREAD });

    expect(await inbound.reserveThreadRoute(route)).toBe(testId("T9"));
    expect(await inbound.reserveThreadRoute(route)).toBe(testId("T9"));
    await seedRecords(database, [threadRecord(testId("T9"))]);
  });
});
