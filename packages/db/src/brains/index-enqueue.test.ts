import { describe, expect, test } from "bun:test";
import type { BrainDocument, BrainDocumentVersion } from "@deployments-ai/brains";
import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { BrainSearchPlacementRecord } from "../records/brain-search.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { brainIndexEnqueueOperations } from "./index-enqueue.ts";
import { brainUlid } from "./record-mapping.ts";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const brainId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const sourceId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const documentId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const versionId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const targetId = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const componentId = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const embeddingProfileId = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
const eventId = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
const timestamp = "2026-07-30T12:00:00.000Z";

const target = {
  components: [{ componentId: brainUlid(componentId), kind: "dense" as const }],
  embeddingProfileId: brainUlid(embeddingProfileId),
  location: { openSearchIndex: "brain-org" },
  providerId: "aws-native" as const,
  schemaGeneration: 1,
  targetId: brainUlid(targetId),
};
const placement = Schema.decodeUnknownSync(BrainSearchPlacementRecord)(
  withCanonicalRecordKeys({
    data: {
      createdAt: timestamp,
      generation: 1,
      organizationId: brainUlid(organizationId),
      phase: "active" as const,
      readTarget: target,
      updatedAt: timestamp,
      version: 2,
      writeTarget: target,
    },
    itemType: "brain-search-placement" as const,
  }),
);

const database: DynamoDatabaseService = {
  deleteRecord: async () => {},
  getRecord: async () => placement,
  putRecord: async () => {},
  queryRecords: async () => ({ items: [] }),
  transactWrite: async () => {},
};

const document: BrainDocument = {
  brainId,
  createdAt: timestamp,
  currentContentVersionId: versionId,
  currentEnvelopeHash: "envelope",
  currentSourceOrder: 1,
  currentVersionId: versionId,
  externalItemIdentity: "decision",
  id: documentId,
  lifecycle: "active",
  organizationId,
  projectionGeneration: 3,
  reviewStatus: "approved",
  sensitivity: "internal",
  sourceId,
  updatedAt: timestamp,
  version: 2,
};
const version: BrainDocumentVersion = {
  brainId,
  contentHash: "sha256:content",
  createdAt: timestamp,
  documentId,
  envelopeHash: "envelope",
  id: versionId,
  kind: "content",
  organizationId,
  originalRenditionId: embeddingProfileId,
  sourceId,
  sourceOrder: 1,
};

describe("Brain index enqueue", () => {
  test("pins current-document work to one placement and target", async () => {
    const operations = await brainIndexEnqueueOperations(database, {
      document,
      eventId,
      rendition: {
        bodyRef: {
          bucket: "content",
          byteSize: 3,
          contentType: "text/plain",
          key: "organizations/org/brains/brain/original",
          sha256: "sha256:content",
          versionId: "s3-version",
        },
        brainId,
        contentHash: "sha256:content",
        coordinateSystem: "utf8-byte",
        createdAt: timestamp,
        documentId,
        documentVersionId: versionId,
        id: embeddingProfileId,
        kind: "original",
        organizationId,
      },
      version,
    });
    const job = operations.find((operation) => operation.kind === "put");
    expect(operations).toHaveLength(2);
    expect(job?.kind === "put" ? job.record : undefined).toMatchObject({
      data: {
        components: [{ componentId, kind: "dense", status: "pending" }],
        documentVersionId: versionId,
        placementGeneration: 1,
        targetId,
      },
      itemType: "brain-index-job",
    });
  });

  test("does not enqueue historical revisions", async () => {
    expect(
      await brainIndexEnqueueOperations(database, {
        document: { ...document, currentVersionId: eventId },
        eventId,
        version,
      }),
    ).toEqual([]);
  });

  test("indexes restored content evidence instead of the body-free restore marker", async () => {
    const restoreVersionId = "01ARZ3NDEKTSV4RRFFQ69G5FB4";
    const operations = await brainIndexEnqueueOperations(database, {
      document: {
        ...document,
        currentSourceOrder: 2,
        currentVersionId: restoreVersionId,
        projectionGeneration: 4,
      },
      eventId,
      indexEvidence: {
        rendition: {
          bodyRef: {
            bucket: "content",
            byteSize: 3,
            contentType: "text/plain",
            key: "organizations/org/brains/brain/original",
            sha256: "sha256:content",
            versionId: "s3-version",
          },
          brainId,
          contentHash: "sha256:content",
          coordinateSystem: "utf8-byte",
          createdAt: timestamp,
          documentId,
          documentVersionId: versionId,
          id: embeddingProfileId,
          kind: "original",
          organizationId,
        },
        version,
      },
      version: {
        brainId,
        createdAt: timestamp,
        documentId,
        envelopeHash: "restore-envelope",
        id: restoreVersionId,
        kind: "restore",
        organizationId,
        restoredContentVersionId: versionId,
        sourceId,
        sourceOrder: 2,
      },
    });
    const job = operations.find((operation) => operation.kind === "put");
    expect(job?.kind === "put" ? job.record : undefined).toMatchObject({
      data: {
        documentVersionId: versionId,
        expectedProjectionGeneration: 4,
        operation: "index",
        renditionId: embeddingProfileId,
      },
    });
  });

  test("dual-writes canonical revisions to an active migration candidate", async () => {
    const candidate = {
      ...target,
      location: {
        openSearchEndpoint: "https://search.example",
        openSearchIndex: "brain-org-v1",
        region: "us-east-2",
      },
      providerId: "aws-native" as const,
      targetId: brainUlid("01ARZ3NDEKTSV4RRFFQ69G5FB4"),
    };
    const migratingPlacement = Schema.decodeUnknownSync(BrainSearchPlacementRecord)(
      withCanonicalRecordKeys({
        ...placement,
        data: {
          ...placement.data,
          candidateTarget: candidate,
          operationId: brainUlid("01ARZ3NDEKTSV4RRFFQ69G5FB5"),
        },
      }),
    );
    const migratingDatabase: DynamoDatabaseService = {
      ...database,
      getRecord: async () => migratingPlacement,
    };

    const operations = await brainIndexEnqueueOperations(migratingDatabase, {
      document,
      eventId,
      rendition: {
        bodyRef: {
          bucket: "content",
          byteSize: 3,
          contentType: "text/plain",
          key: "organizations/org/brains/brain/original",
          sha256: "sha256:content",
          versionId: "s3-version",
        },
        brainId,
        contentHash: "sha256:content",
        coordinateSystem: "utf8-byte",
        createdAt: timestamp,
        documentId,
        documentVersionId: versionId,
        id: embeddingProfileId,
        kind: "original",
        organizationId,
      },
      version,
    });
    const jobs = operations.flatMap((operation) =>
      operation.kind === "put" && operation.record.itemType === "brain-index-job"
        ? [operation.record]
        : [],
    );

    expect(operations).toHaveLength(3);
    expect(jobs.map((job) => job.data.targetId)).toEqual([target.targetId, candidate.targetId]);
    expect(jobs[0]!.data.id).toBe(brainUlid(eventId));
    expect(jobs[1]!.data.id).not.toBe(brainUlid(eventId));
    expect(jobs[1]!.data.idempotencyKey).toEndWith(`:${candidate.targetId}`);
  });
});
