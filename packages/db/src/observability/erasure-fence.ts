import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { Schema } from "effect";
import { key } from "../keys.ts";
import { ErasureFenceRecord, GovernanceOperationRecord } from "../records/governance.ts";

export interface ObservabilityErasureFence {
  readonly createdAt: string;
  readonly leaseExpiresAt?: string;
  readonly operationId: string;
  readonly organizationId: string;
}

export const observabilityErasureFence = {
  async read(
    client: DynamoDBClient,
    tableName: string,
    organizationId: string,
  ): Promise<ObservabilityErasureFence | undefined> {
    const output = await client.send(
      new GetItemCommand({
        ConsistentRead: true,
        Key: {
          pk: { S: key("ORG", organizationId) },
          sk: { S: key("ERASURE-FENCE", organizationId) },
        },
        TableName: tableName,
      }),
    );
    if (!output.Item) return undefined;
    const record = Schema.decodeUnknownSync(ErasureFenceRecord)(unmarshall(output.Item));
    return {
      createdAt: record.data.createdAt,
      ...(record.data.leaseExpiresAt ? { leaseExpiresAt: record.data.leaseExpiresAt } : {}),
      operationId: record.data.operationId,
      organizationId: record.data.organizationId,
    };
  },
  async conversationErasureRunning(
    client: DynamoDBClient,
    tableName: string,
    organizationId: string,
    operationId: string,
  ): Promise<boolean> {
    const output = await client.send(
      new GetItemCommand({
        ConsistentRead: true,
        Key: {
          pk: { S: key("ORG", organizationId) },
          sk: { S: key("GOVERNANCE-OPERATION", operationId) },
        },
        TableName: tableName,
      }),
    );
    if (!output.Item) return false;
    const { data } = Schema.decodeUnknownSync(GovernanceOperationRecord)(unmarshall(output.Item));
    return (
      data.organizationId === organizationId &&
      data.status === "running" &&
      (data.kind === "thread-erasure" || data.kind === "end-user-erasure")
    );
  },
};
