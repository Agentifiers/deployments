import { expect, test } from "bun:test";
import type { BatchGetItemCommandInput, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { observabilityOrganizationPresence } from "./organization-presence.ts";

function organizationId(index: number) {
  return `01ARZ3NDEKTSV4RRFFQ69G${String(index).padStart(4, "0")}`;
}

test("reports only organizations whose control row exists across chunks and unprocessed keys", async () => {
  const stored = new Set([organizationId(1), organizationId(150)]);
  const requests: BatchGetItemCommandInput[] = [];
  let deferredOnce = false;
  const client = {
    send: async (command: { input: BatchGetItemCommandInput }) => {
      requests.push(command.input);
      const request = command.input.RequestItems!.control!;
      const keys = request.Keys ?? [];
      // DynamoDB may defer part of a batch; the facade must retry it.
      const unprocessed = deferredOnce
        ? []
        : keys.filter((key) => key.pk?.S === `ORG#${organizationId(1)}`);
      deferredOnce ||= unprocessed.length > 0;
      const processed = keys.filter((key) => !unprocessed.includes(key));
      return {
        Responses: {
          control: processed
            .filter((key) => stored.has(key.pk!.S!.slice("ORG#".length)))
            .map((key) => ({ pk: key.pk! })),
        },
        ...(unprocessed.length > 0
          ? { UnprocessedKeys: { control: { ...request, Keys: unprocessed } } }
          : {}),
      };
    },
  } as unknown as DynamoDBClient;
  const requested = Array.from({ length: 160 }, (_, index) => organizationId(index));

  const present = await observabilityOrganizationPresence.existing(client, "control", [
    ...requested,
    organizationId(1),
  ]);

  expect(present).toEqual(new Set([organizationId(1), organizationId(150)]));
  expect(requests.map((request) => request.RequestItems!.control!.Keys!.length)).toEqual([
    100, 1, 60,
  ]);
  expect(requests[0]!.RequestItems!.control).toMatchObject({
    ConsistentRead: true,
    ProjectionExpression: "pk",
  });
  expect(requests[0]!.RequestItems!.control!.Keys![0]).toEqual({
    pk: { S: `ORG#${organizationId(0)}` },
    sk: { S: `ORG#${organizationId(0)}` },
  });
});
