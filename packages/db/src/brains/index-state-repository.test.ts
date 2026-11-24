import { describe, expect, test } from "bun:test";
import type { BrainIndexCanonicalSnapshot } from "@deployments-ai/brains";
import { Schema } from "effect";
import { DatabaseError, type TransactionOperation } from "../client-types.ts";
import { BrainIndexJobRecord } from "../records/brain-runtime.ts";
import { BrainProviderMutationClaimRecord } from "../records/brain-search.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { makeBrainIndexStatePort } from "./index-state-repository.ts";
import { brainUlid } from "./record-mapping.ts";

const ids = [
  "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  "01ARZ3NDEKTSV4RRFFQ69G5FB0",
  "01ARZ3NDEKTSV4RRFFQ69G5FB1",
  "01ARZ3NDEKTSV4RRFFQ69G5FB2",
  "01ARZ3NDEKTSV4RRFFQ69G5FB3",
] as const;
const [
  organizationId,
  brainId,
  sourceId,
  documentId,
  versionId,
  renditionId,
  targetId,
  componentId,
  profileId,
] = ids;
const timestamp = "2026-07-30T12:00:00.000Z";

const job = Schema.decodeUnknownSync(BrainIndexJobRecord)(
  withCanonicalRecordKeys({
    data: {
      attempt: 1,
      brainId: brainUlid(brainId),
      components: [
        { componentId: brainUlid(componentId), kind: "dense" as const, status: "pending" as const },
      ],
      createdAt: timestamp,
      documentId: brainUlid(documentId),
      documentVersionId: brainUlid(versionId),
      embeddingProfileId: brainUlid(profileId),
      expectedContentHash: "sha256:content",
      expectedProjectionGeneration: 3,
      id: brainUlid(renditionId),
      idempotencyKey: "document:3:index",
      leaseExpiresAt: "2026-07-30T12:05:00.000Z",
      leaseOwner: "worker-1",
      operation: "index" as const,
      organizationId: brainUlid(organizationId),
      placementGeneration: 1,
      priority: 100,
      provider: "aws-native" as const,
      renditionId: brainUlid(renditionId),
      schemaGeneration: 1,
      sourceId: brainUlid(sourceId),
      startedAt: timestamp,
      status: "running" as const,
      targetId: brainUlid(targetId),
      updatedAt: timestamp,
      version: 1,
    },
    itemType: "brain-index-job" as const,
  }),
);

const snapshot: BrainIndexCanonicalSnapshot = {
  brain: {
    createdAt: timestamp,
    createdByPrincipalId: renditionId,
    id: brainId,
    kind: "company",
    maintenancePolicy: {},
    name: "Engineering",
    organizationId,
    ownershipGeneration: 0,
    retrievalPolicy: {},
    schemaVersion: 1,
    sensitivity: "internal",
    slug: "engineering",
    status: "active",
    updatedAt: timestamp,
    updatedByPrincipalId: renditionId,
    version: 0,
  },
  document: {
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
  },
  rendition: {
    bodyRef: {
      bucket: "content",
      byteSize: 3,
      contentType: "text/plain",
      key: "key",
      sha256: "sha256:content",
      versionId: "s3-version",
    },
    brainId,
    contentHash: "sha256:content",
    coordinateSystem: "utf8-byte",
    createdAt: timestamp,
    documentId,
    documentVersionId: versionId,
    id: renditionId,
    kind: "original",
    organizationId,
  },
  source: {
    brainId,
    createdAt: timestamp,
    createdByPrincipalId: renditionId,
    id: sourceId,
    kind: "upload",
    name: "Uploads",
    organizationId,
    status: "active",
    updatedAt: timestamp,
    updatedByPrincipalId: renditionId,
    version: 0,
  },
  version: {
    brainId,
    contentHash: "sha256:content",
    createdAt: timestamp,
    documentId,
    envelopeHash: "envelope",
    id: versionId,
    kind: "content",
    mediaType: "text/plain",
    organizationId,
    originalRenditionId: renditionId,
    sourceId,
    sourceOrder: 1,
  },
};

const publication = {
  attemptId: renditionId,
  chunkIds: ["chunk-1"],
  components: [{ kind: "dense" as const, ready: true }],
  contentHash: "sha256:content",
  documentId,
  documentVersionId: versionId,
  projectionGeneration: 3,
  target: { location: {}, providerId: "aws-native" as const, schemaGeneration: 1, targetId },
};

const mutationClaim = Schema.decodeUnknownSync(BrainProviderMutationClaimRecord)(
  withCanonicalRecordKeys({
    data: {
      brainId: brainUlid(brainId),
      createdAt: timestamp,
      documentId: brainUlid(documentId),
      jobId: brainUlid(renditionId),
      leaseExpiresAt: "2026-07-30T12:05:00.000Z",
      leaseOwner: "worker-1",
      mutationPriority: 1,
      organizationId: brainUlid(organizationId),
      projectionGeneration: 3,
      provider: "aws-native" as const,
      schemaGeneration: 1,
      status: "active" as const,
      targetId: brainUlid(targetId),
      updatedAt: timestamp,
      version: 0,
    },
    itemType: "brain-provider-mutation-claim" as const,
  }),
);

describe("Brain index state repository", () => {
  test("publishes ready state and job completion behind canonical fences", async () => {
    const transactions: readonly TransactionOperation[][] = [];
    const mutable = transactions as TransactionOperation[][];
    const state = makeBrainIndexStatePort({
      database: {
        deleteRecord: async () => {},
        getRecord: async () => undefined,
        putRecord: async () => {},
        queryRecords: async () => ({ items: [] }),
        transactWrite: async (operations) => {
          mutable.push([...operations]);
          return;
        },
      },
      job,
      mutationClaim,
      now: () => timestamp,
      snapshot,
    });

    expect(await state.publishReady(publication)).toBe(true);
    expect(
      mutable[0]!
        .filter((operation) => operation.kind === "put")
        .map((operation) => operation.record.itemType),
    ).toEqual(["brain-index-state", "brain-index-job", "brain-provider-mutation-claim"]);
    const committedClaim = mutable[0]!.find(
      (operation) =>
        operation.kind === "put" && operation.record.itemType === "brain-provider-mutation-claim",
    );
    expect(committedClaim).toMatchObject({
      kind: "put",
      record: { data: { status: "committed", version: 1 } },
    });
    expect(
      mutable[0]!
        .filter((operation) => operation.kind === "condition-check")
        .map((operation) => operation.expressionAttributeValues?.[":itemType"]),
    ).toEqual(["brain", "brain-source", "brain-document", "brain-search-placement"]);
  });

  test("reports a lost publication race without exposing provider rows", async () => {
    const state = makeBrainIndexStatePort({
      database: {
        deleteRecord: async () => {},
        getRecord: async () => undefined,
        putRecord: async () => {},
        queryRecords: async () => ({ items: [] }),
        transactWrite: async () =>
          Promise.reject(
            new DatabaseError({
              cause: "race",
              message: "conflict",
              operation: "transact-write",
              reason: "conflict",
              table: "multiple",
            }),
          ),
      },
      job,
      now: () => timestamp,
      snapshot,
    });
    expect(await state.publishReady(publication)).toBe(false);
  });
});
