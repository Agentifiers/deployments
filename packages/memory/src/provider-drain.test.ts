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
import { drainMemorySearchTarget, PROVIDER_MUTATION_DRAIN_MS } from "./provider-drain.ts";

type Gate = Extract<PlatformRecord, { readonly itemType: "memory-provider-mutation-gate" }>;

function indexJob(startedAt: Date, status: "queued" | "running") {
  return withCanonicalRecordKeys({
    data: {
      attempt: status === "running" ? 1 : 0,
      createdAt: startedAt.toISOString(),
      environmentId: ids.environment,
      expectedContentHash: "content-hash",
      expectedMemoryVersion: 3,
      id: ids.run,
      idempotencyKey: `${ids.toolCall}:${ids.memory}:3:index`,
      ...(status === "running"
        ? {
            leaseExpiresAt: new Date(startedAt.getTime() + 30 * 60_000).toISOString(),
            leaseOwner: "worker-1",
          }
        : {}),
      memoryId: ids.memory,
      operation: "index" as const,
      organizationId: ids.organization,
      projectId: ids.project,
      provider: "aws-native" as const,
      status,
      synchronizationGeneration: 7,
      targetId: ids.toolCall,
      updatedAt: startedAt.toISOString(),
      version: status === "running" ? 1 : 0,
    },
    itemType: "memory-index-job" as const,
  }) as PlatformRecord;
}

function indexAdmissionClaim(job: PlatformRecord, startedAt: Date) {
  if (job.itemType !== "memory-index-job") throw new Error("Expected an index job fixture.");
  return withCanonicalRecordKeys({
    data: {
      attemptEpoch: 0,
      claimAttemptId: "attempt-1",
      createdAt: startedAt.toISOString(),
      messageGroup: `index-job:${job.data.id}`,
      mutationTuple: JSON.stringify([job.pk, job.sk, job.data.idempotencyKey]),
      organizationId: ids.organization,
      status: "claimed" as const,
      targetId: ids.toolCall,
      updatedAt: startedAt.toISOString(),
      version: 0,
    },
    itemType: "memory-provider-mutation-claim" as const,
  }) as PlatformRecord;
}

