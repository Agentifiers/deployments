import { DynamoDBDocumentClient, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import { makeDynamoDatabase } from "./client.ts";

describe("DynamoDatabase transaction condition checks", () => {
  test("sends only the table primary key when given canonical projection keys", async () => {
    const commands: unknown[] = [];
    const client = {
      send: async (command: unknown) => {
        commands.push(command);
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const database = makeDynamoDatabase(client);
    const canonicalKeys = {
      gsi2pk: "MEMORY-SEARCH-TARGET#target",
      gsi2sk: "MEMORY-PROVIDER-MUTATION-CLAIM#claim",
      pk: "ORG#organization",
      sk: "MEMORY-PROVIDER-MUTATION-CLAIM#target#claim",
    };

    await database.transactWrite([
      {
        conditionExpression: "attribute_exists(pk)",
        key: canonicalKeys,
        kind: "condition-check",
        table: "control",
      },
    ]);

    expect(commands).toHaveLength(1);
    const command = commands[0] as TransactWriteCommand;
    expect(command.input.TransactItems?.[0]?.ConditionCheck?.Key).toEqual({
      pk: "ORG#organization",
      sk: "MEMORY-PROVIDER-MUTATION-CLAIM#target#claim",
    });
  });
});
