import { describe, expect, test } from "bun:test";
import { DynamoDBDocumentClient, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import { makeDynamoDatabase } from "./client.ts";
import { deviceGrantRecord } from "./identity/record-builders.ts";
import {
  acquireExpiringUniqueClaim,
  makeUniqueClaimRecord,
  uniqueClaimRequirements,
} from "./unique-claims.ts";

const GRANT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never;

describe("expiring unique claims", () => {
  test("carries owner expiration into a logically replaceable claim", async () => {
    const grant = deviceGrantRecord({
      clientId: "deployments-cli",
      createdAt: "2026-07-28T00:00:00.000Z",
      deviceCodeHash: "device-code-hash",
      expiresAt: "2026-07-28T00:10:00.000Z",
      id: GRANT_ID,
      pollingIntervalSeconds: 5,
      requestedScopes: ["offline_access"],
      userCodeHash: "user-code-hash",
    });
    const requirement = uniqueClaimRequirements(grant)[0]!;
    const claim = makeUniqueClaimRecord(requirement, grant.data.createdAt);
    const operation = acquireExpiringUniqueClaim(
      claim as Parameters<typeof acquireExpiringUniqueClaim>[0],
      "2026-07-28T00:00:00.000Z",
    );

    expect(claim.data.expiresAt).toBe(grant.data.expiresAt);
    expect(claim.ttl).toBe(grant.ttl);
    expect(operation.replaceExpired).toBeTrue();
    expect(operation.expressionAttributeValues).toEqual({
      ":uniqueClaimItemType": "unique-claim",
      ":uniqueClaimNow": "2026-07-28T00:00:00.000Z",
    });

    const commands: unknown[] = [];
    const client = {
      send: async (command: unknown) => {
        commands.push(command);
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    await makeDynamoDatabase(client).transactWrite([{ kind: "put", record: grant }, operation]);

    expect(commands[0]).toBeInstanceOf(TransactWriteCommand);
    expect(
      (commands[0] as TransactWriteCommand).input.TransactItems?.find(
        (item) => item.Put?.Item?.itemType === "unique-claim",
      )?.Put?.ConditionExpression,
    ).toBe(operation.conditionExpression);
  });
});
