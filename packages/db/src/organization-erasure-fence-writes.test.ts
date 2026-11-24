import { describe, expect, test } from "bun:test";
import { makeDynamoDatabase } from "./client.ts";
import { UNIQUE_CLAIM_CONDITION } from "./keys.ts";
import {
  ORG_ID,
  EVENT_ID,
  recordingClient,
  auditEventRecord,
  organizationConditionKeys,
  TENANT_GATE_LANE_CONDITION,
} from "./database-write-test-support.ts";

describe("DynamoDatabase writes and uniqueness", () => {
  test("reserves organization erasure-fence condition keys for canonical write fencing", async () => {
    const { client, commands } = recordingClient();
    const database = makeDynamoDatabase(client);

    expect(
      database.transactWrite([
        {
          conditionExpression: "attribute_exists(pk)",
          key: {
            pk: `ORG#${ORG_ID}`,
            sk: `ERASURE-FENCE#${ORG_ID}`,
          },
          kind: "condition-check",
          table: "control",
        },
        { kind: "put", record: await auditEventRecord() },
      ]),
    ).rejects.toBeDefined();
    expect(commands).toHaveLength(0);
  });

  test("replaces a caller-supplied canonical erasure fence with one organization gate lane check", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);

    await database.transactWrite([
      {
        conditionExpression: "attribute_not_exists(pk)",
        key: {
          pk: `ORG#${ORG_ID}`,
          sk: `ERASURE-FENCE#${ORG_ID}`,
        },
        kind: "condition-check",
        table: "control",
      },
      { kind: "put", record: await auditEventRecord() },
    ]);

    const command = transactions[0]!;
    expect(command.input.TransactItems).toHaveLength(3);
    expect(organizationConditionKeys(command)).toEqual([
      { pk: `ORG#${ORG_ID}`, sk: "ORGANIZATION-GATE-LANE#28" },
    ]);
    expect(command.input.TransactItems?.[2]?.ConditionCheck).toEqual({
      ConditionExpression: TENANT_GATE_LANE_CONDITION,
      ExpressionAttributeNames: {
        "#gate": "data",
        "#gateFence": "erasureFence",
        "#gateFenceLease": "leaseExpiresAt",
      },
      ExpressionAttributeValues: { ":gateObservedAt": expect.stringMatching(/^\d{4}-\d\d-\d\dT/) },
      Key: { pk: `ORG#${ORG_ID}`, sk: "ORGANIZATION-GATE-LANE#28" },
      TableName: "control",
    });
  });

  test("replaces the standard create-only placeholder for an organization erasure fence", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);

    await database.transactWrite([
      {
        conditionExpression: UNIQUE_CLAIM_CONDITION,
        key: {
          pk: `ORG#${ORG_ID}`,
          sk: `ERASURE-FENCE#${ORG_ID}`,
        },
        kind: "condition-check",
        table: "control",
      },
      { kind: "put", record: await auditEventRecord() },
    ]);

    const command = transactions[0]!;
    expect(organizationConditionKeys(command)).toEqual([
      { pk: `ORG#${ORG_ID}`, sk: "ORGANIZATION-GATE-LANE#28" },
    ]);
    expect(command.input.TransactItems?.[2]?.ConditionCheck?.ConditionExpression).toBe(
      TENANT_GATE_LANE_CONDITION,
    );
  });

  test("preserves a stronger organization condition while enforcing tenant existence", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);

    await database.transactWrite([
      {
        conditionExpression: "#itemType = :itemType AND #data.#status = :active",
        expressionAttributeNames: {
          "#data": "data",
          "#itemType": "itemType",
          "#status": "status",
        },
        expressionAttributeValues: {
          ":active": "active",
          ":itemType": "organization",
        },
        key: {
          pk: `ORG#${ORG_ID}`,
          sk: `ORG#${ORG_ID}`,
        },
        kind: "condition-check",
        table: "control",
      },
      { kind: "put", record: await auditEventRecord() },
    ]);

    const command = transactions[0]!;
    const organizationCheck = command.input.TransactItems?.find(
      (item) => item.ConditionCheck?.Key?.sk === `ORG#${ORG_ID}`,
    )?.ConditionCheck;
    expect(organizationCheck).toMatchObject({
      ConditionExpression: "#itemType = :itemType AND #data.#status = :active",
      ExpressionAttributeNames: {
        "#data": "data",
        "#itemType": "itemType",
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":active": "active",
        ":itemType": "organization",
      },
    });
    expect(organizationConditionKeys(command)).toEqual([
      { pk: `ORG#${ORG_ID}`, sk: `ORG#${ORG_ID}` },
      { pk: `ORG#${ORG_ID}`, sk: "ORGANIZATION-GATE-LANE#24" },
    ]);
  });

  test("allows only the named erasure owner through the active tenant fence", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);

    await database.transactWriteForErasure!([{ kind: "put", record: await auditEventRecord() }], {
      operationId: EVENT_ID,
      organizationId: ORG_ID,
    });

    const command = transactions[0]!;
    expect(organizationConditionKeys(command)).toEqual([
      { pk: `ORG#${ORG_ID}`, sk: "ORGANIZATION-GATE-LANE#00" },
    ]);
    expect(command.input.TransactItems?.[2]?.ConditionCheck).toEqual({
      ConditionExpression:
        "attribute_exists(pk) AND #gate.#gateFence.#gateFenceOperation = :gateFenceOperation",
      ExpressionAttributeNames: {
        "#gate": "data",
        "#gateFence": "erasureFence",
        "#gateFenceOperation": "operationId",
      },
      ExpressionAttributeValues: { ":gateFenceOperation": EVENT_ID },
      Key: { pk: `ORG#${ORG_ID}`, sk: "ORGANIZATION-GATE-LANE#00" },
      TableName: "control",
    });
  });

  test("makes a contradictory organization condition fail closed at DynamoDB", async () => {
    const { client, transactions } = recordingClient();
    const database = makeDynamoDatabase(client);

    await database.transactWrite([
      {
        conditionExpression: "attribute_not_exists(pk)",
        key: {
          pk: `ORG#${ORG_ID}`,
          sk: `ORG#${ORG_ID}`,
        },
        kind: "condition-check",
        table: "control",
      },
      { kind: "put", record: await auditEventRecord() },
    ]);

    const command = transactions[0]!;
    const organizationCheck = command.input.TransactItems?.find(
      (item) => item.ConditionCheck?.Key?.sk === `ORG#${ORG_ID}`,
    )?.ConditionCheck;
    expect(organizationCheck?.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(organizationConditionKeys(command)).toEqual([
      { pk: `ORG#${ORG_ID}`, sk: `ORG#${ORG_ID}` },
      { pk: `ORG#${ORG_ID}`, sk: "ORGANIZATION-GATE-LANE#24" },
    ]);
    expect(
      command.input.TransactItems?.find((item) =>
        item.ConditionCheck?.Key?.sk?.startsWith("ORGANIZATION-GATE-LANE#"),
      )?.ConditionCheck?.ConditionExpression,
    ).toBe(TENANT_GATE_LANE_CONDITION);
  });
});
