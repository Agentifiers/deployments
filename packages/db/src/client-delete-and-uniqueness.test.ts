import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { makeDynamoDatabase } from "./client.ts";
import {
  organizationConditionKeys,
  recordingClient,
  shardWritesMarkerRead,
} from "./database-write-test-support.ts";
import { Ulid } from "./ids.ts";
import { Keys, UNIQUE_CLAIM_CONDITION } from "./keys.ts";
import { decodePlatformRecord, withCanonicalRecordKeys } from "./records/index.ts";

const ORG_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const PROJECT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const ENVIRONMENT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAX");
const EVENT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAY");

async function organizationRecord(slug = "deployments-ai", version = 1) {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-07-20T00:00:00.000Z",
          id: ORG_ID,
          name: "Deployments.ai",
          slug,
          status: "active",
          updatedAt: "2026-07-20T00:00:00.000Z",
          version,
        },
        itemType: "organization",
      }),
    ),
  );
}

async function principalRecord(version = 1) {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-07-20T00:00:00.000Z",
          id: PROJECT_ID,
          kind: "human",
          status: "active",
          updatedAt: "2026-07-20T00:00:00.000Z",
          version,
        },
        itemType: "principal",
      }),
    ),
  );
}

async function providerConnectionRecord(version: number, externalAccountId?: string) {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          authMethod: "oauth",
          createdAt: "2026-07-20T00:00:00.000Z",
          environmentId: ENVIRONMENT_ID,
          ...(externalAccountId ? { externalAccountId } : {}),
          id: EVENT_ID,
          organizationId: ORG_ID,
          projectId: PROJECT_ID,
          providerKey: "github",
          scopes: [],
          status: "active",
          updatedAt: "2026-07-20T00:00:00.000Z",
          version,
        },
        itemType: "provider-connection",
      }),
    ),
  );
}

async function providerConnectionClaim(value: string) {
  const owner = await providerConnectionRecord(1, value);
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-07-20T00:00:00.000Z",
          namespace: `environment:${ENVIRONMENT_ID}:provider-connection:github`,
          ownerId: EVENT_ID,
          ownerItemType: "provider-connection",
          ownerPk: owner.pk,
          ownerSk: owner.sk,
          ownerTable: "control",
          value,
        },
        itemType: "unique-claim",
      }),
    ),
  );
}

async function runRecord(id: typeof EVENT_ID, version: number) {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          agentDeploymentId: EVENT_ID,
          agentReleaseId: PROJECT_ID,
          attempt: 1,
          captureMode: "metadata-only",
          createdAt: "2026-07-20T00:00:00.000Z",
          environmentId: ENVIRONMENT_ID,
          executor: "platform",
          id,
          idempotencyKey: "run/request-123",
          organizationId: ORG_ID,
          priority: 1,
          projectId: PROJECT_ID,
          redactionPolicyVersion: 1,
          schemaVersion: 1,
          spanId: "0123456789abcdef",
          status: "queued",
          threadId: PROJECT_ID,
          traceId: "0123456789abcdef0123456789abcdef",
          trigger: "api",
          updatedAt: "2026-07-20T00:00:00.000Z",
          version,
        },
        itemType: "run",
      }),
    ),
  );
}

async function uniqueClaimRecord(value = "deployments-ai") {
  const owner = await organizationRecord();
  const recordKey = Keys.control.uniqueClaim("organization-slug", value);
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-07-20T00:00:00.000Z",
          namespace: "organization-slug",
          ownerId: ORG_ID,
          ownerItemType: "organization",
          ownerPk: owner.pk,
          ownerSk: owner.sk,
          ownerTable: "control",
          value,
        },
        itemType: "unique-claim",
        ...recordKey,
      }),
    ),
  );
}

