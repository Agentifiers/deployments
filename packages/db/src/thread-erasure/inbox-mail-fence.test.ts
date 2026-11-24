import { describe, expect, test } from "bun:test";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import { InboxMailErasedError } from "./fences.ts";
import {
  SCOPE,
  erasureTestDatabase,
  seedRecords,
  testEndUserKeys,
  testId,
} from "./erasure-test-support.ts";
import {
  INBOX_ID,
  mailInput,
  mailRepository,
  mailSource,
  seedInbox,
  sourcedMessageRecord,
  type TestMail,
} from "./mail-test-support.ts";

const CONVERSATION = testId("T1");
const INBOX_THREAD = testId("X1");
const RECEIVED: TestMail = {
  cc: ["Alice@Example.com"],
  createdAt: "2026-10-07T11:00:00.000Z",
  from: "bob@example.com",
  id: testId("E1"),
  inboxThreadId: INBOX_THREAD,
  to: ["support@agents.example.com"],
};

function tombstone(messageId: string) {
  return withCanonicalRecordKeys({
    data: {
      ...SCOPE,
      erasedAt: "2026-10-07T12:00:00.000Z",
      inboxId: INBOX_ID,
      messageId,
      operationId: testId("P1"),
    },
    itemType: "inbox-message-tombstone" as const,
  }) as PlatformRecord;
}

function threadFence(erasedThrough: string) {
  return withCanonicalRecordKeys({
    data: {
      ...SCOPE,
      createdAt: erasedThrough,
      erasedThrough,
      inboxId: INBOX_ID,
      inboxThreadId: INBOX_THREAD,
      operationId: testId("P1"),
      updatedAt: erasedThrough,
      version: 1,
    },
    itemType: "inbox-thread-erasure-fence" as const,
  }) as PlatformRecord;
}

async function mailbox() {
  const context = erasureTestDatabase();
  seedInbox(context.fake);
  return { ...context, repository: mailRepository(context.database) };
}

describe("inbox mail erasure fences", () => {
  test("a stored message keys and indexes every external correspondent but the inbox", async () => {
    const { fake, repository } = await mailbox();

    const stored = await repository.persistMessage(mailInput(RECEIVED));

    expect(stored.data.participantKeys).toEqual(
      [
        testEndUserKeys(SCOPE.organizationId, "channel:email:-:alice%40example.com"),
        testEndUserKeys(SCOPE.organizationId, "channel:email:-:bob%40example.com"),
      ].sort(),
    );
    expect(
      fake
        .items("control")
        .filter((item) => item.itemType === "end-user-inbox-mail")
        .map((item) => String(item.sk))
        .sort(),
    ).toEqual([
      `END-USER-INBOX-MAIL#${INBOX_ID}#message#${RECEIVED.id}`,
      `END-USER-INBOX-MAIL#${INBOX_ID}#message#${RECEIVED.id}`,
    ]);
  });

  test("a redelivered receipt cannot recreate an erased message", async () => {
    const { database, fake, repository } = await mailbox();
    await seedRecords(database, [tombstone(RECEIVED.id)]);

    expect(repository.persistMessage(mailInput(RECEIVED))).rejects.toBeInstanceOf(
      InboxMailErasedError,
    );
    expect(fake.items("execution").some((item) => item.itemType === "inbox-message")).toBe(false);
  });

  test("a write racing past the tombstone read fails on its inbox thread's fence", async () => {
    const { database, repository } = await mailbox();
    const stored = await repository.persistMessage(mailInput(RECEIVED));
    await seedRecords(database, [threadFence("2026-10-07T12:00:00.000Z"), tombstone(RECEIVED.id)]);

    const update = database.transactWrite([
      {
        kind: "put",
        previousRecord: stored,
        record: withCanonicalRecordKeys({
          ...stored,
          data: { ...stored.data, status: "accepted", version: stored.data.version + 1 },
        }) as PlatformRecord,
      },
    ]);

    expect(update).rejects.toBeInstanceOf(InboxMailErasedError);
  });

  test("a conversation message from mail writes both links to its inbox thread", async () => {
    const { fake, database } = await mailbox();

    await seedRecords(database, [
      sourcedMessageRecord(CONVERSATION, testId("M1"), 1, mailSource(RECEIVED)),
    ]);

    expect(
      fake
        .items("execution")
        .filter(
          (item) =>
            item.itemType === "conversation-inbox-thread" ||
            item.itemType === "inbox-thread-conversation",
        )
        .map((item) => `${String(item.pk)} ${String(item.sk)}`)
        .sort(),
    ).toEqual([
      `ORG#${SCOPE.organizationId}#INBOX-THREAD#${INBOX_THREAD} INBOX-THREAD-CONVERSATION#${CONVERSATION}#${testId("M1")}`,
      `ORG#${SCOPE.organizationId}#THREAD#${CONVERSATION} CONVERSATION-INBOX-THREAD#${INBOX_THREAD}#${testId("M1")}`,
    ]);
  });

  test("no conversation message can be created from an erased message", async () => {
    const { fake, database } = await mailbox();
    await seedRecords(database, [tombstone(RECEIVED.id)]);

    const write = seedRecords(database, [
      sourcedMessageRecord(CONVERSATION, testId("M1"), 1, mailSource(RECEIVED)),
    ]);

    expect(write).rejects.toBeInstanceOf(InboxMailErasedError);
    expect(fake.items("execution").some((item) => item.itemType === "message")).toBe(false);
  });

  test("a fenced inbox thread refuses turns from mail up to the cutoff and admits later mail", async () => {
    const { fake, database } = await mailbox();
    await seedRecords(database, [threadFence("2026-10-07T11:00:00.000Z")]);
    const later = { ...RECEIVED, createdAt: "2026-10-07T11:00:00.001Z", id: testId("E2") };

    expect(
      seedRecords(database, [
        sourcedMessageRecord(CONVERSATION, testId("M1"), 1, mailSource(RECEIVED)),
      ]),
    ).rejects.toBeInstanceOf(InboxMailErasedError);
    await seedRecords(database, [
      sourcedMessageRecord(CONVERSATION, testId("M2"), 2, mailSource(later)),
    ]);

    expect(
      fake
        .items("execution")
        .filter((item) => item.itemType === "message")
        .map((item) => String(item.sk).slice(-26)),
    ).toEqual([testId("M2")]);
  });

  test("a fenced inbox thread refuses mail received up to the cutoff even when it arrives late", async () => {
    const { fake, database, repository } = await mailbox();
    await seedRecords(database, [threadFence("2026-10-07T11:00:00.000Z")]);
    const later = { ...RECEIVED, createdAt: "2026-10-07T11:00:00.001Z", id: testId("E2") };

    const refused = await repository
      .persistMessage(mailInput(RECEIVED))
      .catch((cause: unknown) => cause);
    await repository.persistMessage(mailInput(later));

    expect(refused).toBeInstanceOf(InboxMailErasedError);
    expect(
      fake
        .items("execution")
        .filter((item) => item.itemType === "inbox-message")
        .map((item) => String(item.sk)),
    ).toEqual([`INBOX-MESSAGE#${testId("E2")}`]);
  });
});
