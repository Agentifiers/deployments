import { describe, expect, test } from "bun:test";
import {
  ArtifactRecord,
  EndUserKey,
  customerArtifactStorageKey,
  makeIngressInputArtifactPersistence,
  ThreadErasedError,
  withCanonicalRecordKeys,
  type ArtifactInputFile,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import {
  CREATED_AT,
  DEPLOYMENT_ID,
  ENVIRONMENT_ID,
  ORGANIZATION_ID,
  PROJECT_ID,
  RELEASE_ID,
  REQUESTER,
  SCOPE,
  messageRecord,
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
const SHA256 = "a".repeat(64);

function mediaStorage(artifactId: Ulid, fileName: string) {
  return {
    bucket: BUCKET,
    byteSize: 16,
    contentType: "image/png",
    fileName,
    key: customerArtifactStorageKey(SCOPE, artifactId, SHA256, fileName),
    sha256: SHA256,
  };
}

interface IngressFile {
  readonly input: ArtifactInputFile;
  readonly name: string;
}

const WHITEBOARD: IngressFile = {
  input: { kind: "image", mediaType: "image/png" },
  name: "whiteboard.png",
};

const QUARTERLY_REPORT: IngressFile = {
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
  name: "q3.pdf",
};

function capturePrefix(artifactId: Ulid) {
  return `artifacts/organizations/${ORGANIZATION_ID}/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/customer/${artifactId}/${SHA256}`;
}

async function captureIngress(
  database: DynamoDatabaseService,
  threadId: Ulid,
  artifactId: Ulid,
  file: IngressFile = WHITEBOARD,
) {
  const persistence = makeIngressInputArtifactPersistence(database);
  const now = new Date("2026-10-07T12:00:00.000Z");
  const pending = await persistence.createPending({
    artifactId,
    name: file.name,
    now,
    owner: { sourceId: testId("N1"), sourceKind: "channel-binding", type: "ingress" },
    scope: SCOPE,
    storage: { bucket: BUCKET, byteSize: 16, sha256: SHA256 },
    threadId,
    uploadExpiresAt: new Date("2026-10-07T12:15:00.000Z"),
  });
  const available = await persistence.markAvailable(pending, {
    input: file.input,
    now,
    retentionExpiresAt: new Date("2027-10-07T12:00:00.000Z"),
    versionId: "v1",
  });
  return available.data.storage.key;
}

function personMedia(threadId: Ulid, artifactId: Ulid) {
  return Schema.decodeUnknownSync(ArtifactRecord)(
    withCanonicalRecordKeys({
      data: {
        ...SCOPE,
        createdAt: CREATED_AT,
        id: artifactId,
        name: "receipt.png",
        owner: { principalId: REQUESTER.id, type: "principal" },
        status: "available",
        storage: { ...mediaStorage(artifactId, "receipt.png"), versionId: "v1" },
        threadId,
        type: "input_image",
        updatedAt: CREATED_AT,
        version: 1,
        visibility: "private",
      },
      itemType: "artifact",
    }),
  ) as PlatformRecord;
}

function runWithMedia(threadId: Ulid, runId: Ulid, userMessageId: Ulid, media: readonly Ulid[]) {
  return withCanonicalRecordKeys({
    data: {
      ...SCOPE,
      agentDeploymentId: DEPLOYMENT_ID,
      agentReleaseId: RELEASE_ID,
      attempt: 0,
      captureMode: "metadata-only",
      createdAt: CREATED_AT,
      executor: "hosted",
      id: runId,
      idempotencyKey: `run:${runId}`,
      initiatingCaller: { principalId: REQUESTER.id, scopes: [], type: "principal" },
      inputArtifacts: media,
      priority: 0,
      redactionPolicyVersion: 1,
      schemaVersion: 1,
      spanId: "0123456789abcdef",
      status: "completed",
      threadId,
      traceId: "0123456789abcdef0123456789abcdef",
      trigger: "api",
      updatedAt: CREATED_AT,
      userMessageId,
      userMessageSequence: 3,
      version: 0,
    },
    itemType: "run",
  }) as PlatformRecord;
}

async function artifactStatus(database: DynamoDatabaseService, artifactId: Ulid) {
  const record = await makeIngressInputArtifactPersistence(database).find(SCOPE, artifactId);
  return record?.data.status;
}

describe("conversation media erasure", () => {
  test("a thread erasure deletes its captured ingress image and its person media with their objects, and the sibling's media survives", async () => {
    const fixture = conversationErasureFixture();
    await seedRecords(fixture.database, [
      ...conversation(ERASED, "1"),
      ...conversation(SIBLING, "2"),
      messageRecord(ERASED, testId("M3"), 3),
      personMedia(ERASED, testId("A2")),
      runWithMedia(ERASED, testId("R3"), testId("M3"), [testId("A1"), testId("A2")]),
    ]);
    const ingressKey = await captureIngress(fixture.database, ERASED, testId("A1"));
    const siblingKey = await captureIngress(fixture.database, SIBLING, testId("A3"));
    const personKey = mediaStorage(testId("A2"), "receipt.png").key;
    const request = await fixture.store.requestThreadErasure({
      requester: REQUESTER,
      scope: SCOPE,
      threadId: ERASED,
    });
    if (request.kind !== "created") throw new Error(`Erasure was not created: ${request.kind}.`);

    const completed = await fixture.runToCompletion(request.operation);

    expect(completed).toMatchObject({ status: "completed", summary: { objectsStaged: 3 } });
    expect(await fixture.threadRecordTypes(ERASED)).toEqual([]);
    expect(await artifactStatus(fixture.database, testId("A1"))).toBeUndefined();
    expect(await artifactStatus(fixture.database, testId("A2"))).toBeUndefined();
    expect(await artifactStatus(fixture.database, testId("A3"))).toBe("available");
    expect(
      (await fixture.threadRecordTypes(SIBLING)).filter((type) => type === "artifact"),
    ).toEqual(["artifact"]);
    expect([...fixture.calls.deletedObjects].sort()).toEqual(
      [ingressKey, personKey, `organizations/${ORGANIZATION_ID}/threads/body-1`].sort(),
    );
    expect(fixture.calls.deletedObjects).not.toContain(siblingKey);
    const lateCapture = await captureIngress(fixture.database, ERASED, testId("A4")).catch(
      (cause: unknown) => cause,
    );
    expect(lateCapture).toBeInstanceOf(ThreadErasedError);
  });

  test("an end-user erasure deletes the media captured in the end user's thread and keeps another end user's", async () => {
    const subject = Schema.decodeUnknownSync(EndUserKey)(`v1.${"s".repeat(43)}`);
    const other = Schema.decodeUnknownSync(EndUserKey)(`v1.${"o".repeat(43)}`);
    const fixture = conversationErasureFixture();
    await seedRecords(fixture.database, [
      threadRecord(ERASED, { endUserKey: subject }),
      threadRecord(SIBLING, { endUserKey: other }),
    ]);
    const subjectKey = await captureIngress(fixture.database, ERASED, testId("A1"));
    const otherKey = await captureIngress(fixture.database, SIBLING, testId("A3"));
    const request = await fixture.store.requestEndUserErasure({
      endUserKey: subject,
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      requester: REQUESTER,
    });

    const completed = await fixture.runToCompletion(request.operation);

    expect(completed).toMatchObject({
      status: "completed",
      summary: { objectsStaged: 1, threadsErased: 1 },
    });
    expect(await artifactStatus(fixture.database, testId("A1"))).toBeUndefined();
    expect(await artifactStatus(fixture.database, testId("A3"))).toBe("available");
    expect(fixture.calls.deletedObjects).toEqual([subjectKey]);
    expect(fixture.calls.deletedObjects).not.toContain(otherKey);
  });

  test("a thread erasure deletes every version of a captured document's @input object and its extracted text, and the sibling's capture survives", async () => {
    const fixture = conversationErasureFixture();
    await seedRecords(fixture.database, [threadRecord(ERASED), threadRecord(SIBLING)]);
    await captureIngress(fixture.database, ERASED, testId("A5"), QUARTERLY_REPORT);
    await captureIngress(fixture.database, SIBLING, testId("A6"), QUARTERLY_REPORT);
    const request = await fixture.store.requestThreadErasure({
      requester: REQUESTER,
      scope: SCOPE,
      threadId: ERASED,
    });
    if (request.kind !== "created") throw new Error(`Erasure was not created: ${request.kind}.`);

    const completed = await fixture.runToCompletion(request.operation);

    expect(completed).toMatchObject({ status: "completed" });
    expect([...fixture.calls.deletedAllVersions].sort()).toEqual([
      `${capturePrefix(testId("A5"))}/@input`,
      `${capturePrefix(testId("A5"))}/text/document-text-v1.txt`,
    ]);
    expect(await artifactStatus(fixture.database, testId("A6"))).toBe("available");
  });

  test("an end-user erasure deletes every version of a document captured in the end user's thread and its extracted text, and keeps another end user's", async () => {
    const subject = Schema.decodeUnknownSync(EndUserKey)(`v1.${"s".repeat(43)}`);
    const other = Schema.decodeUnknownSync(EndUserKey)(`v1.${"o".repeat(43)}`);
    const fixture = conversationErasureFixture();
    await seedRecords(fixture.database, [
      threadRecord(ERASED, { endUserKey: subject }),
      threadRecord(SIBLING, { endUserKey: other }),
    ]);
    await captureIngress(fixture.database, ERASED, testId("A5"), QUARTERLY_REPORT);
    await captureIngress(fixture.database, SIBLING, testId("A6"), QUARTERLY_REPORT);
    const request = await fixture.store.requestEndUserErasure({
      endUserKey: subject,
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      requester: REQUESTER,
    });

    const completed = await fixture.runToCompletion(request.operation);

    expect(completed).toMatchObject({ status: "completed", summary: { threadsErased: 1 } });
    expect([...fixture.calls.deletedAllVersions].sort()).toEqual([
      `${capturePrefix(testId("A5"))}/@input`,
      `${capturePrefix(testId("A5"))}/text/document-text-v1.txt`,
    ]);
    expect(await artifactStatus(fixture.database, testId("A6"))).toBe("available");
  });
});
