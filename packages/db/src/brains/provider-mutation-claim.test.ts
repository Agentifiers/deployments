import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { BrainProviderMutationClaimRecord } from "../records/brain-search.ts";
import { BrainIndexJobRecord } from "../records/brain-runtime.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import {
  claimBrainProviderMutation,
  markBrainProviderMutationUnknown,
  resumeBrainProviderMutation,
} from "./provider-mutation-claim.ts";
import { brainUlid } from "./record-mapping.ts";

const ids = [
  "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  "01ARZ3NDEKTSV4RRFFQ69G5FB0",
  "01ARZ3NDEKTSV4RRFFQ69G5FB1",
] as const;
const [organizationId, brainId, documentId, versionId, sourceId, targetId, jobId] = ids;
const timestamp = "2026-07-30T12:00:00.000Z";

function job(generation = 2) {
  return Schema.decodeUnknownSync(BrainIndexJobRecord)(
    withCanonicalRecordKeys({
      data: {
        attempt: 1,
        brainId: brainUlid(brainId),
        components: [],
        createdAt: timestamp,
        documentId: brainUlid(documentId),
        documentVersionId: brainUlid(versionId),
        embeddingProfileId: brainUlid(sourceId),
        expectedProjectionGeneration: generation,
        id: brainUlid(jobId),
        idempotencyKey: `document:${generation}:index`,
        leaseExpiresAt: "2026-07-30T12:05:00.000Z",
        leaseOwner: "job-worker",
        operation: "index" as const,
        organizationId: brainUlid(organizationId),
        placementGeneration: 1,
        priority: 100,
        provider: "aws-native" as const,
        schemaGeneration: 1,
        sourceId: brainUlid(sourceId),
        status: "running" as const,
        targetId: brainUlid(targetId),
        updatedAt: timestamp,
        version: 1,
      },
      itemType: "brain-index-job" as const,
    }),
  );
}

function database(existing?: typeof BrainProviderMutationClaimRecord.Type): {
  readonly database: DynamoDatabaseService;
  readonly transactions: TransactionOperation[][];
} {
  const transactions: TransactionOperation[][] = [];
  return {
    database: {
      deleteRecord: async () => {},
      getRecord: async () => (existing ? existing : undefined),
      putRecord: async () => {},
      queryRecords: async () => ({ items: [] }),
      transactWrite: async (operations) => {
        transactions.push([...operations]);
        return;
      },
    },
    transactions,
  };
}

describe("Brain provider mutation serialization", () => {
  test("claims a document target behind the running job and projection", async () => {
    const fake = database();
    const result = await claimBrainProviderMutation({
      database: fake.database,
      job: job(),
      leaseExpiresAt: "2026-07-30T12:06:00.000Z",
      leaseOwner: "provider-worker",
      now: timestamp,
    });
    expect(result.outcome).toBe("claimed");
    expect(
      fake.transactions[0]!.filter((operation) => operation.kind === "condition-check").map(
        (operation) => operation.expressionAttributeValues?.[":itemType"],
      ),
    ).toEqual(["brain", "brain-index-job", "brain-document"]);
  });

  test("does not let later work overtake an expired mutation until reconciliation", async () => {
    const first = database();
    const active = (
      await claimBrainProviderMutation({
        database: first.database,
        job: job(1),
        leaseExpiresAt: "2026-07-30T12:01:00.000Z",
        leaseOwner: "provider-worker",
        now: timestamp,
      })
    ).claim;
    const second = database(active);
    const blocked = await claimBrainProviderMutation({
      database: second.database,
      job: job(2),
      leaseExpiresAt: "2026-07-30T12:10:00.000Z",
      leaseOwner: "next-worker",
      now: "2026-07-30T12:02:00.000Z",
    });
    expect(blocked.outcome).toBe("unknown");
    expect(second.transactions).toEqual([]);

    const reconciler = database(active);
    const unknown = await markBrainProviderMutationUnknown({
      claim: active,
      database: reconciler.database,
      now: "2026-07-30T12:02:00.000Z",
    });
    expect(unknown.data.status).toBe("unknown");

    const resumedStore = database(unknown);
    const resumed = await resumeBrainProviderMutation({
      claim: unknown,
      database: resumedStore.database,
      job: job(1),
      leaseExpiresAt: "2026-07-30T12:12:00.000Z",
      leaseOwner: "recovery-worker",
      now: "2026-07-30T12:02:00.000Z",
    });
    expect(resumed.data).toMatchObject({
      leaseOwner: "recovery-worker",
      status: "active",
      version: 2,
    });
  });
});
