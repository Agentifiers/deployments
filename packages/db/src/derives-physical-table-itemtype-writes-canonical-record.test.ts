import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";

import { makeDynamoDatabase } from "./client.ts";
import { UNIQUE_CLAIM_CONDITION } from "./keys.ts";
import { type PlatformRecord } from "./records/index.ts";
import { fakeDynamoDocumentClient } from "./testing/dynamo-document-client.fixture.ts";
import {
  ORG_ID,
  PROJECT_ID,
  recordingClient,
  organizationRecord,
  semanticEventRecord,
  auditEventRecord,
  runtimeLeaseRecord,
  principalIdempotencyCompletionRecord,
  uniqueClaimRecord,
  organizationConditionKeys,
  shardWritesMarkerRead,
  TENANT_GATE_LANE_CONDITION,
} from "./database-write-test-support.ts";

const ALL_LANE_KEYS = Array.from({ length: 32 }, (_, lane) => ({
  pk: `ORG#${ORG_ID}`,
  sk: `ORGANIZATION-GATE-LANE#${String(lane).padStart(2, "0")}`,
}));

describe("DynamoDatabase writes and uniqueness", () => {
  test("derives the physical table from itemType and writes the canonical record", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client, {
      control: "platform-control",
      events: "platform-events",
      execution: "platform-execution",
      usage: "platform-usage",
    });
    const record = await auditEventRecord();

    await database.putRecord(record);

    expect(commands).toHaveLength(2);
    expect(commands[0]).toBeInstanceOf(GetCommand);
    expect(commands[0]).toMatchObject(shardWritesMarkerRead("platform-control"));
    const command = commands[1] as TransactWriteCommand;
    expect(command).toBeInstanceOf(TransactWriteCommand);
    expect(command.input.TransactItems?.[0]?.Put?.TableName).toBe("platform-events");
    expect(command.input.TransactItems?.[0]?.Put?.ConditionExpression).toBe(
      "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    );
    expect(organizationConditionKeys(command)).toEqual([
      { pk: `ORG#${ORG_ID}`, sk: "ORGANIZATION-GATE-LANE#00" },
    ]);
    const laneCheck = command.input.TransactItems?.at(-1)?.ConditionCheck;
    expect(laneCheck).toMatchObject({
      ConditionExpression: TENANT_GATE_LANE_CONDITION,
      ExpressionAttributeNames: {
        "#gate": "data",
        "#gateFence": "erasureFence",
        "#gateFenceLease": "leaseExpiresAt",
      },
      TableName: "platform-control",
    });
    expect(
      Date.parse(String(laneCheck?.ExpressionAttributeValues?.[":gateObservedAt"])),
    ).not.toBeNaN();
  });

  test("fences tenant runtime leases without projecting them into activity indexes", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);

    await database.putRecord(await runtimeLeaseRecord());

    const command = transactions[0]!;
    const put = command.input.TransactItems?.[0]?.Put;
    expect(put?.Item).not.toHaveProperty("gsi1pk");
    expect(put?.Item).not.toHaveProperty("gsi2pk");
    expect(organizationConditionKeys(command)).toEqual([
      { pk: `ORG#${ORG_ID}`, sk: "ORGANIZATION-GATE-LANE#13" },
    ]);
  });

  test("routes direct tenant deletes through the organization gate lane", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);

    await database.deleteRecord(await runtimeLeaseRecord());

    const command = transactions[0]!;
    expect(command.input.TransactItems?.[0]?.Delete?.TableName).toBe("execution");
    expect(organizationConditionKeys(command)).toEqual([
      { pk: `ORG#${ORG_ID}`, sk: "ORGANIZATION-GATE-LANE#13" },
    ]);
  });

  test("fences transactional deletion of the canonical organization and deletes its lanes", async () => {
    const fake = fakeDynamoDocumentClient();
    const database = makeDynamoDatabase(fake.client);
    const organization = await organizationRecord();
    const claim = await uniqueClaimRecord();
    fake.put("control", organization);
    fake.put("control", claim);

    await database.transactWrite([
      { kind: "delete", record: organization },
      { kind: "delete", record: claim },
    ]);

    const items = fake.transactions[0]?.input.TransactItems ?? [];
    expect(
      items.flatMap((item) => (item.Delete?.Key?.pk === `ORG#${ORG_ID}` ? [item.Delete.Key] : [])),
    ).toEqual([{ pk: `ORG#${ORG_ID}`, sk: `ORG#${ORG_ID}` }, ...ALL_LANE_KEYS]);
    expect(items.flatMap((item) => (item.ConditionCheck ? [item.ConditionCheck.Key] : []))).toEqual(
      [{ pk: `ORG#${ORG_ID}`, sk: `ERASURE-FENCE#${ORG_ID}` }],
    );
    expect(fake.transactions.map((transaction) => transaction.outcome)).toEqual(["applied"]);
    expect(fake.items("control")).toEqual([]);
  });

  test("fences principal-keyed idempotency completions resolved to a tenant", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);
    const record = await principalIdempotencyCompletionRecord();

    await database.transactWrite([{ kind: "put", record }]);

    expect(record.pk).toBe(`PRINCIPAL#${PROJECT_ID}#IDEMPOTENCY`);
    const command = transactions[0]!;
    expect(organizationConditionKeys(command)).toEqual([
      { pk: `ORG#${ORG_ID}`, sk: "ORGANIZATION-GATE-LANE#26" },
    ]);
  });

  test("rejects direct audit deletion before issuing a DynamoDB command", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);

    expect(database.deleteRecord(await auditEventRecord())).rejects.toBeDefined();
    expect(commands).toHaveLength(0);
  });

  test("forces transactional audit appends to be create-only", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);

    await database.transactWrite([{ kind: "put", record: await auditEventRecord() }]);

    const command = transactions[0]!;
    expect(command.input.TransactItems?.[0]?.Put?.ConditionExpression).toBe(
      "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    );
  });

  test("rejects unregistered fields before writing a record", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);
    const record = {
      ...(await auditEventRecord()),
      leakedTopLevel: true,
    } as unknown as PlatformRecord;

    expect(database.putRecord(record)).rejects.toBeDefined();
    expect(commands).toHaveLength(0);
  });

  test("maps and validates every transactional put", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client, {
      control: "platform-control",
      events: "platform-events",
      execution: "platform-execution",
      usage: "platform-usage",
    });

    await database.transactWrite([
      {
        conditionExpression: UNIQUE_CLAIM_CONDITION,
        kind: "put",
        record: await uniqueClaimRecord(),
      },
      { kind: "put", record: await organizationRecord() },
      { kind: "put", record: await semanticEventRecord() },
    ]);

    const command = transactions[0]!;
    const puts = command.input.TransactItems?.flatMap((item) => (item.Put ? [item.Put] : [])) ?? [];
    expect(
      puts.flatMap((put) =>
        put.Item?.itemType !== "governance-tenant-record" &&
        put.Item?.itemType !== "organization-gate-lane"
          ? [put.TableName]
          : [],
      ),
    ).toEqual(["platform-control", "platform-control", "platform-events"]);
    expect(puts.filter((put) => put.Item?.itemType === "governance-tenant-record")).toHaveLength(3);
    expect(
      puts.flatMap((put) =>
        put.Item?.itemType === "organization-gate-lane"
          ? [{ pk: put.Item.pk, sk: put.Item.sk, table: put.TableName }]
          : [],
      ),
    ).toEqual(ALL_LANE_KEYS.map((key) => ({ ...key, table: "platform-control" })));
    expect(organizationConditionKeys(command)).toEqual([
      { pk: `ORG#${ORG_ID}`, sk: `ERASURE-FENCE#${ORG_ID}` },
    ]);
  });
});
