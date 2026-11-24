import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import { makeDynamoDatabase } from "./client.ts";

describe("DynamoDatabase getRecord", () => {
  test("sends only the table primary key when given canonical projection keys", async () => {
    const commands: Array<{ readonly input: unknown }> = [];
    const client = {
      send: async (command: { readonly input: unknown }) => {
        commands.push(command);
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const database = makeDynamoDatabase(client);
    const canonicalKeys = {
      gsi1pk: "MEMORY-SEARCH-OPERATION#0",
      gsi1sk: "2026-07-31T00:00:00.000Z#operation",
      pk: "ORG#organization",
      sk: "MEMORY-SEARCH-PROVISIONING#operation",
    };

    const result = await database.getRecord("control", canonicalKeys, true);

    expect(result).toBeUndefined();
    expect(commands).toHaveLength(1);
    expect(commands[0]!.input).toMatchObject({
      ConsistentRead: true,
      Key: {
        pk: "ORG#organization",
        sk: "MEMORY-SEARCH-PROVISIONING#operation",
      },
      TableName: "control",
    });
    expect((commands[0]!.input as { Key: object }).Key).not.toHaveProperty("gsi1pk");
    expect((commands[0]!.input as { Key: object }).Key).not.toHaveProperty("gsi1sk");
  });
});
