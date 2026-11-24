import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import { makeDynamoDatabase, tableNamesFromEnvironment } from "../dynamo-database.ts";
import { makeIdGenerator } from "../ids.ts";
import { organizationRecord } from "../organization-standing/test-support.ts";
import { ENVIRONMENT_ID, PROJECT_ID, recordSpend } from "./budget-test-support.ts";
import { readMonthSpend } from "./month-spend.ts";

const endpoint = process.env.AWS_ENDPOINT_URL_DYNAMODB;

describe.skipIf(!endpoint)("organization month spend on local DynamoDB", () => {
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      ...(endpoint ? { endpoint } : {}),
      region: process.env.AWS_REGION ?? "us-east-1",
    }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  const tableNames = tableNamesFromEnvironment();
  const database = makeDynamoDatabase(client, tableNames);
  const ids = makeIdGenerator();

  test("reads the payer split back from the stored shards", async () => {
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ids.generate(),
      projectId: PROJECT_ID,
      workspaceId: undefined,
    };
    await client.send(
      new PutCommand({
        Item: organizationRecord(scope.organizationId),
        TableName: tableNames.control,
      }),
    );
    for (const [shard, spendUsdMicros, funding] of [
      [3, 600, "operator"],
      [9, 250, "operator"],
      [3, 400, "organization"],
    ] as const) {
      await recordSpend(database, {
        funding,
        occurredAt: "2026-03-10T08:00:00.000Z",
        scope,
        shard,
        spendUsdMicros,
      });
    }

    expect(
      await readMonthSpend(
        database,
        scope.organizationId,
        { scope: "organization" },
        new Date("2026-03-20T00:00:00.000Z"),
      ),
    ).toEqual({
      asOf: "2026-03-20T00:00:00.000Z",
      operatorFundedUsdMicros: 850,
      organizationFundedUsdMicros: 400,
      periodStart: "2026-03-01T00:00:00.000Z",
      totalUsdMicros: 1_250,
    });
  });
});
