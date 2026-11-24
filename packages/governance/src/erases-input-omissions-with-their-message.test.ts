import { describe, expect, test } from "bun:test";
import { MessageRecord, withCanonicalRecordKeys, type Ulid } from "@deployments-ai/db";
import {
  CREATED_AT,
  REQUESTER,
  SCOPE,
  seedRecords,
  testId,
} from "@deployments-ai/db/erasure-testing";
import { Schema } from "effect";
import { conversation, conversationErasureFixture } from "./conversation-erasure-test-support.ts";

const ERASED = testId("T1");
const SIBLING = testId("T2");

function messageNamingSkippedFiles(threadId: Ulid, id: Ulid) {
  return Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: {
        ...SCOPE,
        body: "Here are this quarter's files.",
        contentHash: "sha256:files",
        createdAt: CREATED_AT,
        id,
        inputOmissions: [{ name: "salary-review.xlsx", reason: "over_turn_cap" }],
        role: "user",
        sequence: 3,
        threadId,
        unlistedInputOmissions: 2,
      },
      itemType: "message",
    }),
  );
}

describe("input omission erasure", () => {
  test("a thread erasure deletes the user message that names the files left out of its turn, and the sibling's message keeps its names", async () => {
    const fixture = conversationErasureFixture();
    await seedRecords(fixture.database, [
      ...conversation(ERASED, "1"),
      ...conversation(SIBLING, "2"),
      messageNamingSkippedFiles(ERASED, testId("M5")),
      messageNamingSkippedFiles(SIBLING, testId("M6")),
    ]);
    const request = await fixture.store.requestThreadErasure({
      requester: REQUESTER,
      scope: SCOPE,
      threadId: ERASED,
    });
    if (request.kind !== "created") throw new Error(`Erasure was not created: ${request.kind}.`);

    await fixture.runToCompletion(request.operation);

    const omissions = async (threadId: Ulid) =>
      (await fixture.store.listThreadRecords(SCOPE.organizationId, threadId)).items.flatMap(
        ({ record }) =>
          record.itemType === "message" && record.data.inputOmissions
            ? [
                {
                  inputOmissions: record.data.inputOmissions,
                  unlistedInputOmissions: record.data.unlistedInputOmissions,
                },
              ]
            : [],
      );
    expect(await omissions(ERASED)).toEqual([]);
    expect(await omissions(SIBLING)).toEqual([
      {
        inputOmissions: [{ name: "salary-review.xlsx", reason: "over_turn_cap" }],
        unlistedInputOmissions: 2,
      },
    ]);
  });
});
