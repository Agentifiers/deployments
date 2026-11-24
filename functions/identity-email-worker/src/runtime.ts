import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  makeDynamoDatabase,
  makeIdentityRepository,
  tableNamesFromEnvironment,
} from "@deployments-ai/db";

export function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export const database = makeDynamoDatabase(
  DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  }),
  tableNamesFromEnvironment(),
);
export const repository = makeIdentityRepository(database);
