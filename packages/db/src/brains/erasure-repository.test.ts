import {
  GetCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import type { Brain, BrainErasure, BrainGrant } from "@deployments-ai/brains";
import { makeDynamoDatabase } from "../client.ts";
import { PersistenceError } from "../persistence-types.ts";
import { makeBrainErasureRepository } from "./erasure-repository.ts";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const brainId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ownerId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const erasureId = "01ARZ3NDEKTSV4RRFFQ69G5FB5";
const eventId = "01ARZ3NDEKTSV4RRFFQ69G5FB6";
const timestamp = "2026-07-30T12:00:00.000Z";

const previous: Brain = {
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
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  organizationId,
  permission: "owner",
  status: "active",
  target: { principalId: ownerId, type: "principal" },
  updatedAt: timestamp,
  version: 0,
};

const erasure: BrainErasure = {
  brainId,
  contentVerificationCount: 0,
  createdAt: timestamp,
  erasureGeneration: 1,
  id: erasureId,
  nextDueAt: timestamp,
  organizationId,
  phase: "draining",
  priority: 0,
  requestedByPrincipalId: ownerId,
  status: "pending",
  updatedAt: timestamp,
  version: 0,
};

function awsError(name: string, fields: Readonly<Record<string, unknown>> = {}) {
  return Object.assign(new Error(name), { name }, fields);
}

type TransactItem = NonNullable<TransactWriteCommand["input"]["TransactItems"]>[number];

function itemTarget(item: TransactItem) {
  const operation = item.ConditionCheck ?? item.Delete ?? item.Update;
  const itemKey = operation?.Key ?? item.Put?.Item;
  const table = operation?.TableName ?? item.Put?.TableName;
  return `${table}|${String(itemKey?.pk)}|${String(itemKey?.sk)}`;
}

// Emulates the TransactWriteItems validation and condition outcomes DynamoDB enforces, over a
// control table without the governance inventory shard-writes marker.
function dynamoClient(outcome: "accept" | "condition-failed") {
  const transactions: TransactItem[][] = [];
  const client = {
    send: async (command: TransactWriteCommand | GetCommand) => {
      if (command instanceof GetCommand) {
        const sk = String(command.input.Key?.sk);
        if (
          sk === "DEPLOY-MIGRATION#governance-inventory-shard-writes" ||
          sk.startsWith("RETENTION-POLICY#")
        ) {
          return {};
        }
        throw new Error("Unexpected DynamoDB get.");
      }
      const items = command.input.TransactItems ?? [];
      transactions.push(items);
      const targets = items.map(itemTarget);
      if (new Set(targets).size !== targets.length) {
        throw awsError("ValidationException", {
          message: "Transaction request cannot include multiple operations on one item",
        });
      }
      if (outcome === "condition-failed") {
        throw awsError("TransactionCanceledException", {
          CancellationReasons: items.map((_, index) =>
            index === 0 ? { Code: "ConditionalCheckFailed" } : { Code: "None" },
          ),
        });
      }
      return {};
    },
  } as unknown as DynamoDBDocumentClient;
  return { client, transactions };
}

function begin(client: DynamoDBDocumentClient) {
  return makeBrainErasureRepository(makeDynamoDatabase(client)).beginErasure({
    authorizingGrant: ownerGrant,
    brain: {
      ...previous,
      status: "erasing",
      updatedAt: timestamp,
      version: previous.version + 1,
    },
    erasure,
    eventId,
    previous,
  });
}

describe("Brain erasure repository", () => {
  test("starts erasure in a transaction DynamoDB accepts", async () => {
    const { client, transactions } = dynamoClient("accept");

    expect(begin(client)).resolves.toEqual(erasure);

    const brainItems = transactions[0]!.filter(
      (item) => itemTarget(item) === `control|ORG#${organizationId}|BRAIN#${brainId}`,
    );
    expect(brainItems).toHaveLength(1);
    expect(brainItems[0]!.Put?.Item?.data).toMatchObject({ status: "erasing", version: 1 });
    expect(transactions[0]!.some((item) => item.Put?.Item?.itemType === "brain-erasure-job")).toBe(
      true,
    );
  });

  test("reports a precondition race as a Brain erasure conflict", async () => {
    const { client } = dynamoClient("condition-failed");

    const failure = await begin(client).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(PersistenceError);
    expect(failure).toMatchObject({ code: "brain_erasure_conflict", kind: "conflict" });
  });
});
