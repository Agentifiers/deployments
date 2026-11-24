import { describe, expect, it } from "bun:test";
import {
  MemoryProviderPurgeCheckpointRecord,
  transactionItemCount,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { awsNativeTargetLocation, makeAwsNativeMemoryProvider } from "./aws-native.ts";
import type { OpenSearchTransport } from "./aws-native-contracts.ts";
import {
  droppedIndexOpenSearch,
  scriptedPurgeOpenSearch,
} from "./aws-native-purge-test-transport.ts";
import { makeMemorySearchErasurePurger } from "./erasure.ts";
import {
  completedErasure,
  databaseFixture,
  primaryErasureTarget,
  seedErasurePlacement,
} from "./erasure-test-fixtures.ts";
import { ids } from "./test-fixtures.ts";

const SEEDED_AT = "2026-07-28T12:00:00.000Z";
const COMPACTING = { reason: "target_records_compacting", status: "pending" } as const;

const membershipDigest = async (targetId: Ulid) => ({
  digest: `digest-${targetId}`,
  keyVersion: 1,
});

async function compactingErasure(
  staleJobs: number,
  openSearch: OpenSearchTransport,
  extra: readonly PlatformRecord[] = [],
) {
  const fixture = databaseFixture();
  await seedErasurePlacement({
    fixture,
    membershipDigest,
    targets: [primaryErasureTarget],
    timestamp: SEEDED_AT,
  });
  fixture.apply(
    Array.from({ length: staleJobs }, (_, index) => ({
      kind: "put" as const,
      record: withCanonicalRecordKeys({
        data: {
          createdAt: SEEDED_AT,
          organizationId: ids.organization,
          recordItemType: "memory-index-job" as const,
          recordPk: `RUN#${ids.run}`,
          recordSk: `JOB#${index}`,
          recordTable: "execution" as const,
          targetId: primaryErasureTarget.targetId,
          updatedAt: SEEDED_AT,
          version: 0,
        },
        itemType: "memory-search-target-record" as const,
      }) as PlatformRecord,
    })),
  );
  const gate = fixture
    .records()
    .find((record) => record.itemType === "memory-provider-mutation-gate")!;
  fixture.apply(
    [withCanonicalRecordKeys(gate as never) as unknown as PlatformRecord, ...extra].map(
      (record) => ({
        kind: "put" as const,
        record,
      }),
    ),
  );
  const clock = { now: Date.parse(SEEDED_AT) };
  const transactionItems: number[] = [];
  const database = {
    ...fixture.database,
    transactWriteForErasure: async (operations: readonly TransactionOperation[]) => {
      transactionItems.push(transactionItemCount(operations));
      await fixture.database.transactWriteForErasure!(operations, {
        operationId: ids.toolCall,
        organizationId: ids.organization,
      });
      clock.now += 20_000;
    },
  } as DynamoDatabaseService;
  const now = () => new Date(clock.now);
  const purger = makeMemorySearchErasurePurger({
    database,
    membershipDigest,
    now,
    registry: {
      resolve: async (target) =>
        makeAwsNativeMemoryProvider({
          config: awsNativeTargetLocation(target),
          now,
          openSearch,
          target,
        }),
    },
  });
  const count = (itemType: PlatformRecord["itemType"]) =>
    fixture.records().filter((record) => record.itemType === itemType).length;
  const staleJobsLeft = () =>
    fixture
      .records()
      .filter(
        (record) =>
          record.itemType === "memory-search-target-record" &&
          record.data.recordItemType === "memory-index-job",
      ).length;
  return {
    count,
    purge: () => purger(ids.organization, ids.toolCall),
    staleJobsLeft,
    transactionItems,
  };
}

describe("tenant memory erasure compacts target records before the provider purge", () => {
  it("compacts while OpenSearch is unreachable", async () => {
    const requests: string[] = [];
    const erasure = await compactingErasure(400, {
      request: async ({ method, path }) => {
        requests.push(`${method} ${path}`);
        throw new TypeError("fetch failed");
      },
    });

    expect(await erasure.purge()).toEqual(COMPACTING);
    expect({ requests, staleJobsLeft: erasure.staleJobsLeft() }).toEqual({
      requests: [],
      staleJobsLeft: 221,
    });
  });

  it("resumes a partly compacted erasure of a dropped index with no purge checkpoint", async () => {
    const dropped = droppedIndexOpenSearch("memory-v3");
    const erasure = await compactingErasure(300, dropped.transport);

    expect(await erasure.purge()).toEqual(COMPACTING);
    expect({
      checkpoints: erasure.count("memory-provider-purge-checkpoint"),
      requests: dropped.requests,
      staleJobsLeft: erasure.staleJobsLeft(),
    }).toEqual({ checkpoints: 0, requests: [], staleJobsLeft: 121 });

    expect(completedErasure(await erasure.purge()).targets).toEqual([
      {
        backupErasureEligibleAt: "2026-08-11T13:07:00.000Z",
        componentReceipts: [
          {
            componentId: ids.space,
            generationId: ids.memory2,
            providerReceipt: {
              absenceVerified: true,
              receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
            },
          },
        ],
        providerId: "aws-native",
        targetDigest: `digest-${ids.run}`,
      },
    ]);
    expect({
      directory: erasure.count("memory-search-target-record"),
      requests: dropped.requests,
    }).toEqual({ directory: 0, requests: ["GET /memory-v3"] });
  });

  it("fully purges a live index after compaction removed its target records", async () => {
    const live = scriptedPurgeOpenSearch("memory-v3");
    const staleJobsAtFirstRequest: number[] = [];
    const erasure = await compactingErasure(30, {
      request: async (input) => {
        if (live.requests.length === 0) staleJobsAtFirstRequest.push(erasure.staleJobsLeft());
        return live.transport.request(input);
      },
    });

    expect(await erasure.purge()).toEqual({ reason: "live_purge_running", status: "pending" });
    expect(await erasure.purge()).toEqual({ reason: "live_purge_running", status: "pending" });
    expect(completedErasure(await erasure.purge()).targets).toMatchObject([
      { backupErasureEligibleAt: "2026-08-11T13:01:20.000Z" },
    ]);
    expect({
      requests: live.requests.map(({ method, path }) => `${method} ${path}`),
      staleJobsAtFirstRequest,
    }).toEqual({
      requests: [
        "GET /memory-v3",
        "POST /memory-v3/_delete_by_query?conflicts=proceed&refresh=true&wait_for_completion=false",
        "GET /_tasks/delete-task",
        "DELETE /.tasks/_doc/delete-task",
        "GET /memory-v3",
        "POST /memory-v3/_forcemerge?max_num_segments=1&flush=true&wait_for_completion=false",
        "GET /_tasks/merge-task",
        "DELETE /.tasks/_doc/merge-task",
        "GET /memory-v3/_segments",
        "POST /memory-v3/_flush?force=true&wait_if_ongoing=true",
        "GET /memory-v3/_stats/segments,translog?level=indices",
        "GET /_snapshot/_all",
        "POST /memory-v3/_search",
      ],
      staleJobsAtFirstRequest: [0],
    });
  });

  it("keeps every transaction within DynamoDB's 100 items with real claims and a checkpoint", async () => {
    const claims = Array.from(
      { length: 14 },
      (_, index) =>
        withCanonicalRecordKeys({
          data: {
            attemptEpoch: 0,
            claimAttemptId: `attempt-${index}`,
            createdAt: SEEDED_AT,
            messageGroup: `memory:${index}`,
            mutationTuple: `tuple-${index}`,
            organizationId: ids.organization,
            status: "applied" as const,
            targetId: primaryErasureTarget.targetId,
            updatedAt: SEEDED_AT,
            version: 1,
          },
          itemType: "memory-provider-mutation-claim" as const,
        }) as PlatformRecord,
    );
    const checkpoint = Schema.decodeUnknownSync(MemoryProviderPurgeCheckpointRecord)(
      withCanonicalRecordKeys({
        data: {
          backupErasureEligibleAt: "2026-08-11T13:00:00.000Z",
          createdAt: SEEDED_AT,
          operationId: ids.toolCall,
          organizationId: ids.organization,
          providerId: "aws-native",
          providerPurgeStartedAt: SEEDED_AT,
          providerReceipt: {
            absenceVerified: false,
            backupErasureEligibleAt: "2026-08-11T13:00:00.000Z",
            liveStorageVerified: false,
            openSearch: { taskResubmitted: true },
            providerPurgeStartedAt: SEEDED_AT,
            providerPurgeState: { stage: "delete-by-query", taskId: "node:1" },
            snapshotInventoryVerified: false,
          },
          targetId: primaryErasureTarget.targetId,
          updatedAt: SEEDED_AT,
          version: 0,
        },
        itemType: "memory-provider-purge-checkpoint" as const,
      }),
    ) as PlatformRecord;
    const dropped = droppedIndexOpenSearch("memory-v3");
    const erasure = await compactingErasure(0, dropped.transport, [...claims, checkpoint]);

    expect(completedErasure(await erasure.purge()).targets).toHaveLength(1);
    expect({
      checkpoints: erasure.count("memory-provider-purge-checkpoint"),
      claims: erasure.count("memory-provider-mutation-claim"),
      transactionItems: erasure.transactionItems,
    }).toEqual({ checkpoints: 0, claims: 0, transactionItems: [57, 45] });
  });
});
