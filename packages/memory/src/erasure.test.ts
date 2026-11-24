import { describe, expect, it } from "bun:test";
import {
  Ulid,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { makeMemorySearchErasurePurger, pseudonymousMemoryProviderReceipt } from "./erasure.ts";
import {
  completedErasure,
  databaseFixture,
  primaryErasureTarget,
  seedErasurePlacement,
} from "./erasure-test-fixtures.ts";
import { memorySearchMembershipShard } from "./membership.ts";
import type { MemorySearchProviderClient } from "./provider.ts";
import { ids } from "./test-fixtures.ts";

describe("memory provider erasure receipts", () => {
  it("retains absence proof without tenant-qualified provider identifiers", () => {
    const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FA5";
    const proof = pseudonymousMemoryProviderReceipt("keyed-target-digest", {
      absenceVerified: true,
      namespace: `memory-${organizationId}`,
    });

    expect(proof).toMatchObject({ absenceVerified: true, receiptDigest: expect.any(String) });
    expect(JSON.stringify(proof)).not.toContain(organizationId);
    expect(proof).not.toHaveProperty("namespace");
  });

  it("fails closed when the canonical placement is unavailable", async () => {
    const fixture = databaseFixture();
    const purger = makeMemorySearchErasurePurger({
      database: fixture.database,
      membershipDigest: async () => ({ digest: "unused", keyVersion: 1 }),
      registry: { resolve: async () => Promise.reject(new Error("provider must not be called")) },
    });

    expect(purger(ids.organization, ids.toolCall)).rejects.toThrow("placement is unavailable");
  });

  it("reports draining provider mutations as a pending erasure", async () => {
    const fixture = databaseFixture();
    const timestamp = "2026-07-28T12:00:00.000Z";
    const membershipDigest = async () => ({ digest: "keyed-target-digest", keyVersion: 1 });
    await seedErasurePlacement({
      fixture,
      membershipDigest,
      targets: [primaryErasureTarget],
      timestamp,
    });
    fixture.apply(
      fixture.records().flatMap((record) =>
        record.itemType === "memory-provider-mutation-gate"
          ? [
              {
                kind: "put" as const,
                record: { ...record, data: { ...record.data, status: "draining" as const } },
              },
            ]
          : [],
      ),
    );
    const purger = makeMemorySearchErasurePurger({
      database: fixture.database,
      membershipDigest,
      now: () => new Date(timestamp),
      registry: { resolve: async () => Promise.reject(new Error("provider must not be called")) },
    });

    expect(await purger(ids.organization, ids.toolCall)).toEqual({
      reason: "provider_mutations_draining",
      status: "pending",
    });
  });

  it("resumes selected-provider erasure after a running live purge", async () => {
    const fixture = databaseFixture();
    const timestamp = "2026-07-28T12:00:00.000Z";
    const registeredMembership = { digest: "keyed-target-digest-v1", keyVersion: 1 };
    const currentMembership = { digest: "keyed-target-digest-v2", keyVersion: 2 };
    await seedErasurePlacement({
      fixture,
      membershipDigest: async () => registeredMembership,
      targets: [primaryErasureTarget],
      timestamp,
    });
    let purgeCalls = 0;
    let currentTime = new Date(timestamp);
    const purger = makeMemorySearchErasurePurger({
      database: fixture.database,
      membershipDigest: async () => currentMembership,
      membershipDigests: async () => [currentMembership, registeredMembership],
      now: () => currentTime,
      registry: {
        resolve: async (resolvedTarget) =>
          ({
            providerId: "aws-native",
            purgeOrganization: async (input: { readonly providerPurgeStartedAt?: string }) => {
              purgeCalls += 1;
              if (!input.providerPurgeStartedAt) {
                return {
                  deleted: false,
                  receipt: {
                    absenceVerified: false,
                    backupErasureEligibleAt: "2026-07-28T13:00:00.000Z",
                    providerPurgeStartedAt: timestamp,
                  },
                };
              }
              return {
                deleted: true,
                receipt: {
                  absenceVerified: true,
                  backupErasureEligibleAt: "2026-07-28T13:00:00.000Z",
                  namespace: `memory-${ids.organization}`,
                  providerPurgeStartedAt: input.providerPurgeStartedAt,
                },
              };
            },
            target: resolvedTarget,
          }) as unknown as MemorySearchProviderClient,
      },
    });

    expect(await purger(ids.organization, ids.toolCall)).toEqual({
      reason: "live_purge_running",
      status: "pending",
    });
    expect(purgeCalls).toBe(1);
    expect(
      fixture.records().find((record) => record.itemType === "memory-provider-purge-checkpoint"),
    ).toMatchObject({ data: { providerPurgeStartedAt: timestamp } });
    expect(
      fixture.records().filter((record) => record.itemType === "memory-provider-purge-checkpoint"),
    ).toHaveLength(1);
    expect(
      fixture.records().filter((record) => record.itemType === "memory-erasure-target-receipt"),
    ).toHaveLength(0);
    currentTime = new Date("2026-07-28T14:00:00.000Z");
    const first = completedErasure(await purger(ids.organization, ids.toolCall));
    const receiptTransaction = fixture.transactions.at(-1)!;
    const firstReceipt = fixture
      .records()
      .find((record) => record.itemType === "memory-erasure-target-receipt");
    expect(firstReceipt).toMatchObject({
      data: {
        backupErasureEligibleAt: "2026-07-28T13:00:00.000Z",
        keyVersion: 1,
        targetDigest: registeredMembership.digest,
      },
    });
    expect(first.targets.map((target) => target.backupErasureEligibleAt)).toEqual([
      "2026-07-28T13:00:00.000Z",
    ]);
    expect(JSON.stringify(firstReceipt)).not.toContain(ids.organization);
    expect(receiptTransaction.some((operation) => operation.kind === "delete")).toBe(true);
    expect(
      receiptTransaction.some(
        (operation) =>
          operation.kind === "put" && operation.record.itemType === "memory-erasure-target-receipt",
      ),
    ).toBe(true);
    expect(
      fixture
        .records()
        .some((record) => record.itemType === "memory-search-generation-live-target"),
    ).toBe(false);
    expect(
      fixture.records().find((record) => record.itemType === "memory-search-generation-live-shard"),
    ).toMatchObject({ data: { count: 0, mutationWatermark: 2 } });

    const transactionCount = fixture.transactions.length;
    const second = completedErasure(await purger(ids.organization, ids.toolCall));
    expect(second).toEqual(first);
    expect(second.targets.map((target) => target.backupErasureEligibleAt)).toEqual([
      "2026-07-28T13:00:00.000Z",
    ]);
    expect(purgeCalls).toBe(2);
    expect(fixture.transactions).toHaveLength(transactionCount);
    expect(
      fixture.records().filter((record) => record.itemType === "memory-erasure-target-receipt"),
    ).toHaveLength(1);
  });

  it("replaces historical tenant cleanup evidence with a pseudonymous receipt", async () => {
    const fixture = databaseFixture();
    const timestamp = "2026-07-28T12:00:00.000Z";
    const digest = "historical-target-digest";
    fixture.apply([
      {
        kind: "put",
        record: withCanonicalRecordKeys({
          data: {
            createdAt: timestamp,
            generation: 0,
            organizationId: ids.organization,
            phase: "unconfigured" as const,
            updatedAt: timestamp,
            version: 0,
            writeTargets: [],
          },
          itemType: "memory-search-placement" as const,
        }) as PlatformRecord,
      },
      {
        kind: "put",
        record: withCanonicalRecordKeys({
          data: {
            componentKind: "dense" as const,
            createdAt: timestamp,
            embeddingProfileId: ids.agent,
            generationId: ids.memory2,
            id: ids.space,
            location: {
              automatedSnapshotRetentionHours: 336,
              backupSafetyMarginMinutes: 60,
              embeddingDimensions: 3,
              openSearchEndpoint: "https://search.example",
              openSearchIndex: "memory-v3",
              region: "us-east-2",
            },
            providerId: "aws-native" as const,
            schemaGeneration: 1,
            status: "active" as const,
            updatedAt: timestamp,
            version: 0,
          },
          itemType: "memory-search-component" as const,
        }) as PlatformRecord,
      },
      {
        kind: "put",
        record: withCanonicalRecordKeys({
          data: {
            createdAt: timestamp,
            generationId: ids.memory2,
            keyVersion: 1,
            membershipShard: memorySearchMembershipShard(digest),
            providerId: "aws-native" as const,
            targetDigest: digest,
            updatedAt: timestamp,
            version: 0,
          },
          itemType: "memory-search-generation-target" as const,
        }) as PlatformRecord,
      },
      {
        kind: "put",
        record: withCanonicalRecordKeys({
          data: {
            acceptedAt: timestamp,
            componentReceipts: [
              {
                componentId: ids.space,
                providerReceipt: { absenceVerified: true, namespace: "tenant-qualified" },
              },
            ],
            createdAt: timestamp,
            generationId: ids.memory2,
            id: ids.memory,
            keyVersion: 1,
            organizationId: ids.organization,
            targetDigest: digest,
            targetId: ids.run,
            updatedAt: timestamp,
            version: 0,
          },
          itemType: "memory-target-cleanup-receipt" as const,
        }) as PlatformRecord,
      },
    ]);
    const purger = makeMemorySearchErasurePurger({
      database: fixture.database,
      membershipDigest: async () => ({ digest, keyVersion: 1 }),
      now: () => new Date(timestamp),
      registry: { resolve: async () => Promise.reject(new Error("provider must not be called")) },
    });

    expect(await purger(ids.organization, ids.toolCall)).toEqual({
      receipt: { operationId: ids.toolCall, targets: [] },
      status: "complete",
    });
    expect(
      fixture.records().some((record) => record.itemType === "memory-target-cleanup-receipt"),
    ).toBe(false);
    const replacement = fixture
      .records()
      .find((record) => record.itemType === "memory-erasure-target-receipt");
    expect(replacement).toMatchObject({
      data: { generationId: ids.memory2, keyVersion: 1, targetDigest: digest },
    });
    expect(JSON.stringify(replacement)).not.toContain("tenant-qualified");
  });

  it("compacts historical cleanup evidence one page per attempt", async () => {
    const fixture = databaseFixture();
    const timestamp = "2026-07-28T12:00:00.000Z";
    const digest = "historical-target-digest";
    fixture.apply([
      {
        kind: "put",
        record: withCanonicalRecordKeys({
          data: {
            createdAt: timestamp,
            generation: 0,
            organizationId: ids.organization,
            phase: "unconfigured" as const,
            updatedAt: timestamp,
            version: 0,
            writeTargets: [],
          },
          itemType: "memory-search-placement" as const,
        }) as PlatformRecord,
      },
      {
        kind: "put",
        record: withCanonicalRecordKeys({
          data: {
            createdAt: timestamp,
            generationId: ids.memory2,
            keyVersion: 1,
            membershipShard: memorySearchMembershipShard(digest),
            providerId: "aws-native" as const,
            targetDigest: digest,
            updatedAt: timestamp,
            version: 0,
          },
          itemType: "memory-search-generation-target" as const,
        }) as PlatformRecord,
      },
      ...Array.from({ length: 41 }, (_, index) => ({
        kind: "put" as const,
        record: withCanonicalRecordKeys({
          data: {
            acceptedAt: timestamp,
            componentReceipts: [
              { componentId: ids.space, providerReceipt: { absenceVerified: true } },
            ],
            createdAt: timestamp,
            generationId: ids.memory2,
            id: indexedUlid("01ARZ3NDEKTSV4RRFFQ69G5G", index),
            keyVersion: 1,
            organizationId: ids.organization,
            targetDigest: digest,
            targetId: indexedUlid("01ARZ3NDEKTSV4RRFFQ69G5H", index),
            updatedAt: timestamp,
            version: 0,
          },
          itemType: "memory-target-cleanup-receipt" as const,
        }) as PlatformRecord,
      })),
    ]);
    const purger = makeMemorySearchErasurePurger({
      database: fixture.database,
      membershipDigest: async () => ({ digest, keyVersion: 1 }),
      now: () => new Date(timestamp),
      registry: { resolve: async () => Promise.reject(new Error("provider must not be called")) },
    });
    const count = (itemType: PlatformRecord["itemType"]) =>
      fixture.records().filter((record) => record.itemType === itemType).length;

    expect(await purger(ids.organization, ids.toolCall)).toEqual({
      reason: "cleanup_receipts_compacting",
      status: "pending",
    });
    expect(count("memory-target-cleanup-receipt")).toBe(1);
    expect(count("memory-erasure-target-receipt")).toBe(40);

    expect(await purger(ids.organization, ids.toolCall)).toEqual({
      receipt: { operationId: ids.toolCall, targets: [] },
      status: "complete",
    });
    expect(count("memory-target-cleanup-receipt")).toBe(0);
    expect(count("memory-erasure-target-receipt")).toBe(41);
  });

  it("compacts a large target directory across attempts before completing", async () => {
    const fixture = databaseFixture();
    const timestamp = "2026-07-28T12:00:00.000Z";
    const membershipDigest = async () => ({ digest: "keyed-target-digest", keyVersion: 1 });
    await seedErasurePlacement({
      fixture,
      membershipDigest,
      targets: [primaryErasureTarget],
      timestamp,
    });
    fixture.apply(
      Array.from({ length: 300 }, (_, index) => ({
        kind: "put" as const,
        record: withCanonicalRecordKeys({
          data: {
            createdAt: timestamp,
            organizationId: ids.organization,
            recordItemType: "memory-index-job" as const,
            recordPk: `RUN#${ids.run}`,
            recordSk: `JOB#${index}`,
            recordTable: "execution" as const,
            targetId: primaryErasureTarget.targetId,
            updatedAt: timestamp,
            version: 0,
          },
          itemType: "memory-search-target-record" as const,
        }) as PlatformRecord,
      })),
    );
    let purgeCalls = 0;
    let clock = Date.parse(timestamp);
    const purger = makeMemorySearchErasurePurger({
      database: {
        ...fixture.database,
        transactWriteForErasure: async (operations: readonly TransactionOperation[]) => {
          await fixture.database.transactWriteForErasure!(operations, {
            operationId: ids.toolCall,
            organizationId: ids.organization,
          });
          clock += 20_000;
        },
      } as DynamoDatabaseService,
      membershipDigest,
      now: () => new Date(clock),
      registry: {
        resolve: async (resolvedTarget) =>
          ({
            providerId: "aws-native",
            purgeOrganization: async () => {
              purgeCalls += 1;
              return {
                deleted: true,
                receipt: { absenceVerified: true, namespace: `memory-${ids.organization}` },
              };
            },
            target: resolvedTarget,
          }) as unknown as MemorySearchProviderClient,
      },
    });
    const count = (itemType: PlatformRecord["itemType"]) =>
      fixture.records().filter((record) => record.itemType === itemType).length;

    expect(await purger(ids.organization, ids.toolCall)).toEqual({
      reason: "target_records_compacting",
      status: "pending",
    });
    expect({
      gates: count("memory-provider-mutation-gate"),
      purgeCalls,
      receipts: count("memory-erasure-target-receipt"),
    }).toEqual({ gates: 1, purgeCalls: 0, receipts: 0 });

    expect(completedErasure(await purger(ids.organization, ids.toolCall)).targets).toEqual([
      {
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
        targetDigest: "keyed-target-digest",
      },
    ]);
    expect({
      directory: count("memory-search-target-record"),
      gates: count("memory-provider-mutation-gate"),
      purgeCalls,
      receipts: count("memory-erasure-target-receipt"),
    }).toEqual({ directory: 0, gates: 0, purgeCalls: 1, receipts: 1 });
  });
});

function indexedUlid(prefix: string, index: number) {
  const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return Schema.decodeUnknownSync(Ulid)(
    `${prefix}${crockford[Math.floor(index / 32)]}${crockford[index % 32]}`,
  );
}
