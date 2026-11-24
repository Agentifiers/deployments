import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { TransactionOperation } from "../client-types.ts";
import { BrainSearchPlacementRecord, type BrainSearchTarget } from "../records/brain-search.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import {
  activateBrainSearchPlacement,
  beginBrainSearchPlacementMigration,
  completeBrainSearchPlacementMigration,
  ensureBrainSearchPlacement,
} from "./search-placement-repository.ts";
import { brainUlid } from "./record-mapping.ts";

const ids = [
  "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  "01ARZ3NDEKTSV4RRFFQ69G5FB0",
  "01ARZ3NDEKTSV4RRFFQ69G5FB1",
  "01ARZ3NDEKTSV4RRFFQ69G5FB2",
  "01ARZ3NDEKTSV4RRFFQ69G5FB3",
] as const;
const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const principalId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const eventId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const timestamp = "2026-07-30T12:00:00.000Z";
const placement = Schema.decodeUnknownSync(BrainSearchPlacementRecord)(
  withCanonicalRecordKeys({
    data: {
      createdAt: timestamp,
      generation: 0,
      organizationId: brainUlid(organizationId),
      phase: "unconfigured" as const,
      updatedAt: timestamp,
      version: 0,
    },
    itemType: "brain-search-placement" as const,
  }),
);
const target: BrainSearchTarget = {
  components: (["dense", "entity", "exact", "lexical"] as const).map((kind, index) => ({
    componentId: brainUlid(ids[index]!),
    kind,
  })),
  embeddingProfileId: brainUlid(ids[4]!),
  location: { openSearchIndex: "brain-org" },
  providerId: "aws-native",
  schemaGeneration: 1,
  targetId: brainUlid(ids[5]!),
};

