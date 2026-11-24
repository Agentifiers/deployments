import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { makeDynamoDatabase } from "./client.ts";
import { recordingClient } from "./database-write-test-support.ts";
import { Ulid } from "./ids.ts";
import { decodePlatformRecord, withCanonicalRecordKeys } from "./records/index.ts";

const ORGANIZATION_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const PROJECT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const ENVIRONMENT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAX");
const MEMORY_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAY");
const TARGET_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAZ");
const timestamp = "2026-07-30T12:00:00.000Z";

async function indexState() {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          attemptId: "attempt-1",
          contentHash: "sha256:memory",
          createdAt: timestamp,
          environmentId: ENVIRONMENT_ID,
          memoryId: MEMORY_ID,
          namespace: "memory-v1",
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          provider: "aws-native" as const,
          status: "ready" as const,
          synchronizationGeneration: 1,
          synchronizedVersion: 1,
          targetId: TARGET_ID,
          updatedAt: timestamp,
          version: 0,
        },
        itemType: "memory-index-state" as const,
      }),
    ),
  );
}

describe("memory search target directory persistence", () => {
  test("writes a deterministic directory entry with a direct target-record put", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);
    const source = await indexState();

    await database.putRecord(source);

    const command = transactions[0]!;
    const directory = command.input.TransactItems?.find(
      (item) => item.Put?.Item?.itemType === "memory-search-target-record",
    )?.Put;
    expect(directory?.TableName).toBe("control");
    expect(directory?.Item).toMatchObject({
      data: {
        organizationId: ORGANIZATION_ID,
        recordItemType: "memory-index-state",
        recordPk: source.pk,
        recordSk: source.sk,
        recordTable: "control",
        targetId: TARGET_ID,
      },
      itemType: "memory-search-target-record",
      pk: `MEMORY-SEARCH-TARGET#${TARGET_ID}`,
    });
    expect(directory?.Item?.sk).toMatch(/^RECORD#[a-f0-9]{64}$/u);
    expect(directory?.ConditionExpression).toContain("attribute_not_exists(pk) OR");
  });

  test("deletes the directory entry with a direct target-record delete", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);
    const source = await indexState();

    await database.deleteRecord(source);

    const command = transactions[0]!;
    expect(
      command.input.TransactItems?.some(
        (item) =>
          item.Delete?.TableName === "control" &&
          String(item.Delete.Key?.pk) === `MEMORY-SEARCH-TARGET#${TARGET_ID}` &&
          /^RECORD#[a-f0-9]{64}$/u.test(String(item.Delete.Key?.sk)),
      ),
    ).toBe(true);
  });

  test("counts generated directory entries against DynamoDB transaction limits", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const source = await indexState();

    expect(
      database.transactWrite(
        Array.from({ length: 51 }, () => ({ kind: "delete" as const, record: source })),
      ),
    ).rejects.toBeDefined();
    expect(commands).toHaveLength(0);
  });

  test("maintains the directory in erasure-owned transactions", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);
    const source = await indexState();

    await (database.transactWriteForErasure?.([{ kind: "delete", record: source }], {
      operationId: MEMORY_ID,
      organizationId: ORGANIZATION_ID,
    }) ?? Promise.reject(new Error("Missing erasure-aware persistence.")));

    const command = transactions[0]!;
    expect(
      command.input.TransactItems?.some(
        (item) =>
          item.Delete?.TableName === "control" &&
          String(item.Delete.Key?.pk) === `MEMORY-SEARCH-TARGET#${TARGET_ID}`,
      ),
    ).toBe(true);
    expect(
      command.input.TransactItems?.flatMap((item) =>
        item.ConditionCheck?.Key?.pk === `ORG#${ORGANIZATION_ID}`
          ? [
              {
                key: item.ConditionCheck.Key,
                operationId: item.ConditionCheck.ExpressionAttributeValues?.[":gateFenceOperation"],
              },
            ]
          : [],
      ),
    ).toEqual([
      {
        key: { pk: `ORG#${ORGANIZATION_ID}`, sk: "ORGANIZATION-GATE-LANE#23" },
        operationId: MEMORY_ID,
      },
    ]);
  });
});
