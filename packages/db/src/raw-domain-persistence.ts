import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type GetCommandInput,
  type PutCommandInput,
  type QueryCommandInput,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";

function makeDocumentPersistenceFacade() {
  return {
    commit(client: DynamoDBDocumentClient, input: TransactWriteCommandInput) {
      return client.send(new TransactWriteCommand(input));
    },
    find(client: DynamoDBDocumentClient, input: QueryCommandInput) {
      return client.send(new QueryCommand(input));
    },
    read(client: DynamoDBDocumentClient, input: GetCommandInput) {
      return client.send(new GetCommand(input));
    },
    write(client: DynamoDBDocumentClient, input: PutCommandInput) {
      return client.send(new PutCommand(input));
    },
  };
}

export const agentEmailMaintenanceDocumentPersistence = makeDocumentPersistenceFacade();
export const channelProviderDocumentPersistence = makeDocumentPersistenceFacade();
