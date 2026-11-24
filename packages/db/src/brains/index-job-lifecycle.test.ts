import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { TransactionOperation } from "../client-types.ts";
import { BrainIndexJobRecord } from "../records/brain-runtime.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { recoverExpiredBrainIndexJob } from "./index-job-lifecycle.ts";

const ids = [
  "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  "01ARZ3NDEKTSV4RRFFQ69G5FB0",
] as const;
const timestamp = "2026-07-30T12:00:00.000Z";

describe("Brain index job leases", () => {
  test("recovers a crashed running worker only after its durable lease expires", async () => {
    const job = Schema.decodeUnknownSync(BrainIndexJobRecord)(
      withCanonicalRecordKeys({
        data: {
          attempt: 1,
          brainId: ids[1],
          components: [],
          createdAt: timestamp,
          documentId: ids[2],
          documentVersionId: ids[3],
          embeddingProfileId: ids[4],
          expectedProjectionGeneration: 1,
          id: ids[5],
          idempotencyKey: "document:1:index",
          leaseExpiresAt: "2026-07-30T12:01:00.000Z",
          leaseOwner: "crashed-worker",
          operation: "index",
          organizationId: ids[0],
          placementGeneration: 1,
          priority: 100,
          provider: "aws-native",
          schemaGeneration: 1,
          sourceId: ids[4],
          status: "running",
          targetId: ids[5],
          updatedAt: timestamp,
          version: 1,
        },
        itemType: "brain-index-job" as const,
      }),
    );
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
    expect(
      await recoverExpiredBrainIndexJob({
        database,
        job,
        now: "2026-07-30T12:00:30.000Z",
      }),
    ).toBeUndefined();
    const recovered = await recoverExpiredBrainIndexJob({
      database,
      job,
      now: "2026-07-30T12:02:00.000Z",
    });
    expect(recovered?.data).toMatchObject({
      nextDueAt: "2026-07-30T12:02:00.000Z",
      status: "failed",
      version: 2,
    });
    expect(recovered?.data).not.toHaveProperty("leaseOwner");
    expect(transactions).toHaveLength(1);
  });
});
