import { describe, expect, test } from "bun:test";
import type { FakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import {
  ENVIRONMENT_ID,
  ORGANIZATION_ID,
  REQUESTER,
  SCOPE,
  erasureTestDatabase,
  seedRecords,
  testEndUserKeys,
  testId,
  threadRecord,
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
import { MAX_REQUEST_INBOX_THREAD_FENCES } from "./requests.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ALICE = testEndUserKeys(ORGANIZATION_ID, "channel:email:-:alice%40example.com");

function nthId(families: readonly [string, string], index: number) {
  return testId(
    `${families[index < CROCKFORD.length ? 0 : 1]}${CROCKFORD[index % CROCKFORD.length]}`,
  );
}

function fencedThreads(fake: FakeDynamoDocumentClient) {
  return fake
    .items("execution")
    .filter((item) => item.itemType === "inbox-thread-erasure-fence")
    .map((item) => {
      const data = item.data as Record<string, unknown>;
      return `${String(data.inboxThreadId)} ${String(data.erasedThrough)}`;
    })
    .sort();
}

describe("conversation mail planning", () => {
  test("the request fences the first linked inbox threads and the mail phase fences the rest", async () => {
    const { database, fake, store } = erasureTestDatabase();
    const conversation = testId("T1");
    const inboxThreads = Array.from({ length: MAX_REQUEST_INBOX_THREAD_FENCES + 1 }, (_, index) =>
      nthId(["X", "Y"], index),
    );
    await seedRecords(database, [
      threadRecord(conversation),
      ...inboxThreads.map((inboxThreadId, index) =>
        sourcedMessageRecord(
          conversation,
          nthId(["M", "N"], index),
          index + 1,
          mailSource({
            createdAt: "2026-10-07T11:00:00.000Z",
            from: "bob@example.com",
            id: nthId(["E", "F"], index),
            inboxThreadId,
            to: ["support@agents.example.com"],
          }),
        ),
      ),
    ]);

    const requested = await store.requestThreadErasure({
      requester: REQUESTER,
      scope: SCOPE,
      threadId: conversation,
    });
    if (requested.kind !== "created") throw new Error("The thread erasure was not created.");
    const fencedAtRequest = fencedThreads(fake).length;
    const [item] = await store.listItems(requested.operation);
    await store.planConversationMail(requested.operation, item!);

    expect(MAX_REQUEST_INBOX_THREAD_FENCES).toBe(40);
    expect(fencedAtRequest).toBe(40);
    expect(fencedThreads(fake)).toEqual(
      inboxThreads.map((inboxThreadId) => `${inboxThreadId} 2026-10-07T12:00:00.000Z`).sort(),
    );
    expect((await store.listMailItems(requested.operation)).length).toBe(41);
  });

  test("end-user planning fences the subject's threads and prunes rows that no longer name it", async () => {
    const { database, fake, store } = erasureTestDatabase();
    seedInbox(fake);
    const mail = mailRepository(database);
    const ccd: TestMail = {
      cc: ["alice@example.com"],
      createdAt: "2026-10-07T11:00:00.000Z",
      from: "bob@example.com",
      id: testId("E1"),
      inboxThreadId: testId("X1"),
      to: ["support@agents.example.com"],
    };
    const bobOnly: TestMail = { ...ccd, cc: [], id: testId("E2"), inboxThreadId: testId("X2") };
    await mail.persistMessage(mailInput(ccd));
    await mail.persistMessage(mailInput(bobOnly));
    const row = (resourceId: string) =>
      withCanonicalRecordKeys({
        data: {
          ...SCOPE,
          createdAt: "2026-10-07T11:00:00.000Z",
          endUserKey: ALICE,
          inboxId: INBOX_ID,
          resourceId,
          resourceType: "message" as const,
        },
        itemType: "end-user-inbox-mail" as const,
      }) as PlatformRecord;
    await seedRecords(database, [row(testId("E2")), row(testId("E9"))]);
    const { operation } = await store.requestEndUserErasure({
      endUserKey: ALICE,
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      requester: REQUESTER,
    });

    await store.planEndUserItems(operation);

    expect(fencedThreads(fake)).toEqual([`${testId("X1")} 2026-10-07T12:00:00.000Z`]);
    expect((await store.listMailItems(operation)).map((item) => item.data.target)).toEqual([
      { inboxThreadId: testId("X1"), kind: "thread" },
    ]);
    expect(
      fake
        .items("control")
        .filter(
          (item) => item.itemType === "end-user-inbox-mail" && item.pk === row(testId("E1")).pk,
        )
        .map((item) => String(item.sk))
        .sort(),
    ).toEqual([
      `END-USER-INBOX-MAIL#${INBOX_ID}#message#${testId("E1")}`,
      `END-USER-INBOX-MAIL#${INBOX_ID}#message#${testId("E9")}`,
    ]);
  });
});
