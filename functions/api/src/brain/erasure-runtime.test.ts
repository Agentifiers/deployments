import { describe, expect, test } from "bun:test";
import { DeleteObjectsCommand, ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { brainNormalizedTextKey, type Brain, type BrainRepository } from "@deployments-ai/brains";
import {
  brainErasureRecord,
  brainUlid,
  brainPlatformRecord,
  type BrainErasureJob,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TableName,
  type TenantRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import type { GovernanceObjectStore } from "@deployments-ai/governance";
import { processBrainErasure, type BrainErasureRuntimeDependencies } from "./erasure-runtime.ts";
import type { BrainSearchErasureResult } from "./search-erasure.ts";

const ids = "0123456789".split("").map((suffix) => `01ARZ3NDEKTSV4RRFFQ69G5FA${suffix}`);
const [organizationId, brainId, principalId, erasureId] = ids;
const firstEmptyAt = "2026-07-31T00:00:00.000Z";
const now = new Date("2026-07-31T00:10:00.000Z");

const brain: Brain = {
  createdAt: firstEmptyAt,
  createdByPrincipalId: principalId!,
  id: brainId!,
  kind: "company",
  maintenancePolicy: {},
  name: "Company Brain",
  organizationId: organizationId!,
  ownershipGeneration: 0,
  retrievalPolicy: {},
  schemaVersion: 1,
  sensitivity: "internal",
  slug: "company-brain",
  status: "erasing",
  updatedAt: firstEmptyAt,
  updatedByPrincipalId: principalId!,
  version: 1,
};

const brainSearchErased = {
  receipt: {
    brainId: brainUlid(brain.id),
    erasureGeneration: brain.version,
    operationId: brainUlid(erasureId!),
    targets: [],
  },
  status: "complete",
} satisfies BrainSearchErasureResult;

function erasure(contentVerificationCount = 1): BrainErasureJob {
  return brainErasureRecord({
    brainId: brain.id,
    contentQuiescenceStartedAt: firstEmptyAt,
    contentVerificationCount,
    createdAt: firstEmptyAt,
    erasureGeneration: brain.version,
    id: erasureId!,
    nextDueAt: firstEmptyAt,
    organizationId: brain.organizationId,
    phase: "draining",
    priority: 0,
    requestedByPrincipalId: principalId!,
    status: "pending",
    updatedAt: firstEmptyAt,
    version: 0,
  });
}

function fixture(initialJob: BrainErasureJob) {
  let currentBrain: PlatformRecord | undefined = brainPlatformRecord(brain);
  let currentJob = initialJob;
  const tenantRecords = () =>
    [
      ...(currentBrain ? [{ record: currentBrain, table: "control" as const }] : []),
      { record: currentJob, table: "execution" as const },
    ] satisfies TenantRecord[];
  const database = {
    getRecord: (table: TableName, key: { readonly pk: string; readonly sk: string }) =>
      Promise.resolve(
        table === "execution" && key.pk === currentJob.pk && key.sk === currentJob.sk
          ? currentJob
          : currentBrain &&
              table === "control" &&
              key.pk === currentBrain.pk &&
              key.sk === currentBrain.sk
            ? currentBrain
            : undefined,
      ),
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      for (const operation of operations) {
        if (operation.kind !== "put") continue;
        if (operation.record.itemType === "brain-erasure-job") currentJob = operation.record;
      }
    },
  } as unknown as DynamoDatabaseService;
  const listedBrains: string[] = [];
  const governanceStore = {
    deleteTenantRecords: async (records: readonly TenantRecord[]) => {
      if (records.some(({ record }) => record.itemType === "brain")) currentBrain = undefined;
    },
    listBrainRecords: async (_organizationId: string, listedBrainId: string) => {
      listedBrains.push(listedBrainId);
      return { items: tenantRecords() };
    },
  } as unknown as BrainErasureRuntimeDependencies["governanceStore"];
  const repository = {
    get: async () => (currentBrain?.itemType === "brain" ? brain : undefined),
  } as unknown as BrainRepository;
  return { database, governanceStore, job: () => currentJob, listedBrains, repository };
}

const objectStore = {
  delete: async () => undefined,
  deleteAllVersions: async () => undefined,
} as unknown as GovernanceObjectStore;

describe("Brain canonical erasure", () => {
  test("completes only after the second quiescent content scan and provider purge", async () => {
    const state = fixture(erasure());
    let searchPurges = 0;
    const listedBuckets: string[] = [];
    const result = await processBrainErasure(state.job(), {
      bucket: "content",
      database: state.database,
      governanceStore: state.governanceStore,
      legacyBuckets: ["legacy-content"],
      now: () => now,
      objectStore,
      purgeDerivedMemories: async () => ({ targets: [] }),
      purgeSearch: async () => {
        searchPurges += 1;
        return brainSearchErased;
      },
      repository: state.repository,
      s3: {
        send: async (command) => {
          const bucket = (command.input as { readonly Bucket?: string }).Bucket;
          if (bucket) {
            listedBuckets.push(bucket);
          }
          return { IsTruncated: false, Versions: [] };
        },
      },
      workerId: "worker",
    });

    expect(result.outcome).toBe("completed");
    expect(searchPurges).toBe(1);
    expect(listedBuckets).toEqual(["content", "legacy-content"]);
    expect(state.job().data).toMatchObject({
      contentVerificationCount: 2,
      phase: "verifying",
      recordsDeleted: 1,
      status: "completed",
    });
  });

  test("checkpoints the first empty scan without touching providers or canonical data", async () => {
    const state = fixture(erasure(0));
    let purged = false;
    const result = await processBrainErasure(state.job(), {
      bucket: "content",
      database: state.database,
      governanceStore: state.governanceStore,
      now: () => now,
      objectStore,
      purgeDerivedMemories: async () => {
        purged = true;
        return {};
      },
      purgeSearch: async () => {
        purged = true;
        return brainSearchErased;
      },
      repository: state.repository,
      s3: { send: async () => ({ IsTruncated: false, Versions: [] }) },
      workerId: "worker",
    });

    expect(result.outcome).toBe("content-quiescence");
    expect(purged).toBe(false);
    expect(state.job().data).toMatchObject({
      contentVerificationCount: 1,
      phase: "draining",
      status: "pending",
    });
  });

  test("reads only the erased Brain's inventory", async () => {
    const state = fixture(erasure());

    const result = await processBrainErasure(state.job(), {
      bucket: "content",
      database: state.database,
      governanceStore: state.governanceStore,
      now: () => now,
      objectStore,
      purgeDerivedMemories: async () => ({ targets: [] }),
      purgeSearch: async () => brainSearchErased,
      repository: state.repository,
      s3: { send: async () => ({ IsTruncated: false, Versions: [] }) },
      workerId: "worker",
    });

    expect(result.outcome).toBe("completed");
    expect(state.job().data.recordsDeleted).toBe(1);
    expect(state.listedBrains.length).toBeGreaterThan(0);
    expect(new Set(state.listedBrains)).toEqual(new Set([brain.id]));
  });

  test("counts and purges a record listed on two inventory pages once", async () => {
    const state = fixture(erasure());
    const memory = {
      record: {
        data: { brainProvenance: [{ brainId: brain.id }], organizationId: brain.organizationId },
        itemType: "memory",
        pk: "MEMORY#switch-window",
        sk: "MEMORY#switch-window",
      } as unknown as PlatformRecord,
      table: "control" as const,
    };
    const baseList = state.governanceStore.listBrainRecords.bind(state.governanceStore);
    const governanceStore = {
      ...state.governanceStore,
      listBrainRecords: async (
        requestedOrganizationId: string,
        requestedBrainId: string,
        cursor?: string,
      ) => {
        const base = await baseList(requestedOrganizationId, requestedBrainId);
        return cursor
          ? { items: [memory] }
          : { cursor: "legacy-locator-page", items: [memory, ...base.items] };
      },
    } as BrainErasureRuntimeDependencies["governanceStore"];
    const purged: { readonly pk: string; readonly sk: string }[] = [];

    await processBrainErasure(state.job(), {
      bucket: "content",
      database: state.database,
      governanceStore,
      now: () => now,
      objectStore,
      purgeDerivedMemories: async ({ memories }) => {
        purged.push(...memories);
        return { targets: [] };
      },
      purgeSearch: async () => brainSearchErased,
      repository: state.repository,
      s3: { send: async () => ({ IsTruncated: false, Versions: [] }) },
      workerId: "worker",
    });

    expect(purged).toEqual([{ pk: "MEMORY#switch-window", sk: "MEMORY#switch-window" }]);
    expect(state.job().data).toMatchObject({
      recordsDeleted: 2,
      searchReceipt: { derivedMemory: { memoryCount: 1 } },
    });
  });

  test("rejects an oversized derived-Memory set before the first provider purge", async () => {
    const state = fixture(erasure());
    const baseList = state.governanceStore.listBrainRecords.bind(state.governanceStore);
    const governanceStore = {
      ...state.governanceStore,
      listBrainRecords: async (
        requestedOrganizationId: string,
        requestedBrainId: string,
        cursor?: string,
      ) => {
        if (cursor === "base") return baseList(requestedOrganizationId, requestedBrainId);
        const page = Number(cursor ?? "0");
        const count = page < 5 ? 1_000 : 1;
        return {
          cursor: page < 5 ? String(page + 1) : "base",
          items: Array.from({ length: count }, (_, index) => ({
            record: {
              data: {
                brainProvenance: [{ brainId: brain.id }],
                organizationId: brain.organizationId,
              },
              itemType: "memory",
              pk: `MEMORY#${page}#${index}`,
              sk: `MEMORY#${page}#${index}`,
            } as unknown as PlatformRecord,
            table: "control" as const,
          })),
        };
      },
    } as BrainErasureRuntimeDependencies["governanceStore"];
    let purges = 0;

    expect(
      processBrainErasure(state.job(), {
        bucket: "content",
        database: state.database,
        governanceStore,
        now: () => now,
        objectStore,
        purgeDerivedMemories: async () => {
          purges += 1;
          return {};
        },
        purgeSearch: async () => brainSearchErased,
        repository: state.repository,
        s3: { send: async () => ({ IsTruncated: false, Versions: [] }) },
        workerId: "worker",
      }),
    ).rejects.toThrow("derived-memory inventory");
    expect(purges).toBe(0);
  });

  test("sweeps a PDF's extracted text with the rest of the Brain's content", async () => {
    const state = fixture(erasure(0));
    const textKey = brainNormalizedTextKey({
      brainId: brain.id,
      documentVersionId: ids[4]!,
      organizationId: brain.organizationId,
    });
    const otherBrainKey = `organizations/${brain.organizationId}/brains/${ids[5]}/uploads/${ids[6]}`;
    const objects = new Set([
      `organizations/${brain.organizationId}/brains/${brain.id}/uploads/${ids[4]}`,
      textKey,
      otherBrainKey,
    ]);

    const result = await processBrainErasure(state.job(), {
      bucket: "content",
      database: state.database,
      governanceStore: state.governanceStore,
      now: () => now,
      objectStore,
      purgeDerivedMemories: async () => ({ targets: [] }),
      purgeSearch: async () => brainSearchErased,
      repository: state.repository,
      s3: {
        send: async (command) => {
          if (command instanceof DeleteObjectsCommand) {
            for (const object of command.input.Delete?.Objects ?? []) objects.delete(object.Key!);
            return {};
          }
          if (!(command instanceof ListObjectVersionsCommand)) {
            throw new Error("Brain erasure sent an unexpected S3 command.");
          }
          return {
            IsTruncated: false,
            Versions: [...objects]
              .filter((objectKey) => objectKey.startsWith(command.input.Prefix ?? ""))
              .map((objectKey) => ({ Key: objectKey, VersionId: "v1" })),
          };
        },
      },
      workerId: "worker",
    });

    expect(result).toEqual({ deleted: 2, outcome: "content-purged" });
    expect([...objects]).toEqual([otherBrainKey]);
    expect(textKey).toBe(
      `organizations/${brain.organizationId}/brains/${brain.id}/document-versions/${ids[4]}/text/document-text-v1.txt`,
    );
  });
});
