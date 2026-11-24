import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { makeDynamoDatabase, type TransactionOperation } from "./client.ts";
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

describe("DynamoDatabase", () => {
  test("rejects transactions whose generated run locators exceed DynamoDB capacity", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const conditionChecks: TransactionOperation[] = Array.from({ length: 99 }, (_, index) => ({
      conditionExpression: "attribute_exists(pk)",
      key: { pk: `CAPACITY#${index}`, sk: "CHECK" },
      kind: "condition-check" as const,
      table: "control" as const,
    }));

    const exit = await database
      .transactWrite([...conditionChecks, { kind: "put", record: await runRecord(EVENT_ID, 1) }])
      .then(
        () => "Success" as const,
        () => "Failure" as const,
      );

    expect(exit).toBe("Failure");
    expect(commands).toHaveLength(0);
  });

  test("rejects run updates through putRecord because they cannot release capacity", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const run = await runRecord(EVENT_ID, 2);

    const failure = await database.putRecord(run, "attribute_exists(pk)").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(failure).toMatchObject({
      cause:
        "run updates must be transactional with previousRecord so capacity claims are released.",
    });
    expect(commands).toEqual([]);
  });

  test("preserves custom create conditions for version-zero runs", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);
    const run = await runRecord(EVENT_ID, 0);

    await database.putRecord(run, "attribute_not_exists(pk)");

    const command = transactions[0]!;
    expect(command.input.TransactItems?.[0]?.Put?.ConditionExpression).toContain(
      "attribute_not_exists(pk)",
    );
    expect(command.input.TransactItems?.[1]?.Put?.ConditionExpression).toContain(
      "attribute_not_exists(pk) OR",
    );
  });

  test("rejects version-zero run updates that are not exact create-only writes", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const run = await runRecord(EVENT_ID, 0);

    const exit = await database.putRecord(run, "attribute_exists(pk)").then(
      () => "Success" as const,
      () => "Failure" as const,
    );

    expect(exit).toBe("Failure");
    expect(commands).toEqual([]);
  });

  test("keeps unconditional run putRecord writes create-only", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);
    const run = await runRecord(EVENT_ID, 1);

    await database.putRecord(run);

    const command = transactions[0]!;
    expect(
      command.input.TransactItems?.find((item) => item.Put?.Item?.itemType === "run")?.Put
        ?.ConditionExpression,
    ).toBe(UNIQUE_CLAIM_CONDITION);
    expect(organizationConditionKeys(command)).toEqual([
      { pk: `ORG#${ORG_ID}`, sk: "ORGANIZATION-GATE-LANE#13" },
    ]);
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
