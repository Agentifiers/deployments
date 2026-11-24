import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { TransactionOperation } from "../client-types.ts";
import { BrainProviderMutationClaimRecord } from "../records/brain-search.ts";
import { BrainIndexJobRecord } from "../records/brain-runtime.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { completeBrainIndexSuppression } from "./index-suppression.ts";
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
] as const;
const [organizationId, brainId, sourceId, documentId, versionId, targetId, profileId, jobId] = ids;
const now = "2026-07-30T12:00:00.000Z";

const job = Schema.decodeUnknownSync(BrainIndexJobRecord)(
  withCanonicalRecordKeys({
    data: {
      attempt: 1,
      brainId: brainUlid(brainId),
      components: [{ componentId: brainUlid(profileId), kind: "dense", status: "pending" }],
      createdAt: now,
      documentId: brainUlid(documentId),
      documentVersionId: brainUlid(versionId),
      embeddingProfileId: brainUlid(profileId),
      expectedProjectionGeneration: 4,
      id: brainUlid(jobId),
      idempotencyKey: `${documentId}:4:suppress`,
      leaseExpiresAt: "2026-07-30T12:05:00.000Z",
      leaseOwner: "worker",
      operation: "suppress",
      organizationId: brainUlid(organizationId),
      placementGeneration: 2,
      priority: 0,
      provider: "aws-native",
      schemaGeneration: 1,
      sourceId: brainUlid(sourceId),
      status: "running",
      targetId: brainUlid(targetId),
      updatedAt: now,
      version: 1,
    },
    itemType: "brain-index-job" as const,
  }),
);

const claim = Schema.decodeUnknownSync(BrainProviderMutationClaimRecord)(
  withCanonicalRecordKeys({
    data: {
      brainId: brainUlid(brainId),
      createdAt: now,
      documentId: brainUlid(documentId),
      jobId: brainUlid(jobId),
      leaseExpiresAt: "2026-07-30T12:05:00.000Z",
      leaseOwner: "worker",
      mutationPriority: 2,
      organizationId: brainUlid(organizationId),
      projectionGeneration: 4,
      provider: "aws-native",
      schemaGeneration: 1,
      status: "active",
      targetId: brainUlid(targetId),
      updatedAt: now,
      version: 0,
    },
    itemType: "brain-provider-mutation-claim" as const,
  }),
);

describe("Brain index suppression", () => {
  test("atomically records suppression, completes the job, and commits the mutation fence", async () => {
    const transactions: TransactionOperation[][] = [];
    const database = {
      deleteRecord: async () => {},
      getRecord: async () => undefined,
      putRecord: async () => {},
      queryRecords: async () => ({ items: [] }),
      transactWrite: async (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
        return;
      },
    };
    const state = await completeBrainIndexSuppression({
      claim,
      database,
      document: {
        brainId,
        createdAt: now,
        currentEnvelopeHash: "envelope",
        currentSourceOrder: 4,
        currentVersionId: versionId,
        externalItemIdentity: "item",
        id: documentId,
        lifecycle: "deleted",
        organizationId,
        projectionGeneration: 4,
        reviewStatus: "approved",
        sensitivity: "internal",
        sourceId,
        updatedAt: now,
        version: 3,
      },
      job,
      now,
    });

    expect(state.data.status).toBe("suppressed");
    expect(
      transactions[0]!
        .filter((operation) => operation.kind === "put")
        .map((operation) => [
          operation.record.itemType,
          "status" in operation.record.data ? operation.record.data.status : undefined,
        ]),
    ).toEqual([
      ["brain-index-state", "suppressed"],
      ["brain-index-job", "succeeded"],
      ["brain-provider-mutation-claim", "committed"],
    ]);
  });
});
