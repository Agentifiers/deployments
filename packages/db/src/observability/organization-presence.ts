import {
  BatchGetItemCommand,
  type BatchGetItemCommandOutput,
  type DynamoDBClient,
  type KeysAndAttributes,
} from "@aws-sdk/client-dynamodb";
import { key } from "../keys.ts";

const BATCH_GET_ITEM_LIMIT = 100;
const MAX_BATCH_ATTEMPTS = 5;

export const observabilityOrganizationPresence = {
  /** Returns the subset of `organizationIds` whose control-table organization row still exists. */
  async existing(
    client: DynamoDBClient,
    tableName: string,
    organizationIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const organizationByKey = new Map<string, string>();
    for (const organizationId of organizationIds) {
      organizationByKey.set(key("ORG", organizationId), organizationId);
    }
    const keys = [...organizationByKey.keys()];
    const present = new Set<string>();
    for (let offset = 0; offset < keys.length; offset += BATCH_GET_ITEM_LIMIT) {
      let pending: KeysAndAttributes | undefined = {
        ConsistentRead: true,
        Keys: keys
          .slice(offset, offset + BATCH_GET_ITEM_LIMIT)
          .map((organizationKey) => ({ pk: { S: organizationKey }, sk: { S: organizationKey } })),
        ProjectionExpression: "pk",
      };
      for (let attempt = 0; pending?.Keys?.length; attempt += 1) {
        if (attempt === MAX_BATCH_ATTEMPTS) {
          throw new Error("DynamoDB left organization presence keys unprocessed.");
        }
        if (attempt > 0) {
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 50 * 2 ** attempt);
          await promise;
        }
        const output: BatchGetItemCommandOutput = await client.send(
          new BatchGetItemCommand({ RequestItems: { [tableName]: pending } }),
        );
        for (const item of output.Responses?.[tableName] ?? []) {
          const organizationId = item.pk?.S ? organizationByKey.get(item.pk.S) : undefined;
          if (organizationId) present.add(organizationId);
        }
        pending = output.UnprocessedKeys?.[tableName];
      }
    }
    return present;
  },
};
