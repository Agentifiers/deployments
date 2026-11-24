import { describe, expect, test } from "bun:test";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import type { ConversationErasureMailItem } from "./contracts.ts";
import {
  ENVIRONMENT_ID,
  ORGANIZATION_ID,
  REQUESTER,
  SCOPE,
  erasureTestDatabase,
  seedRecords,
  testEndUserKeys,
  testId,
} from "./erasure-test-support.ts";
import { INBOX_ID, mailInput, mailRepository, seedInbox } from "./mail-test-support.ts";
import { parseUlid } from "./operations.ts";
import { inboxMessageTombstoneKey, inboxThreadErasureFenceKey } from "./record-keys.ts";

const INBOX_THREAD = testId("X1");
const MESSAGE = testId("E1");

describe("inbox thread mail sweep", () => {
  test("a thread's mail is tombstoned only after the operation fenced the thread through its cutoff", async () => {
    const { database, fake, store } = erasureTestDatabase();
    seedInbox(fake);
    await mailRepository(database).persistMessage(
      mailInput({
        createdAt: "2026-10-07T11:00:00.000Z",
        from: "bob@example.com",
        id: MESSAGE,
        inboxThreadId: INBOX_THREAD,
        to: ["support@agents.example.com"],
      }),
    );
    const { operation } = await store.requestEndUserErasure({
      endUserKey: testEndUserKeys(ORGANIZATION_ID, "channel:email:-:bob%40example.com"),
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      requester: REQUESTER,
    });
    const unfencedItem = withCanonicalRecordKeys({
      data: {
        ...SCOPE,
        createdAt: operation.createdAt,
        inboxId: INBOX_ID,
        messagesErased: 0,
        operationId: parseUlid(operation.id),
        pendingCleanupIds: [],
        stage: "planned" as const,
        target: { inboxThreadId: INBOX_THREAD, kind: "thread" as const },
        updatedAt: operation.createdAt,
        version: 1,
      },
      itemType: "conversation-erasure-mail-item" as const,
    }) as ConversationErasureMailItem;
    await seedRecords(database, [unfencedItem as PlatformRecord]);
    const fenceKey = inboxThreadErasureFenceKey(ORGANIZATION_ID, INBOX_THREAD);
    const tombstoneKey = inboxMessageTombstoneKey(ORGANIZATION_ID, MESSAGE);

    const [message, ...rest] = await store.sweepInboxThread(operation, unfencedItem);
    const beforeTombstone = {
      fence: fake.get("execution", fenceKey)?.data,
      tombstone: fake.get("execution", tombstoneKey),
    };
    await store.prepareInboxMessageErasure(operation, message!);

    expect(rest).toEqual([]);
    expect(beforeTombstone).toEqual({
      fence: expect.objectContaining({
        erasedThrough: operation.createdAt,
        inboxThreadId: INBOX_THREAD,
      }),
      tombstone: undefined,
    });
    expect(fake.get("execution", tombstoneKey)).toBeDefined();
  });
});
