import { describe, expect, test } from "bun:test";
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";

import {
  assertCredentialDocumentCurrent,
  putFencedTenantRecord,
  queueMessagePayload,
} from "./runtime.ts";

const scope = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
};

describe("tenant-scoped credential sessions", () => {
  test("rejects expired credential documents at the reader boundary", () => {
    const document = {
      createdAt: "2026-07-26T00:00:00.000Z",
      generation: 1,
      schemaVersion: 1,
      updatedAt: "2026-07-26T00:00:00.000Z",
      values: { token: "secret" },
    } as const;
    expect(() =>
      assertCredentialDocumentCurrent(
        { ...document, expiresAt: "2026-07-26T00:01:00.000Z" },
        Date.parse("2026-07-26T00:01:00.000Z"),
      ),
    ).toThrow("Credential has expired.");
    expect(() =>
      assertCredentialDocumentCurrent(
        { ...document, expiresAt: "2026-07-26T00:02:00.000Z" },
        Date.parse("2026-07-26T00:01:00.000Z"),
      ),
    ).not.toThrow();
  });

  test("fences scoped audit writes and requires the organization to remain canonical", async () => {
    const commands: unknown[] = [];
    await putFencedTenantRecord(
      {
        send: async (command: unknown) => {
          commands.push(command);
          return {};
        },
      } as unknown as DynamoDBDocumentClient,
      scope,
      {
        data: { organizationId: scope.organizationId },
        itemType: "audit-event",
        pk: "audit-pk",
        sk: "audit-sk",
      } as never,
      "events",
    );

    expect(commands).toHaveLength(2);
    expect(commands[0]).toBeInstanceOf(GetCommand);
    expect((commands[0] as GetCommand).input).toEqual({
      ConsistentRead: true,
      Key: {
        pk: "GLOBAL#deploy-migration",
        sk: "DEPLOY-MIGRATION#governance-inventory-shard-writes",
      },
      TableName: "control",
    });
    const command = commands[1] as TransactWriteCommand;
    expect(command).toBeInstanceOf(TransactWriteCommand);
    expect(command.input.TransactItems?.[0]?.ConditionCheck).toMatchObject({
      ConditionExpression:
        "attribute_not_exists(pk) OR #fenceData.#fenceLeaseExpiresAt <= :fenceObservedAt",
      ExpressionAttributeNames: {
        "#fenceData": "data",
        "#fenceLeaseExpiresAt": "leaseExpiresAt",
      },
      Key: {
        pk: `ORG#${scope.organizationId}`,
        sk: `ERASURE-FENCE#${scope.organizationId}`,
      },
    });
    expect(
      Date.parse(
        String(
          command.input.TransactItems?.[0]?.ConditionCheck?.ExpressionAttributeValues?.[
            ":fenceObservedAt"
          ],
        ),
      ),
    ).toBeNumber();
    expect(command.input.TransactItems?.[1]?.ConditionCheck).toMatchObject({
      ConditionExpression: "attribute_exists(pk)",
      Key: {
        pk: `ORG#${scope.organizationId}`,
        sk: `ORG#${scope.organizationId}`,
      },
    });
    expect(command.input.TransactItems?.[2]?.Put).toMatchObject({
      Item: { itemType: "audit-event", pk: "audit-pk", sk: "audit-sk" },
      TableName: "events",
    });
    expect(command.input.TransactItems?.[3]?.Put).toMatchObject({
      Item: {
        data: {
          organizationId: scope.organizationId,
          recordPk: "audit-pk",
          recordSk: "audit-sk",
          recordTable: "events",
        },
        itemType: "governance-tenant-record",
        pk: `ORG#${scope.organizationId}#GOVERNANCE-INVENTORY`,
      },
      TableName: "control",
    });
  });

  test("uses semantic-event tenant scope instead of duplicate payload fields", () => {
    expect(
      queueMessagePayload(
        JSON.stringify({
          detail: {
            environmentId: scope.environmentId,
            organizationId: scope.organizationId,
            payload: {
              environmentId: "attacker-environment",
              organizationId: "attacker-organization",
              projectId: "attacker-project",
              provider: "slack_edge",
            },
            projectId: scope.projectId,
          },
        }),
      ),
    ).toEqual({ ...scope, provider: "slack_edge" });
  });
});
