import { describe, expect, test } from "bun:test";
import {
  ENVIRONMENT_ID,
  ORGANIZATION_ID,
  REQUESTER,
  SCOPE,
  seedRecords,
  testEndUserKeys,
  testId,
  threadRecord,
} from "@deployments-ai/db/erasure-testing";
import {
  INBOX_ID,
  mailInput,
  mailRepository,
  mailSource,
  seedInbox,
  sourcedMessageRecord,
  type TestMail,
} from "@deployments-ai/db/mail-erasure-testing";
import {
  InboxMailErasedError,
  inboxThreadForThreadKey,
  type GovernanceOperation,
} from "@deployments-ai/db";
import type { FakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { BUCKET, conversationErasureFixture } from "./conversation-erasure-test-support.ts";

const OTHER_INBOX = testId("N2");
const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const SUPPORT = "support@agents.example.com";
const X1 = testId("X1");

function blob(name: string) {
  return {
    bucket: BUCKET,
    byteSize: 5,
    contentType: "text/plain",
    key: `organizations/${SCOPE.organizationId}/agent-email/${name}`,
    sha256: `sha256:${name}`,
  };
}

const INBOUND: TestMail = {
  cc: ["Alice@Example.com"],
  createdAt: "2026-10-07T11:00:00.000Z",
  from: BOB,
  id: testId("E1"),
  inboxThreadId: X1,
  to: [SUPPORT],
};
const REPLY: TestMail = {
  createdAt: "2026-10-07T11:30:00.000Z",
  direction: "outbound",
  from: SUPPORT,
  id: testId("E2"),
  inboxThreadId: X1,
  subject: "Re: Order status",
  to: [BOB],
};
const OTHER_INBOX_MAIL: TestMail = {
  createdAt: "2026-10-07T11:00:00.000Z",
  from: BOB,
  id: testId("E3"),
  inboxId: OTHER_INBOX,
  inboxThreadId: testId("X2"),
  to: ["sales@agents.example.com"],
};
const AFTER_CUTOFF: TestMail = {
  createdAt: "2026-10-07T12:30:00.000Z",
  from: BOB,
  id: testId("E4"),
  inboxThreadId: X1,
  subject: "Order status, again",
  to: [SUPPORT],
};

async function emailBornConversation() {
  const fixture = conversationErasureFixture();
  const { database, fake } = fixture;
  seedInbox(fake);
  seedInbox(fake, OTHER_INBOX, "sales@agents.example.com");
  const mail = mailRepository(database);
  await mail.persistMessage({
    ...mailInput(INBOUND),
    attachments: [
      {
        ...blob("attachments/E1/invoice.pdf"),
        contentType: "application/pdf",
        disposition: "attachment",
        fileName: "invoice.pdf",
        id: testId("A1"),
      },
    ],
    bodyReferences: { rawReference: blob("raw/E1.eml") },
  });
  await mail.persistMessage({
    ...mailInput(REPLY),
    bodyReferences: { textBodyRef: blob("outbound-bodies/E2/text") },
  });
  await mail.persistMessage(mailInput(OTHER_INBOX_MAIL));
  await mail.putDraft({
    bccAddresses: [],
    ccAddresses: [],
    createdAt: "2026-10-07T11:40:00.000Z",
    id: testId("D1"),
    inboxId: INBOX_ID,
    metadata: {},
    organizationId: SCOPE.organizationId,
    replyToMessageId: INBOUND.id,
    status: "draft",
    subject: "Re: Order status",
    textBody: "We are looking into it.",
    toAddresses: [BOB],
    updatedAt: "2026-10-07T11:40:00.000Z",
  });
  await seedRecords(database, [
    threadRecord(testId("T1")),
    sourcedMessageRecord(testId("T1"), testId("M1"), 1, mailSource(INBOUND)),
    threadRecord(testId("T2")),
    sourcedMessageRecord(testId("T2"), testId("M2"), 1, mailSource(INBOUND)),
  ]);
  return { ...fixture, mail };
}

function lastKeyPart(key: unknown) {
  return String(key).split("#").at(-1) ?? "";
}

function mailState({ fake }: { readonly fake: FakeDynamoDocumentClient }) {
  const sorted = (values: readonly string[]) =>
    [...values].sort((left, right) => left.localeCompare(right));
  const ids = (itemType: string) =>
    sorted(
      fake
        .items("execution")
        .filter((item) => item.itemType === itemType)
        .map((item) => lastKeyPart(item.sk)),
    );
  return {
    drafts: ids("inbox-draft"),
    events: sorted(
      fake
        .items("events")
        .filter((item) => String(item.pk).includes("#AGGREGATE#agent_email#"))
        .map((item) => lastKeyPart(item.pk)),
    ),
    messages: ids("inbox-message"),
    tombstones: sorted(
      fake
        .items("execution")
        .filter((item) => item.itemType === "inbox-message-tombstone")
        .map((item) => lastKeyPart(item.pk)),
    ),
  };
}

function counts(operation: GovernanceOperation) {
  const state = operation.conversationErasure!;
  return {
    emailMessagesErased: state.counts.emailMessagesErased,
    emailThreadsErased: state.counts.emailThreadsErased,
    threadsErased: state.counts.threadsErased,
  };
}

describe("conversation mail erasure", () => {
  test("a thread erasure removes its inbox thread's mail up to the cutoff and nothing else", async () => {
    const fixture = await emailBornConversation();
    const { calls, fake, mail, runToCompletion, store } = fixture;
    const requested = await store.requestThreadErasure({
      requester: REQUESTER,
      scope: SCOPE,
      threadId: testId("T1"),
    });
    if (requested.kind !== "created") throw new Error("The thread erasure was not created.");
    await mail.persistMessage(mailInput(AFTER_CUTOFF));

    const completed = await runToCompletion(requested.operation);

    expect(completed.status).toBe("completed");
    expect(counts(completed)).toEqual({
      emailMessagesErased: 2,
      emailThreadsErased: 1,
      threadsErased: 1,
    });
    expect(mailState(fixture)).toEqual({
      drafts: [],
      events: [testId("E3"), testId("E4")],
      messages: [testId("E3"), testId("E4")],
      tombstones: [testId("E1"), testId("E2")],
    });
    expect([...calls.deletedObjects].sort()).toEqual([
      `organizations/${SCOPE.organizationId}/agent-email/attachments/E1/invoice.pdf`,
      `organizations/${SCOPE.organizationId}/agent-email/outbound-bodies/E2/text`,
      `organizations/${SCOPE.organizationId}/agent-email/raw/E1.eml`,
    ]);
    expect(
      fake
        .items("execution")
        .filter((item) => item.itemType === "inbox-thread")
        .map((item) => {
          const data = item.data as Record<string, unknown>;
          return [data.id, data.createdAt, data.messageCount, data.subject];
        }),
    ).toEqual([
      [X1, "2026-10-07T12:30:00.000Z", 1, "Order status, again"],
      [testId("X2"), "2026-10-07T11:00:00.000Z", 1, "Order status"],
    ]);
    expect(
      fake
        .items("execution")
        .filter((item) => item.itemType === "inbox-thread-created-index")
        .map((item) => String(item.sk)),
    ).toEqual([
      `INBOX-THREAD-CREATED-INDEX#2026-10-07T11%3A00%3A00.000Z#${testId("X2")}`,
      `INBOX-THREAD-CREATED-INDEX#2026-10-07T12%3A30%3A00.000Z#${X1}`,
    ]);
  });

  test("a second binding's conversation on the same inbox keeps its own messages", async () => {
    const fixture = await emailBornConversation();
    const requested = await fixture.store.requestThreadErasure({
      requester: REQUESTER,
      scope: SCOPE,
      threadId: testId("T1"),
    });
    if (requested.kind !== "created") throw new Error("The thread erasure was not created.");

    await fixture.runToCompletion(requested.operation);

    expect(await fixture.threadRecordTypes(testId("T1"))).toEqual([]);
    expect(await fixture.threadRecordTypes(testId("T2"))).toEqual([
      "conversation-inbox-thread",
      "inbox-thread-conversation",
      "message",
      "thread",
    ]);
  });

  test("an erased message's redelivery settles without recreating it", async () => {
    const fixture = await emailBornConversation();
    const requested = await fixture.store.requestThreadErasure({
      requester: REQUESTER,
      scope: SCOPE,
      threadId: testId("T1"),
    });
    if (requested.kind !== "created") throw new Error("The thread erasure was not created.");
    await fixture.runToCompletion(requested.operation);

    const redelivered = await fixture.mail
      .persistMessage(mailInput(INBOUND))
      .catch((cause: unknown) => cause);
    const turn = await seedRecords(fixture.database, [
      sourcedMessageRecord(testId("T5"), testId("M5"), 1, mailSource(INBOUND)),
    ]).catch((cause: unknown) => cause);

    expect(redelivered).toBeInstanceOf(InboxMailErasedError);
    expect(turn).toBeInstanceOf(InboxMailErasedError);
    expect(mailState(fixture).messages).toEqual([testId("E3")]);
  });

  test("a late reply to an erased agent-started thread is fenced on that thread", async () => {
    const fixture = conversationErasureFixture();
    const { database, fake, runToCompletion, store } = fixture;
    seedInbox(fake);
    const mail = mailRepository(database);
    const started: TestMail = {
      createdAt: "2026-10-07T11:00:00.000Z",
      direction: "outbound",
      from: SUPPORT,
      id: testId("E7"),
      inboxThreadId: testId("X5"),
      subject: "Your order shipped",
      to: [BOB],
    };
    await mail.persistMessage(mailInput(started));
    const replyThread = () =>
      inboxThreadForThreadKey(database, {
        inboxId: INBOX_ID,
        organizationId: ORGANIZATION_ID,
        threadKey: ` <${testId("E7")}@mail.example.com> `,
      });
    const threadBeforeErasure = await replyThread();
    const requested = await store.requestEndUserErasure({
      endUserKey: testEndUserKeys(ORGANIZATION_ID, "channel:email:-:bob%40example.com"),
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      requester: REQUESTER,
    });
    await runToCompletion(requested.operation);
    const threadAfterErasure = await replyThread();
    const inboxThreadId =
      threadAfterErasure.kind === "absent" ? testId("X9") : threadAfterErasure.inboxThreadId;

    const late = await mail
      .persistMessage(
        mailInput({
          createdAt: "2026-10-07T11:45:00.000Z",
          from: BOB,
          id: testId("E8"),
          inboxThreadId,
          to: [SUPPORT],
        }),
      )
      .catch((cause: unknown) => cause);
    await mail.persistMessage(
      mailInput({
        createdAt: "2026-10-07T12:30:00.000Z",
        from: BOB,
        id: testId("E9"),
        inboxThreadId,
        to: [SUPPORT],
      }),
    );

    expect(threadBeforeErasure).toEqual({ inboxThreadId: testId("X5"), kind: "live" });
    expect(threadAfterErasure).toEqual({ inboxThreadId: testId("X5"), kind: "fenced" });
    expect(late).toBeInstanceOf(InboxMailErasedError);
    expect(
      fake
        .items("execution")
        .filter((item) => item.itemType === "inbox-message")
        .map((item) => {
          const data = item.data as Record<string, unknown>;
          return [data.id, data.threadId];
        }),
    ).toEqual([[testId("E9"), testId("X5")]]);
  });

  test("the erasure converges after object deletion fails midway", async () => {
    const fixture = await emailBornConversation();
    const requested = await fixture.store.requestThreadErasure({
      requester: REQUESTER,
      scope: SCOPE,
      threadId: testId("T1"),
    });
    if (requested.kind !== "created") throw new Error("The thread erasure was not created.");
    fixture.failures.deletedObjects = 1;

    const completed = await fixture.runToCompletion(requested.operation);

    expect(counts(completed)).toEqual({
      emailMessagesErased: 2,
      emailThreadsErased: 1,
      threadsErased: 1,
    });
    expect(mailState(fixture)).toEqual({
      drafts: [],
      events: [testId("E3")],
      messages: [testId("E3")],
      tombstones: [testId("E1"), testId("E2")],
    });
    expect(
      fixture.fake.items("control").some((item) => item.itemType === "retention-cleanup"),
    ).toBe(false);
  });

  test("an end-user erasure reaches Cc'd mail, mail without a conversation, and drafts", async () => {
    const fixture = conversationErasureFixture();
    const { database, fake, runToCompletion, store } = fixture;
    seedInbox(fake);
    const mail = mailRepository(database);
    const ccOnly = { ...INBOUND, from: BOB, to: [SUPPORT] };
    const noConversation: TestMail = {
      createdAt: "2026-10-07T11:10:00.000Z",
      from: ALICE,
      id: testId("E5"),
      inboxThreadId: testId("X3"),
      to: [SUPPORT],
    };
    const bobOnly: TestMail = {
      createdAt: "2026-10-07T11:20:00.000Z",
      from: BOB,
      id: testId("E6"),
      inboxThreadId: testId("X4"),
      to: [SUPPORT],
    };
    for (const message of [ccOnly, noConversation, bobOnly]) {
      await mail.persistMessage(mailInput(message));
    }
    await mail.putDraft({
      bccAddresses: [],
      ccAddresses: [],
      createdAt: "2026-10-07T11:40:00.000Z",
      id: testId("D2"),
      inboxId: INBOX_ID,
      metadata: {},
      organizationId: SCOPE.organizationId,
      status: "draft",
      subject: "Following up",
      textBody: "Checking in.",
      toAddresses: ["ALICE@example.com"],
      updatedAt: "2026-10-07T11:40:00.000Z",
    });
    await seedRecords(database, [
      threadRecord(testId("T1")),
      sourcedMessageRecord(testId("T1"), testId("M1"), 1, mailSource(ccOnly)),
    ]);
    const requested = await store.requestEndUserErasure({
      endUserKey: testEndUserKeys(ORGANIZATION_ID, "channel:email:-:alice%40example.com"),
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      requester: REQUESTER,
    });

    const completed = await runToCompletion(requested.operation);

    expect(counts(completed)).toEqual({
      emailMessagesErased: 2,
      emailThreadsErased: 2,
      threadsErased: 1,
    });
    expect(mailState(fixture)).toEqual({
      drafts: [],
      events: [testId("E6")],
      messages: [testId("E6")],
      tombstones: [testId("E1"), testId("E5")],
    });
    expect(await fixture.threadRecordTypes(testId("T1"))).toEqual([]);
    expect(
      fake
        .items("control")
        .filter((item) => item.itemType === "end-user-inbox-mail")
        .map((item) => String(item.sk)),
    ).toEqual([`END-USER-INBOX-MAIL#${INBOX_ID}#message#${testId("E6")}`]);
  });
});
