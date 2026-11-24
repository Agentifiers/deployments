import type { DynamoDatabaseService } from "../client-types.ts";
import { key } from "../keys.ts";
import type { PlatformRecord } from "../records/index.ts";

function threadPartition(organizationId: string, threadId: string) {
  return key("ORG", organizationId, "THREAD", threadId);
}

export function makeRunMessagePersistence(database: DynamoDatabaseService) {
  function get(recordKey: { readonly pk: string; readonly sk: string }) {
    return database.getRecord("execution", recordKey, true);
  }

  return {
    async getCompletionEvents(input: {
      readonly organizationId: string;
      readonly runId: string;
      readonly sequence: number;
    }): Promise<readonly PlatformRecord[]> {
      const sequence = String(input.sequence).padStart(16, "0");
      const page = await database.queryRecords("execution", {
        ConsistentRead: true,
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": key("ORG", input.organizationId, "RUN", input.runId),
          ":prefix": key("TIMELINE-EVENT", sequence),
        },
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
        Limit: 2,
      });
      return page.items;
    },

    getMessage(input: {
      readonly messageId: string;
      readonly organizationId: string;
      readonly sequence: number;
      readonly threadId: string;
    }): Promise<PlatformRecord | undefined> {
      return get({
        pk: threadPartition(input.organizationId, input.threadId),
        sk: key("MESSAGE", String(input.sequence).padStart(16, "0"), input.messageId),
      });
    },

    getRun(input: {
      readonly idempotencyKey: string;
      readonly organizationId: string;
      readonly threadId: string;
    }): Promise<PlatformRecord | undefined> {
      return get({
        pk: threadPartition(input.organizationId, input.threadId),
        sk: key("RUN", input.idempotencyKey),
      });
    },

    getRunLookup(input: {
      readonly organizationId: string;
      readonly runId: string;
      readonly threadId: string;
    }): Promise<PlatformRecord | undefined> {
      return get({
        pk: threadPartition(input.organizationId, input.threadId),
        sk: key("RUN-LOOKUP", input.runId),
      });
    },
  };
}
