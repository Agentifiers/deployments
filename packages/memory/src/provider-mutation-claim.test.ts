import { describe, expect, it } from "bun:test";
import {
  MemoryProviderMutationGateRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { ids } from "./test-fixtures.ts";
import {
  acquireMemoryIndexMutationClaim,
  prepareIndexJobOperations,
  prepareMemoryIndexAdmissionClaim,
  PROVIDER_MUTATION_AMBIGUITY_MS,
} from "./provider-mutation-claim.ts";

const startedAt = new Date("2026-07-28T12:00:00.000Z");
const runningJob = withCanonicalRecordKeys({
  data: {
    attempt: 1,
    createdAt: startedAt.toISOString(),
    environmentId: ids.environment,
    expectedContentHash: "content-hash",
    expectedMemoryVersion: 3,
    id: ids.run,
    idempotencyKey: `${ids.toolCall}:index:3`,
    leaseExpiresAt: "2026-07-28T12:30:00.000Z",
    leaseOwner: "worker-1",
    memoryId: ids.memory,
    operation: "index" as const,
    organizationId: ids.organization,
    projectId: ids.project,
    provider: "aws-native" as const,
    status: "running" as const,
    synchronizationGeneration: 7,
    targetId: ids.toolCall,
    updatedAt: startedAt.toISOString(),
    version: 1,
  },
  itemType: "memory-index-job" as const,
}) as Extract<PlatformRecord, { readonly itemType: "memory-index-job" }>;

function fixture(existing?: PlatformRecord) {
  const gate = Schema.decodeUnknownSync(MemoryProviderMutationGateRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: startedAt.toISOString(),
        drainEpoch: 0,
        organizationId: ids.organization,
        status: "open" as const,
        targetId: ids.toolCall,
        updatedAt: startedAt.toISOString(),
        version: 0,
      },
      itemType: "memory-provider-mutation-gate" as const,
    }),
  );
  const admission = prepareMemoryIndexAdmissionClaim(runningJob, startedAt).claim;
  const values = new Map(
    [gate, admission, runningJob, existing]
      .filter((record): record is PlatformRecord => record !== undefined)
      .map((record) => [`${record.pk}\0${record.sk}`, record]),
  );
  return {
    database: {
      getRecord: async (_table: string, key: { readonly pk: string; readonly sk: string }) => {
        const value = values.get(`${key.pk}\0${key.sk}`);
        return value;
      },
      transactWrite: async (operations: readonly TransactionOperation[]) => {
        for (const operation of operations) {
          if (operation.kind === "put") {
            values.set(`${operation.record.pk}\0${operation.record.sk}`, operation.record);
          }
        }
      },
    } as unknown as DynamoDatabaseService,
  };
}

function ambiguousClaim(ambiguityUntil: string) {
  return withCanonicalRecordKeys({
    data: {
      ambiguityUntil,
      attemptEpoch: 0,
      claimAttemptId: "old-attempt",
      createdAt: startedAt.toISOString(),
      messageGroup: `memory:${ids.memory}`,
      mutationTuple: "old-tuple",
      organizationId: ids.organization,
      status: "ambiguous" as const,
      targetId: ids.toolCall,
      updatedAt: startedAt.toISOString(),
      version: 0,
    },
    itemType: "memory-provider-mutation-claim" as const,
  }) as PlatformRecord;
}

describe("memory index provider mutation claims", () => {
  it("atomically admits target-qualified queued work before provider drain", () => {
    const queuedJob = {
      ...runningJob,
      data: {
        ...runningJob.data,
        leaseExpiresAt: undefined,
        leaseOwner: undefined,
        status: "queued" as const,
        version: 0,
      },
    } as Extract<PlatformRecord, { readonly itemType: "memory-index-job" }>;
    const operations = prepareIndexJobOperations(queuedJob, startedAt, true);

    expect(operations).toHaveLength(2);
    expect(operations).toContainEqual(
      expect.objectContaining({
        kind: "put",
        record: expect.objectContaining({
          data: expect.objectContaining({
            messageGroup: `index-job:${runningJob.data.id}`,
            status: "claimed",
            targetId: ids.toolCall,
          }),
          itemType: "memory-provider-mutation-claim",
        }),
      }),
    );
  });

  it("blocks a newer FIFO mutation inside the ambiguity horizon", async () => {
    const ambiguityUntil = new Date(
      startedAt.getTime() + PROVIDER_MUTATION_AMBIGUITY_MS,
    ).toISOString();
    const { database } = fixture(ambiguousClaim(ambiguityUntil));
    expect(
      acquireMemoryIndexMutationClaim({
        database,
        job: runningJob,
        memoryId: ids.memory,
        mutationTuple: "new-tuple",
        now: new Date("2026-07-28T12:05:00.000Z"),
        organizationId: ids.organization,
        targetId: ids.toolCall,
      }),
    ).rejects.toThrow("ambiguity horizon");
  });

  it("advances the claim only after the old request horizon expires", async () => {
    const ambiguityUntil = new Date(startedAt.getTime() + PROVIDER_MUTATION_AMBIGUITY_MS);
    const { database } = fixture(ambiguousClaim(ambiguityUntil.toISOString()));
    expect(
      acquireMemoryIndexMutationClaim({
        database,
        job: runningJob,
        memoryId: ids.memory,
        mutationTuple: "new-tuple",
        now: ambiguityUntil,
        organizationId: ids.organization,
        targetId: ids.toolCall,
      }),
    ).resolves.toMatchObject({
      data: { attemptEpoch: 1, mutationTuple: "new-tuple", status: "claimed", version: 1 },
    });
  });
});
