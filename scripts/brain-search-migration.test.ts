import { describe, expect, test } from "bun:test";
import {
  BrainSearchPlacementRecord,
  BrainSearchTarget,
  type DynamoDatabaseService,
  type TransactionOperation,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { migrateBrainSearchPlacement } from "./brain-search-migration.ts";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const actorPrincipalId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const timestamp = "2026-10-03T12:00:00.000Z";

function target(targetId: string, openSearchEndpoint: string): BrainSearchTarget {
  return Schema.decodeUnknownSync(BrainSearchTarget)({
    components: (["dense", "entity", "exact", "lexical"] as const).map((kind, index) => ({
      componentId: `01ARZ3NDEKTSV4RRFFQ69G5FB${index}`,
      kind,
    })),
    embeddingProfileId: "01ARZ3NDEKTSV4RRFFQ69G5FC0",
    location: {
      openSearchEndpoint,
      openSearchIndex: "brain-org-v1",
      region: "us-east-2",
    },
    providerId: "aws-native",
    schemaGeneration: 1,
    targetId,
  });
}

const oldTarget = target("01ARZ3NDEKTSV4RRFFQ69G5FD0", "https://vpc-brain.example");
const newTarget = target("01ARZ3NDEKTSV4RRFFQ69G5FD1", "https://vpc-search.example");

function placement(extra: Record<string, unknown> = {}) {
  return Schema.decodeUnknownSync(BrainSearchPlacementRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        generation: 1,
        organizationId,
        phase: "active" as const,
        readTarget: oldTarget,
        updatedAt: timestamp,
        version: 1,
        writeTarget: oldTarget,
        ...extra,
      },
      itemType: "brain-search-placement" as const,
    }),
  );
}

function harness(initial: typeof BrainSearchPlacementRecord.Type) {
  let current = initial;
  const eventTypes: string[] = [];
  const prepared: string[] = [];
  let nextId = 0;
  const database = {
    deleteRecord: async () => {},
    getRecord: async () => current,
    putRecord: async () => {},
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      for (const operation of operations) {
        if (operation.kind !== "put") continue;
        if (operation.record.itemType === "brain-search-placement") current = operation.record;
        if (operation.record.itemType === "semantic-event") {
          eventTypes.push(operation.record.data.eventType);
        }
      }
    },
  } as unknown as DynamoDatabaseService;
  const run = (desired: BrainSearchTarget) =>
    migrateBrainSearchPlacement({
      actorPrincipalId,
      database,
      generateId: async () => `01ARZ3NDEKTSV4RRFFQ69G5FE${nextId++}`,
      now: () => timestamp,
      organizationId,
      prepare: async (candidate) => {
        prepared.push(candidate.targetId);
      },
      target: desired,
    });
  return { current: () => current, eventTypes, prepared, run };
}

describe("Brain search placement migration", () => {
  test("moves reads and writes to a target on another domain after preparing it", async () => {
    const migration = harness(placement());
    const result = await migration.run(newTarget);
    expect(result).toMatchObject({ outcome: "migrated", target: { targetId: newTarget.targetId } });
    expect(migration.prepared).toEqual([newTarget.targetId]);
    expect(migration.current().data).toMatchObject({
      readTarget: { targetId: newTarget.targetId },
      writeTarget: { targetId: newTarget.targetId },
    });
    expect(migration.current().data).not.toHaveProperty("candidateTarget");
    expect(migration.eventTypes).toEqual([
      "brain-search-placement.migration-requested",
      "brain-search-placement.migrated",
    ]);
  });

  test("leaves a placement already on the requested location unchanged", async () => {
    const migration = harness(placement());
    const sameDomain = target(newTarget.targetId, "https://vpc-brain.example/");
    const result = await migration.run(sameDomain);
    expect(result).toMatchObject({
      outcome: "unchanged",
      target: { targetId: oldTarget.targetId },
    });
    expect(migration.eventTypes).toEqual([]);
    expect(migration.prepared).toEqual([]);
  });

  test("resumes an interrupted migration with its recorded candidate and operation", async () => {
    const operationId = "01ARZ3NDEKTSV4RRFFQ69G5FF0";
    const migration = harness(
      placement({ candidateTarget: newTarget, generation: 2, operationId, version: 2 }),
    );
    const result = await migration.run(
      target("01ARZ3NDEKTSV4RRFFQ69G5FD2", "https://vpc-search.example"),
    );
    expect(result).toMatchObject({ outcome: "migrated", target: { targetId: newTarget.targetId } });
    expect(migration.prepared).toEqual([newTarget.targetId]);
    expect(migration.eventTypes).toEqual(["brain-search-placement.migrated"]);
  });

  test("refuses to replace a migration in flight to another location", async () => {
    const migration = harness(
      placement({
        candidateTarget: newTarget,
        generation: 2,
        operationId: "01ARZ3NDEKTSV4RRFFQ69G5FF0",
        version: 2,
      }),
    );
    expect(
      migration.run(target("01ARZ3NDEKTSV4RRFFQ69G5FD2", "https://vpc-other.example")),
    ).rejects.toThrow("different location");
    expect(migration.eventTypes).toEqual([]);
  });
});
