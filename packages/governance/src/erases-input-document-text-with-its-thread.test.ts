import { describe, expect, test } from "bun:test";
import {
  ArtifactRecord,
  EndUserKey,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import {
  CREATED_AT,
  ENVIRONMENT_ID,
  ORGANIZATION_ID,
  PROJECT_ID,
  REQUESTER,
  SCOPE,
  seedRecords,
  testId,
  threadRecord,
} from "@deployments-ai/db/erasure-testing";
import { Schema } from "effect";
import {
  BUCKET,
  conversation,
  conversationErasureFixture,
} from "./conversation-erasure-test-support.ts";

const ERASED = testId("T1");
const SIBLING = testId("T2");
const SOURCE_SHA256 = "a".repeat(64);

function artifactPrefix(artifactId: Ulid) {
  return `artifacts/organizations/${ORGANIZATION_ID}/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/customer/${artifactId}/${SOURCE_SHA256}`;
}

function uploadedInput(
  threadId: Ulid,
  artifactId: Ulid,
  resolution: Readonly<Record<string, unknown>>,
) {
  return Schema.decodeUnknownSync(ArtifactRecord)(
    withCanonicalRecordKeys({
      data: {
        ...SCOPE,
        createdAt: CREATED_AT,
        id: artifactId,
        ...resolution,
        name: "q3.pdf",
        owner: { principalId: REQUESTER.id, type: "principal" },
        status: "available",
        storage: {
          bucket: BUCKET,
          byteSize: 26,
          contentType: "application/pdf",
          fileName: "q3.pdf",
          key: `${artifactPrefix(artifactId)}/q3.pdf`,
          sha256: SOURCE_SHA256,
          versionId: "source-v1",
        },
        threadId,
        type: "input",
        updatedAt: CREATED_AT,
        version: 1,
        visibility: "private",
      },
      itemType: "artifact",
    }),
  ) as PlatformRecord;
}

function uploadedDocument(threadId: Ulid, artifactId: Ulid) {
  return uploadedInput(threadId, artifactId, {
    input: {
      kind: "document",
      mediaType: "application/pdf",
      summary: "PDF, 1 page",
      text: {
        byteSize: 23,
        extractor: "document-text-v1",
        sha256: "b".repeat(64),
        truncated: false,
        versionId: "text-v1",
      },
    },
  });
}

describe("input document text erasure", () => {
  test("a thread erasure deletes every version of its uploaded document and the document's extracted text, and the sibling's survive", async () => {
    const fixture = conversationErasureFixture();
    await seedRecords(fixture.database, [
      ...conversation(ERASED, "1"),
      ...conversation(SIBLING, "2"),
      uploadedDocument(ERASED, testId("A1")),
      uploadedDocument(SIBLING, testId("A2")),
    ]);
    const request = await fixture.store.requestThreadErasure({
      requester: REQUESTER,
      scope: SCOPE,
      threadId: ERASED,
    });
    if (request.kind !== "created") throw new Error(`Erasure was not created: ${request.kind}.`);

    const completed = await fixture.runToCompletion(request.operation);

    expect(completed).toMatchObject({ status: "completed", summary: { objectsStaged: 2 } });
    expect([...fixture.calls.deletedAllVersions].sort()).toEqual([
      `${artifactPrefix(testId("A1"))}/q3.pdf`,
      `${artifactPrefix(testId("A1"))}/text/document-text-v1.txt`,
      `organizations/${ORGANIZATION_ID}/threads/body-1`,
    ]);
  });

  test("a thread erasure deletes an input upload that completed before resolution existed", async () => {
    const fixture = conversationErasureFixture();
    await seedRecords(fixture.database, [
      ...conversation(ERASED, "1"),
      ...conversation(SIBLING, "2"),
      uploadedInput(ERASED, testId("A1"), {}),
      uploadedDocument(SIBLING, testId("A2")),
    ]);
    const request = await fixture.store.requestThreadErasure({
      requester: REQUESTER,
      scope: SCOPE,
      threadId: ERASED,
    });
    if (request.kind !== "created") throw new Error(`Erasure was not created: ${request.kind}.`);

    const completed = await fixture.runToCompletion(request.operation);

    expect(completed).toMatchObject({ status: "completed", summary: { objectsStaged: 2 } });
    expect([...fixture.calls.deletedAllVersions].sort()).toEqual([
      `${artifactPrefix(testId("A1"))}/q3.pdf`,
      `organizations/${ORGANIZATION_ID}/threads/body-1`,
    ]);
  });

  test("an end-user erasure deletes every version of the document text in the end user's thread and keeps another end user's", async () => {
    const subject = Schema.decodeUnknownSync(EndUserKey)(`v1.${"s".repeat(43)}`);
    const other = Schema.decodeUnknownSync(EndUserKey)(`v1.${"o".repeat(43)}`);
    const fixture = conversationErasureFixture();
    await seedRecords(fixture.database, [
      threadRecord(ERASED, { endUserKey: subject }),
      threadRecord(SIBLING, { endUserKey: other }),
      uploadedDocument(ERASED, testId("A1")),
      uploadedDocument(SIBLING, testId("A2")),
    ]);
    const request = await fixture.store.requestEndUserErasure({
      endUserKey: subject,
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      requester: REQUESTER,
    });

    const completed = await fixture.runToCompletion(request.operation);

    expect(completed).toMatchObject({ status: "completed", summary: { threadsErased: 1 } });
    expect([...fixture.calls.deletedAllVersions].sort()).toEqual([
      `${artifactPrefix(testId("A1"))}/q3.pdf`,
      `${artifactPrefix(testId("A1"))}/text/document-text-v1.txt`,
    ]);
  });
});
