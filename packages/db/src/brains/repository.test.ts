import { describe, expect, it } from "bun:test";
import type { Brain, BrainGrant } from "@deployments-ai/brains";
import type {
  DynamoDatabaseService,
  QueryRecordsResult,
  TransactionOperation,
} from "../client-types.ts";
import { brainPlatformRecord } from "./record-mapping.ts";
import { makeBrainDynamoRepository } from "./repository.ts";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const brainId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ownerId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const ownerGrantId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const eventId = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const newOwnerGrantId = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const newOwnerId = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
const transferEventId = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
const timestamp = "2026-07-30T12:00:00.000Z";

const brain: Brain = {
  createdAt: timestamp,
  createdByPrincipalId: ownerId,
  id: brainId,
  kind: "company",
  maintenancePolicy: {},
  name: "Engineering",
  organizationId,
  ownershipGeneration: 0,
  retrievalPolicy: {},
  schemaVersion: 1,
  sensitivity: "internal",
  slug: "engineering",
  status: "active",
  updatedAt: timestamp,
  updatedByPrincipalId: ownerId,
  version: 0,
};

const ownerGrant: BrainGrant = {
  brainId,
  brainKind: "company",
  createdAt: timestamp,
  grantedByPrincipalId: ownerId,
  id: ownerGrantId,
  organizationId,
  permission: "owner",
  status: "active",
  target: { principalId: ownerId, type: "principal" },
  updatedAt: timestamp,
  version: 0,
};

function fakeDatabase(
  args: {
    readonly brain?: Brain;
    readonly query?: QueryRecordsResult;
  } = {},
) {
  const transactions: readonly TransactionOperation[][] = [];
  const mutableTransactions = transactions as TransactionOperation[][];
  const database: DynamoDatabaseService = {
    deleteRecord: async () => {},
    getRecord: async (_table, recordKey) => {
      const record = args.brain ? brainPlatformRecord(args.brain) : undefined;
      return record && record.pk === recordKey.pk && record.sk === recordKey.sk
        ? record
        : undefined;
    },
    putRecord: async () => {},
    queryRecords: async () => args.query ?? { items: [] },
    transactWrite: async (operations) => {
      mutableTransactions.push([...operations]);
      return;
    },
  };
  return { database, transactions };
}

describe("Brain DynamoDB repository", () => {
  it("creates a Brain, owner, claims, and semantic event in one transaction", async () => {
    const fake = fakeDatabase();
    const created = await makeBrainDynamoRepository(fake.database).createWithOwner({
      brain,
      eventId,
      ownerGrant,
    });

    expect(created).toEqual(brain);
    expect(fake.transactions).toHaveLength(1);
    const operations = fake.transactions[0]!;
    expect(
      operations
        .filter((operation) => operation.kind === "condition-check")
        .map((operation) => operation.key.sk.split("#")[0]),
    ).toEqual(["ORG", "PRINCIPAL", "ORGANIZATION-MEMBER"]);
    expect(
      operations
        .filter((operation) => operation.kind === "put")
        .map((operation) => operation.record.itemType),
    ).toEqual(["brain", "unique-claim", "brain-grant", "unique-claim", "semantic-event"]);
    const event = operations.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "semantic-event",
    );
    expect(event?.kind === "put" ? event.record.data : undefined).toMatchObject({
      aggregateId: brainId,
      aggregateType: "brain",
      aggregateVersion: 1,
      eventType: "brain.created",
    });
  });

  it("requires elevated organization membership for company Brain creation", async () => {
    const fake = fakeDatabase();
    await makeBrainDynamoRepository(fake.database).createWithOwner({
      brain,
      eventId,
      ownerGrant,
    });
    const membership = fake.transactions[0]!.find(
      (operation) =>
        operation.kind === "condition-check" &&
        operation.key.sk === `ORGANIZATION-MEMBER#${ownerId}`,
    );
    expect(membership?.conditionExpression).toContain("#data.#role IN (:admin, :owner)");
  });

  it("rejects a creator whose initial owner grant targets another principal", async () => {
    const fake = fakeDatabase();
    expect(
      makeBrainDynamoRepository(fake.database).createWithOwner({
        brain,
        eventId,
        ownerGrant: {
          ...ownerGrant,
          target: { principalId: newOwnerId, type: "principal" },
        },
      }),
    ).rejects.toThrow("creating principal");
    expect(fake.transactions).toHaveLength(0);
  });

  it("transfers private ownership by advancing generation and revoking the former owner atomically", async () => {
    const privateBrain: Brain = {
      ...brain,
      kind: "member-private",
      ownerPrincipalId: ownerId,
      ownershipGeneration: 1,
    };
    const previousGrant: BrainGrant = {
      ...ownerGrant,
      brainKind: "member-private",
      ownershipGeneration: 1,
    };
    const transferAt = "2026-07-30T12:01:00.000Z";
    const nextBrain: Brain = {
      ...privateBrain,
      ownerPrincipalId: newOwnerId,
      ownershipGeneration: 2,
      updatedAt: transferAt,
      updatedByPrincipalId: ownerId,
      version: 1,
    };
    const nextOwnerGrant: BrainGrant = {
      ...previousGrant,
      createdAt: transferAt,
      grantedByPrincipalId: ownerId,
      id: newOwnerGrantId,
      ownershipGeneration: 2,
      target: { principalId: newOwnerId, type: "principal" },
      updatedAt: transferAt,
    };
    const fake = fakeDatabase({ brain: privateBrain });

    const transferred = await makeBrainDynamoRepository(
      fake.database,
    ).transferMemberPrivateOwnership({
      brain: nextBrain,
      eventId: transferEventId,
      nextOwnerGrant,
      previousOwnerGrant: previousGrant,
    });

    expect(transferred.ownershipGeneration).toBe(2);
    const operations = fake.transactions[0]!;
    const grants = operations.flatMap((operation) =>
      operation.kind === "put" && operation.record.itemType === "brain-grant"
        ? [operation.record]
        : [],
    );
    expect(grants).toHaveLength(2);
    expect(grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            id: ownerGrantId,
            ownershipGeneration: 1,
            status: "revoked",
            version: 1,
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            id: newOwnerGrantId,
            ownershipGeneration: 2,
            status: "active",
            version: 0,
          }),
        }),
      ]),
    );
    expect(
      operations.some(
        (operation) => operation.kind === "put" && operation.record.itemType === "semantic-event",
      ),
    ).toBe(true);
  });

  it("lists only Brain records from the organization index", async () => {
    const record = brainPlatformRecord(brain);
    const fake = fakeDatabase({ query: { items: [record] } });
    const result = await makeBrainDynamoRepository(fake.database).listByOrganization(
      organizationId,
      { limit: 20, status: "active" },
    );

    expect(result.items).toEqual([brain]);
  });
});