describe("Brain search placement repository", () => {
  test("activates exactly one read/write target with a semantic event", async () => {
    const transactions: TransactionOperation[][] = [];
    const result = await activateBrainSearchPlacement({
      actor: { principalId, type: "principal" },
      database: {
        deleteRecord: async () => {},
        getRecord: async () => placement,
        putRecord: async () => {},
        queryRecords: async () => ({ items: [] }),
        transactWrite: async (operations) => {
          transactions.push([...operations]);
          return;
        },
      },
      eventId,
      now: timestamp,
      organizationId,
      target,
    });
    expect(result.data).toMatchObject({
      generation: 1,
      phase: "active",
      readTarget: { targetId: target.targetId },
      writeTarget: { targetId: target.targetId },
    });
    expect(
      transactions[0]!
        .filter((operation) => operation.kind === "put")
        .map((operation) => operation.record.itemType),
    ).toEqual(["brain-search-placement", "semantic-event"]);
    expect(
      transactions[0]!.filter((operation) => operation.kind === "condition-check"),
    ).toHaveLength(3);
  });

  test("activates the install default as the platform without a human actor", async () => {
    const transactions: TransactionOperation[][] = [];
    const result = await activateBrainSearchPlacement({
      actor: { type: "system" },
      database: {
        deleteRecord: async () => {},
        getRecord: async () => placement,
        putRecord: async () => {},
        queryRecords: async () => ({ items: [] }),
        transactWrite: async (operations) => {
          transactions.push([...operations]);
        },
      },
      eventId,
      now: timestamp,
      organizationId,
      target,
    });
    expect(result.data).toMatchObject({ phase: "active", readTarget: target, writeTarget: target });
    const conditions = transactions[0]!.filter((operation) => operation.kind === "condition-check");
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toMatchObject({ key: { pk: `ORG#${organizationId}` } });
    const event = transactions[0]!.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "semantic-event",
    );
    expect(event?.kind === "put" ? event.record.data : undefined).toMatchObject({
      actor: { type: "system" },
      eventType: "brain-search-placement.activated",
    });
  });

  test("refuses to replace a placement that is no longer unconfigured", async () => {
    const active = Schema.decodeUnknownSync(BrainSearchPlacementRecord)(
      withCanonicalRecordKeys({
        ...placement,
        data: {
          ...placement.data,
          generation: 1,
          phase: "active" as const,
          readTarget: target,
          version: 1,
          writeTarget: target,
        },
      }),
    );
    expect(
      activateBrainSearchPlacement({
        actor: { type: "system" },
        database: {
          deleteRecord: async () => {},
          getRecord: async () => active,
          putRecord: async () => {},
          queryRecords: async () => ({ items: [] }),
          transactWrite: async () => {},
        },
        eventId,
        now: timestamp,
        organizationId,
        target,
      }),
    ).rejects.toThrow("Only an unconfigured Brain search placement can be activated.");
  });

  test("keeps the serving target active until a migration is explicitly completed", async () => {
    const active = Schema.decodeUnknownSync(BrainSearchPlacementRecord)(
      withCanonicalRecordKeys({
        ...placement,
        data: {
          ...placement.data,
          generation: 1,
          phase: "active" as const,
          readTarget: target,
          version: 1,
          writeTarget: target,
        },
      }),
    );
    const candidate: BrainSearchTarget = {
      ...target,
      location: {
        openSearchEndpoint: "https://search.example",
        openSearchIndex: "brain-org-v1",
        region: "us-east-2",
      },
      providerId: "aws-native",
      targetId: brainUlid("01ARZ3NDEKTSV4RRFFQ69G5FB4"),
    };
    let current = active;
    const transactions: TransactionOperation[][] = [];
    const database = {
      deleteRecord: async () => {},
      getRecord: async () => current,
      putRecord: async () => {},
      queryRecords: async () => ({ items: [] }),
      transactWrite: async (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
        const placementPut = operations.find(
          (operation) =>
            operation.kind === "put" && operation.record.itemType === "brain-search-placement",
        );
        if (
          placementPut?.kind === "put" &&
          placementPut.record.itemType === "brain-search-placement"
        ) {
          current = placementPut.record;
        }
        return;
      },
    };
    const operationId = "01ARZ3NDEKTSV4RRFFQ69G5FB5";

    const migrating = await beginBrainSearchPlacementMigration({
      actorPrincipalId: principalId,
      database,
      eventId,
      now: timestamp,
      operationId,
      organizationId,
      target: candidate,
    });
    expect(migrating.data).toMatchObject({
      candidateTarget: { targetId: candidate.targetId },
      generation: 2,
      operationId,
      readTarget: { targetId: target.targetId },
      writeTarget: { targetId: target.targetId },
    });

    const completed = await completeBrainSearchPlacementMigration({
      actorPrincipalId: principalId,
      database,
      eventId: "01ARZ3NDEKTSV4RRFFQ69G5FB6",
      now: timestamp,
      operationId,
      organizationId,
    });
    expect(completed.data).toMatchObject({
      generation: 3,
      phase: "active",
      readTarget: { targetId: candidate.targetId },
      writeTarget: { targetId: candidate.targetId },
    });
    expect(completed.data).not.toHaveProperty("candidateTarget");
    expect(completed.data).not.toHaveProperty("operationId");
    expect(
      transactions.flatMap((operations) =>
        operations.flatMap((operation) =>
          operation.kind === "put" && operation.record.itemType === "semantic-event"
            ? [operation.record.data.eventType]
            : [],
        ),
      ),
    ).toEqual(["brain-search-placement.migration-requested", "brain-search-placement.migrated"]);
  });

  test("creates a missing envelope create-only behind an active organization", async () => {
    const transactions: TransactionOperation[][] = [];
    const result = await ensureBrainSearchPlacement({
      database: {
        deleteRecord: async () => {},
        getRecord: async () => undefined,
        putRecord: async () => {},
        queryRecords: async () => ({ items: [] }),
        transactWrite: async (operations) => {
          transactions.push([...operations]);
          return;
        },
      },
      now: timestamp,
      organizationId,
    });
    expect(result.data).toMatchObject({ generation: 0, phase: "unconfigured", version: 0 });
    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.map((operation) => operation.kind)).toEqual(["condition-check", "put"]);
    expect(transactions[0]![1]).not.toHaveProperty("previousRecord");
  });

  test("returns a concurrently created envelope instead of failing the losing writer", async () => {
    let reads = 0;
    const result = await ensureBrainSearchPlacement({
      database: {
        deleteRecord: async () => {},
        getRecord: async () => (reads++ === 0 ? undefined : placement),
        putRecord: async () => {},
        queryRecords: async () => ({ items: [] }),
        transactWrite: async () => Promise.reject(new Error("ConditionalCheckFailed")),
      },
      now: "2026-07-31T00:00:00.000Z",
      organizationId,
    });
    expect(result).toBe(placement);
  });

  test("does not write when the organization already has a placement", async () => {
    let writes = 0;
    const result = await ensureBrainSearchPlacement({
      database: {
        deleteRecord: async () => {},
        getRecord: async () => placement,
        putRecord: async () => {},
        queryRecords: async () => ({ items: [] }),
        transactWrite: async () => {
          writes += 1;
          return;
        },
      },
      now: timestamp,
      organizationId,
    });
    expect(result).toBe(placement);
    expect(writes).toBe(0);
  });
});