describe("memory provider mutation drain", () => {
  it("closes new claims and preserves the original drain deadline across retries", async () => {
    const startedAt = new Date("2026-07-28T12:00:00.000Z");
    let current = Schema.decodeUnknownSync(MemoryProviderMutationGateRecord)(
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
    ) as Gate;
    const database = {
      getRecord: async () => current,
      queryRecords: async () => ({ items: [] }),
      transactWrite: async (operations: readonly { readonly record?: PlatformRecord }[]) => {
        const record = operations.find((operation) => operation.record)?.record;
        if (record?.itemType === "memory-provider-mutation-gate") current = record;
      },
    } as unknown as DynamoDatabaseService;
    const drain = (now: Date) =>
      drainMemorySearchTarget({
        database,
        now,
        operationId: ids.run,
        organizationId: ids.organization,
        targetId: ids.toolCall,
      });

    expect(await drain(startedAt)).toBe(false);
    const firstUpdatedAt = current.data.updatedAt;
    expect(await drain(new Date(startedAt.getTime() + 60_000))).toBe(false);
    expect(current.data.updatedAt).toBe(firstUpdatedAt);
    expect(await drain(new Date(startedAt.getTime() + PROVIDER_MUTATION_DRAIN_MS))).toBe(true);
    expect(current.itemType).toBe("memory-provider-mutation-gate");
    if (current.itemType === "memory-provider-mutation-gate") {
      expect(current.data.status).toBe("closed");
    }
  });

  it("lets erasure take over another operation and restarts the full drain horizon", async () => {
    const startedAt = new Date("2026-07-28T12:00:00.000Z");
    let current = Schema.decodeUnknownSync(MemoryProviderMutationGateRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: startedAt.toISOString(),
          drainEpoch: 3,
          operationId: ids.memory,
          organizationId: ids.organization,
          status: "draining" as const,
          targetId: ids.toolCall,
          updatedAt: startedAt.toISOString(),
          version: 4,
        },
        itemType: "memory-provider-mutation-gate" as const,
      }),
    ) as Gate;
    const erasureWrites: PlatformRecord[] = [];
    const database = {
      getRecord: async () => current,
      queryRecords: async () => ({ items: [] }),
      transactWriteForErasure: async (
        operations: readonly { readonly record?: PlatformRecord }[],
      ) => {
        const record = operations.find((operation) => operation.record)?.record;
        if (record?.itemType === "memory-provider-mutation-gate") {
          current = record;
          erasureWrites.push(record);
        }
      },
    } as unknown as DynamoDatabaseService;
    const takeoverAt = new Date(startedAt.getTime() + PROVIDER_MUTATION_DRAIN_MS);
    const drain = (now: Date) =>
      drainMemorySearchTarget({
        database,
        erasureOwned: true,
        now,
        operationId: ids.run,
        organizationId: ids.organization,
        targetId: ids.toolCall,
      });

    expect(await drain(takeoverAt)).toBe(false);
    expect(current.data).toMatchObject({
      drainEpoch: 4,
      operationId: ids.run,
      status: "draining",
      updatedAt: takeoverAt.toISOString(),
      version: 5,
    });
    expect(await drain(new Date(takeoverAt.getTime() + PROVIDER_MUTATION_DRAIN_MS - 1))).toBe(
      false,
    );
    expect(erasureWrites).toHaveLength(1);
    expect(await drain(new Date(takeoverAt.getTime() + PROVIDER_MUTATION_DRAIN_MS))).toBe(true);
    expect(current.data.status).toBe("closed");
  });

  it("keeps a drained target open while an admitted index job lease is active", async () => {
    const startedAt = new Date("2026-07-28T12:00:00.000Z");
    let current = Schema.decodeUnknownSync(MemoryProviderMutationGateRecord)(
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
    ) as Gate;
    const job = indexJob(startedAt, "running");
    const claim = indexAdmissionClaim(job, startedAt);
    const database = {
      getRecord: async (table: string) => (table === "execution" ? job : current),
      queryRecords: async () => ({ items: [claim] }),
      transactWrite: async (operations: readonly { readonly record?: PlatformRecord }[]) => {
        const record = operations.find((operation) => operation.record)?.record;
        if (record?.itemType === "memory-provider-mutation-gate") current = record;
      },
    } as unknown as DynamoDatabaseService;

    expect(
      await drainMemorySearchTarget({
        database,
        now: startedAt,
        operationId: ids.memory,
        organizationId: ids.organization,
        targetId: ids.toolCall,
      }),
    ).toBe(false);
    expect(
      await drainMemorySearchTarget({
        database,
        now: new Date(startedAt.getTime() + PROVIDER_MUTATION_DRAIN_MS),
        operationId: ids.memory,
        organizationId: ids.organization,
        targetId: ids.toolCall,
      }),
    ).toBe(false);
    expect(current.data.status).toBe("draining");
  });

  it("terminalizes a lost queued index event before closing the target", async () => {
    const startedAt = new Date("2026-07-28T12:00:00.000Z");
    let current = Schema.decodeUnknownSync(MemoryProviderMutationGateRecord)(
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
    ) as Gate;
    let job = indexJob(startedAt, "queued");
    let claim = indexAdmissionClaim(job, startedAt);
    let claimDeleted = false;
    const database = {
      getRecord: async (table: string) => (table === "execution" ? job : current),
      queryRecords: async () => ({ items: [claim] }),
      transactWrite: async (operations: readonly TransactionOperation[]) => {
        for (const operation of operations) {
          if (operation.kind === "condition-check") continue;
          const record = operation.record;
          if (operation.kind === "delete" && record.itemType === "memory-provider-mutation-claim") {
            claimDeleted = true;
          }
          if (record?.itemType === "memory-provider-mutation-gate") current = record;
          if (record?.itemType === "memory-index-job") job = record;
          if (record?.itemType === "memory-provider-mutation-claim") claim = record;
        }
      },
    } as unknown as DynamoDatabaseService;

    const drain = (now: Date) =>
      drainMemorySearchTarget({
        database,
        now,
        operationId: ids.memory,
        organizationId: ids.organization,
        targetId: ids.toolCall,
      });
    expect(await drain(startedAt)).toBe(false);
    expect(await drain(new Date(startedAt.getTime() + PROVIDER_MUTATION_DRAIN_MS))).toBe(true);
    expect(job.data).toMatchObject({ skipReason: "target-draining", status: "failed" });
    expect(claimDeleted).toBe(true);
    expect(current.data.status).toBe("closed");
  });

  it("terminalizes an expired provider claim before closing the target", async () => {
    const startedAt = new Date("2026-07-28T12:00:00.000Z");
    let current = Schema.decodeUnknownSync(MemoryProviderMutationGateRecord)(
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
    ) as Gate;
    let claim = withCanonicalRecordKeys({
      data: {
        ambiguityUntil: new Date(startedAt.getTime() + 6 * 60_000).toISOString(),
        attemptEpoch: 0,
        claimAttemptId: "attempt-1",
        createdAt: startedAt.toISOString(),
        messageGroup: `provisioning-evidence:${ids.run}`,
        mutationTuple: `${ids.run}:${ids.toolCall}:synthetic-evidence`,
        organizationId: ids.organization,
        status: "claimed" as const,
        targetId: ids.toolCall,
        updatedAt: startedAt.toISOString(),
        version: 0,
      },
      itemType: "memory-provider-mutation-claim" as const,
    }) as PlatformRecord;
    const database = {
      getRecord: async () => current,
      queryRecords: async () => ({ items: [claim] }),
      transactWrite: async (operations: readonly { readonly record?: PlatformRecord }[]) => {
        for (const operation of operations) {
          const record = operation.record;
          if (record?.itemType === "memory-provider-mutation-gate") current = record;
          if (record?.itemType === "memory-provider-mutation-claim") claim = record;
        }
      },
    } as unknown as DynamoDatabaseService;

    expect(
      await drainMemorySearchTarget({
        database,
        now: startedAt,
        operationId: ids.memory,
        organizationId: ids.organization,
        targetId: ids.toolCall,
      }),
    ).toBe(false);
    expect(
      await drainMemorySearchTarget({
        database,
        now: new Date(startedAt.getTime() + PROVIDER_MUTATION_DRAIN_MS),
        operationId: ids.memory,
        organizationId: ids.organization,
        targetId: ids.toolCall,
      }),
    ).toBe(true);
    expect(claim.data).toMatchObject({ status: "failed", version: 1 });
    expect(current.data.status).toBe("closed");
  });
});
