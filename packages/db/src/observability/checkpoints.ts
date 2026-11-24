import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GetItemCommand,
  PutItemCommand,
  type GetItemCommandInput,
  type PutItemCommandInput,
} from "@aws-sdk/client-dynamodb";

export const observabilityCheckpointPersistence = {
  read(client: DynamoDBClient, input: GetItemCommandInput) {
    return client.send(new GetItemCommand(input));
  },
  write(client: DynamoDBClient, input: PutItemCommandInput) {
    return client.send(new PutItemCommand(input));
  },
};
