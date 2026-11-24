import type { AgentEmailRepositoryContext } from "./persistence-context.ts";
import { key } from "../keys.ts";
import { type PlatformRecord } from "../records/index.ts";

type CreatedIndexRecord = Extract<
  PlatformRecord,
  {
    readonly itemType:
      | "inbox-draft-created-index"
      | "inbox-message-created-index"
      | "inbox-message-thread-index"
      | "inbox-thread-created-index";
  }
>;

export function makeAgentEmailMessageReadRepository(context: AgentEmailRepositoryContext) {
  const {
    allPages,
    database,
    failure,
    getDraft,
    getMessage,
    getThread,
    inScope,
    only,
    queryAggregate,
    run,
    scope,
  } = context;

  async function listHydratedIndexPage<Index extends CreatedIndexRecord, Item>(input: {
    readonly cursor?: { readonly createdAt: string; readonly id: string };
    readonly hydrate: (index: Index) => Promise<Item | undefined>;
    readonly indexes: (records: readonly PlatformRecord[]) => readonly Index[];
    readonly limit: number;
    readonly partitionKey: string;
    readonly query: (exclusiveStartKey: Readonly<Record<string, unknown>> | undefined) => Promise<{
      readonly items: readonly PlatformRecord[];
      readonly lastEvaluatedKey?: Record<string, unknown>;
    }>;
    readonly sortKey: (cursor: { readonly createdAt: string; readonly id: string }) => string;
  }) {
    const hydrated: { readonly index: Index; readonly item: Item }[] = [];
    let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined = input.cursor
      ? {
          pk: input.partitionKey,
          sk: input.sortKey(input.cursor),
        }
      : undefined;
    let hasMoreRecords = false;
    do {
      const result = await input.query(exclusiveStartKey);
      const indexes = input.indexes(result.items);
      const items = await Promise.all(indexes.map(input.hydrate));
      indexes.forEach((index, indexPosition) => {
        const item = items[indexPosition];
        if (item !== undefined) hydrated.push({ index, item });
      });
      hasMoreRecords = result.lastEvaluatedKey !== undefined;
      exclusiveStartKey = result.lastEvaluatedKey;
    } while (hydrated.length <= input.limit && exclusiveStartKey);
    const selected = hydrated.slice(0, input.limit);
    return {
      hasMore: hydrated.length > input.limit || hasMoreRecords,
      items: selected.map(({ item }) => item),
      scannedThrough: selected.at(-1)?.index,
    };
  }

  return {
    async getContentCleanup(resourceId: string, cleanupId: string) {
      const value = await run(
        "get-content-cleanup",
        database.getRecord(
          "execution",
          {
            pk: `ORG#${scope.organizationId}#RESOURCE#${resourceId}`,
            sk: `INBOX-CONTENT-CLEANUP#${cleanupId}`,
          },
          true,
        ),
      );
      return value?.itemType === "inbox-content-cleanup" && inScope(value) ? value : undefined;
    },
    getMessage,
    getThread,
    async listDraftsPage(
      inboxId: string,
      input: {
        readonly cursor?: { readonly createdAt: string; readonly id: string };
        readonly limit: number;
      },
    ) {
      const partitionKey = `ORG#${scope.organizationId}#INBOX#${inboxId}`;
      return listHydratedIndexPage({
        ...input,
        hydrate: async (index) => {
          const draft = await getDraft(inboxId, index.data.id);
          if (!draft) return undefined;
          if (draft.data.createdAt !== index.data.createdAt) {
            throw failure(
              "list-drafts-page",
              new Error("The inbox draft creation index is inconsistent."),
            );
          }
          return draft;
        },
        indexes: (records) =>
          only(records, "inbox-draft-created-index").filter(
            (record) => inScope(record) && record.data.inboxId === inboxId,
          ),
        partitionKey,
        query: (exclusiveStartKey) =>
          run(
            "list-drafts-page",
            database.queryRecords("execution", {
              ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
              ConsistentRead: true,
              ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
              ExpressionAttributeValues: {
                ":pk": partitionKey,
                ":sk": "INBOX-DRAFT-CREATED-INDEX#",
              },
              KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
              Limit: input.limit + 1,
              ScanIndexForward: false,
            }),
          ),
        sortKey: (cursor) => key("INBOX-DRAFT-CREATED-INDEX", cursor.createdAt, cursor.id),
      });
    },
    async listThreadsPage(
      inboxId: string,
      input: {
        readonly cursor?: { readonly createdAt: string; readonly id: string };
        readonly limit: number;
      },
    ) {
      const partitionKey = `ORG#${scope.organizationId}#INBOX#${inboxId}`;
      return listHydratedIndexPage({
        ...input,
        hydrate: async (index) => {
          const thread = await getThread(inboxId, index.data.id);
          if (!thread) return undefined;
          if (thread.data.createdAt !== index.data.createdAt) {
            throw failure(
              "list-threads-page",
              new Error("The inbox thread creation index is inconsistent."),
            );
          }
          return thread;
        },
        indexes: (records) => only(records, "inbox-thread-created-index").filter(inScope),
        partitionKey,
        query: (exclusiveStartKey) =>
          run(
            "list-threads-page",
            database.queryRecords("execution", {
              ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
              ConsistentRead: true,
              ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
              ExpressionAttributeValues: {
                ":pk": partitionKey,
                ":sk": "INBOX-THREAD-CREATED-INDEX#",
              },
              KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
              Limit: input.limit + 1,
              ScanIndexForward: false,
            }),
          ),
        sortKey: (cursor) => key("INBOX-THREAD-CREATED-INDEX", cursor.createdAt, cursor.id),
      });
    },
    async listMessages(inboxId: string) {
      const items = await allPages("list-messages", (exclusiveStartKey) =>
        queryAggregate(
          database,
          "execution",
          `ORG#${scope.organizationId}#INBOX#${inboxId}`,
          "inbox-message",
          exclusiveStartKey,
        ),
      );
      return only(items, "inbox-message").filter(inScope);
    },

    async listMessagesPage(
      inboxId: string,
      input: {
        readonly cursor?: { readonly createdAt: string; readonly id: string };
        readonly limit: number;
      },
    ) {
      const partitionKey = `ORG#${scope.organizationId}#INBOX#${inboxId}`;
      return listHydratedIndexPage({
        ...input,
        hydrate: async (index) => {
          const message = await getMessage(inboxId, index.data.id);
          if (!message) return undefined;
          if (message.data.createdAt !== index.data.createdAt) {
            throw failure(
              "list-messages-page",
              new Error("The inbox message creation index is inconsistent."),
            );
          }
          return message;
        },
        indexes: (records) => only(records, "inbox-message-created-index").filter(inScope),
        partitionKey,
        query: (exclusiveStartKey) =>
          run(
            "list-messages-page",
            database.queryRecords("execution", {
              ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
              ConsistentRead: true,
              ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
              ExpressionAttributeValues: {
                ":pk": partitionKey,
                ":sk": "INBOX-MESSAGE-CREATED-INDEX#",
              },
              KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
              Limit: input.limit + 1,
              ScanIndexForward: false,
            }),
          ),
        sortKey: (cursor) => key("INBOX-MESSAGE-CREATED-INDEX", cursor.createdAt, cursor.id),
      });
    },

    async listThreadMessagesPage(
      inboxId: string,
      threadId: string,
      input: {
        readonly cursor?: { readonly createdAt: string; readonly id: string };
        readonly limit: number;
      },
    ) {
      const partitionKey = `ORG#${scope.organizationId}#THREAD#${threadId}`;
      return listHydratedIndexPage({
        ...input,
        hydrate: async (index) => {
          const message = await getMessage(inboxId, index.data.id);
          if (!message) return undefined;
          if (
            message.data.threadId !== threadId ||
            message.data.createdAt !== index.data.createdAt
          ) {
            throw failure(
              "list-thread-messages-page",
              new Error("The thread message index is inconsistent."),
            );
          }
          return message;
        },
        indexes: (records) =>
          only(records, "inbox-message-thread-index").filter(
            (record) =>
              inScope(record) &&
              record.data.inboxId === inboxId &&
              record.data.threadId === threadId,
          ),
        partitionKey,
        query: (exclusiveStartKey) =>
          run(
            "list-thread-messages-page",
            database.queryRecords("execution", {
              ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
              ConsistentRead: true,
              ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
              ExpressionAttributeValues: {
                ":pk": partitionKey,
                ":sk": "INBOX-MESSAGE-THREAD-INDEX#",
              },
              KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
              Limit: input.limit + 1,
              ScanIndexForward: false,
            }),
          ),
        sortKey: (cursor) => key("INBOX-MESSAGE-THREAD-INDEX", cursor.createdAt, cursor.id),
      });
    },

    async listPendingContentCleanups(limit: number) {
      const result = await run(
        "list-pending-content-cleanups",
        database.queryRecords("execution", {
          ExpressionAttributeNames: { "#pk": "gsi1pk" },
          ExpressionAttributeValues: {
            ":pk": `INBOX-CONTENT-CLEANUP#${scope.organizationId}#${scope.projectId}#${scope.environmentId}`,
          },
          IndexName: "gsi1",
          KeyConditionExpression: "#pk = :pk",
          Limit: limit,
        }),
      );
      return only(result.items, "inbox-content-cleanup").filter(
        (record) => inScope(record) && record.data.status === "pending",
      );
    },
  };
}