describe("DynamoDB deletion and uniqueness", () => {
  test("checks stored absence before adding or deleting an optional unique field", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);
    const previousRecord = await providerConnectionRecord(1);
    const replacementRecord = await providerConnectionRecord(2, "account-123");

    await database.transactWrite([
      {
        conditionExpression: UNIQUE_CLAIM_CONDITION,
        kind: "put",
        record: await providerConnectionClaim("account-123"),
      },
      { kind: "put", previousRecord, record: replacementRecord },
    ]);
    await database.deleteRecord(previousRecord);

    const transaction = transactions[0]!;
    const ownerPut = transaction.input.TransactItems?.find(
      (item) => item.Put?.Item?.itemType === "provider-connection",
    )?.Put;
    const deleteTransaction = transactions[1]!;
    const tenantDelete = deleteTransaction.input.TransactItems?.find(
      (item) =>
        item.Delete?.Key?.pk === previousRecord.pk && item.Delete.Key.sk === previousRecord.sk,
    )?.Delete;
    expect(ownerPut?.ConditionExpression).toContain("attribute_not_exists");
    expect(ownerPut?.ConditionExpression).toContain("#dbPreviousExternalAccountId");
    expect(tenantDelete?.ConditionExpression).toContain("attribute_not_exists");
    expect(tenantDelete?.ConditionExpression).toContain("#dbPreviousExternalAccountId");
    expect(organizationConditionKeys(deleteTransaction)).toEqual([
      { pk: `ORG#${ORG_ID}`, sk: "ORGANIZATION-GATE-LANE#01" },
    ]);
  });

  test("binds immutable identity fields to stored updates and deletes", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);
    const previousRecord = await runRecord(EVENT_ID, 1);
    const replacementRecord = await runRecord(EVENT_ID, 2);

    await database.transactWrite([{ kind: "put", previousRecord, record: replacementRecord }]);
    await database.transactWrite([{ kind: "delete", record: previousRecord }]);

    const transaction = transactions[0]!;
    const ownerPut = transaction.input.TransactItems?.find(
      (item) => item.Put?.Item?.itemType === "run",
    )?.Put;
    const locatorPut = transaction.input.TransactItems?.find(
      (item) => item.Put?.Item?.itemType === "run-locator",
    )?.Put;
    const deleteTransaction = transactions[1]!;
    const ownerDelete = deleteTransaction.input.TransactItems?.find(
      (item) =>
        item.Delete?.Key?.pk === previousRecord.pk && item.Delete.Key.sk === previousRecord.sk,
    )?.Delete;
    const locatorDelete = deleteTransaction.input.TransactItems?.find(
      (item) =>
        item.Delete?.TableName === "control" && item.Delete.Key?.sk?.startsWith("RUN-LOCATOR#"),
    )?.Delete;
    expect(ownerPut?.ConditionExpression).toContain("#dbPreviousId");
    expect(ownerPut?.ConditionExpression).toContain("#dbImmutableItemType");
    expect(ownerPut?.ExpressionAttributeValues?.[":dbPreviousId"]).toBe(EVENT_ID);
    expect(ownerPut?.ExpressionAttributeValues?.[":dbImmutableItemType"]).toBe("run");
    expect(locatorPut?.ConditionExpression).toContain("attribute_not_exists(pk) OR");
    expect(locatorPut?.ExpressionAttributeValues?.[":locatorRunPk"]).toBe(replacementRecord.pk);
    expect(locatorPut?.ExpressionAttributeValues?.[":locatorRunSk"]).toBe(replacementRecord.sk);
    expect(ownerDelete?.ConditionExpression).toContain("#dbPreviousId");
    expect(ownerDelete?.ConditionExpression).toContain("#dbImmutableItemType");
    expect(locatorDelete?.ConditionExpression).toBeUndefined();
    expect(locatorDelete?.TableName).toBe("control");
  });

  test("applies optimistic conditions to every versioned delete", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const principal = await principalRecord();

    await database.deleteRecord(principal);
    await database.transactWrite([{ kind: "delete", record: principal }]);

    const directDelete = commands[0] as DeleteCommand;
    const transaction = commands[1] as TransactWriteCommand;
    expect(directDelete.input.ConditionExpression).toContain("#dbResourceVersion");
    expect(directDelete.input.ExpressionAttributeValues?.[":dbPreviousVersion"]).toBe(1);
    expect(transaction.input.TransactItems?.[0]?.Delete?.ConditionExpression).toContain(
      "#dbResourceVersion",
    );
    expect(
      transaction.input.TransactItems?.[0]?.Delete?.ExpressionAttributeValues?.[
        ":dbPreviousVersion"
      ],
    ).toBe(1);
  });

  test("deletes a unique-bearing owner and claim atomically", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const organization = await organizationRecord();
    const claim = await uniqueClaimRecord();

    await database.transactWrite([
      { kind: "delete", record: organization },
      { kind: "delete", record: claim },
    ]);

    const [laneRead, markerRead, command] = commands as [
      QueryCommand,
      GetCommand,
      TransactWriteCommand,
    ];
    expect(laneRead).toBeInstanceOf(QueryCommand);
    expect(laneRead.input).toEqual({
      ConsistentRead: true,
      ExpressionAttributeValues: {
        ":pk": `ORG#${ORG_ID}`,
        ":prefix": "ORGANIZATION-GATE-LANE#",
      },
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      Limit: 32,
      TableName: "control",
    });
    expect(markerRead).toBeInstanceOf(GetCommand);
    expect(markerRead).toMatchObject(shardWritesMarkerRead());
    const ownerDelete = command.input.TransactItems?.find(
      (item) => item.Delete?.Key?.pk === organization.pk && item.Delete.Key.sk === organization.sk,
    )?.Delete;
    const claimDelete = command.input.TransactItems?.find(
      (item) => item.Delete?.Key?.pk === claim.pk && item.Delete.Key.sk === claim.sk,
    )?.Delete;
    expect(ownerDelete?.ConditionExpression).toContain("#dbResourceVersion");
    expect(ownerDelete?.ConditionExpression).toContain("#dbPreviousSlug");
    expect(ownerDelete?.ExpressionAttributeValues?.[":dbPreviousVersion"]).toBe(1);
    expect(ownerDelete?.ExpressionAttributeValues?.[":dbPreviousSlug"]).toBe("deployments-ai");
    expect(claimDelete?.ConditionExpression).toContain("#dbClaimOwnerId");
    expect(claimDelete?.ExpressionAttributeValues?.[":dbClaimOwnerId"]).toBe(ORG_ID);
  });
});
