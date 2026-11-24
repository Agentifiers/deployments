import type { DynamoDatabaseService } from "../client-types.ts";
import {
  conversationMessageIsNonReplayable,
  conversationMessageIsTransient,
} from "../conversation-message-visibility.ts";
import { key } from "../keys.ts";
import type { PlatformRecord } from "../records/index.ts";

const MAX_DYNAMODB_SORT_KEY_BYTES = 1_024;

export class InvalidConversationHistoryCursorError extends Error {
  constructor() {
    super("Conversation history cursor is invalid.");
    this.name = "InvalidConversationHistoryCursorError";
  }
}

export type ConversationRecordLocator =
  | {
      readonly environmentId: string;
      readonly id: string;
      readonly kind: "agent-deployment" | "agent-release" | "workspace";
      readonly organizationId: string;
    }
  | {
      readonly idempotencyKey: string;
      readonly kind: "idempotency";
      readonly organizationId: string;
    }
  | {
      readonly kind: "message";
      readonly messageId: string;
      readonly organizationId: string;
      readonly sequence: number;
      readonly threadId: string;
    }
  | {
      readonly idempotencyKey: string;
      readonly kind: "run";
      readonly organizationId: string;
      readonly threadId: string;
    }
  | {
      readonly childRunId: string;
      readonly kind: "run-delegation";
      readonly organizationId: string;
    }
  | {
      readonly kind: "run-lookup";
      readonly organizationId: string;
      readonly runId: string;
      readonly threadId: string;
    }
  | {
      readonly kind: "thread";
      readonly organizationId: string;
      readonly threadId: string;
    }
  | {
      readonly kind: "trace";
      readonly organizationId: string;
      readonly traceId: string;
    };

export interface ConversationMessagePage {
  readonly items: readonly PlatformRecord[];
  readonly nextCursor?: string;
  readonly upperSk?: string;
}

export interface ConversationHistoryScope {
  readonly organizationId: string;
  readonly threadId: string;
}

export type ConversationCheckpoint = Extract<
  PlatformRecord,
  { readonly itemType: "conversation-checkpoint" }
>;

function validMessageSortKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("MESSAGE#") &&
    new TextEncoder().encode(value).byteLength <= MAX_DYNAMODB_SORT_KEY_BYTES
  );
}

function threadPartition(scope: ConversationHistoryScope) {
  return key("ORG", scope.organizationId, "THREAD", scope.threadId);
}

function decodeCursor(value: string | undefined, partition: string, upperSk?: string) {
  if (value === undefined) return undefined;
  if (!value || value.length > 4_096) throw new InvalidConversationHistoryCursorError();
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const cursor = parsed as Readonly<Record<string, unknown>>;
    const fields = Object.keys(cursor).sort();
    const validFields =
      JSON.stringify(fields) === JSON.stringify(["pk", "sk"]) ||
      JSON.stringify(fields) === JSON.stringify(["pk", "sk", "upperSk"]);
    if (
      !validFields ||
      cursor.pk !== partition ||
      !validMessageSortKey(cursor.sk) ||
      !validMessageSortKey(cursor.upperSk) ||
      (upperSk !== undefined && cursor.upperSk > upperSk)
    ) {
      throw new Error();
    }
    return {
      key: { pk: cursor.pk, sk: cursor.sk },
      upperSk: cursor.upperSk,
    };
  } catch (cause) {
    if (cause instanceof InvalidConversationHistoryCursorError) throw cause;
    throw new InvalidConversationHistoryCursorError();
  }
}

function encodeCursor(value: Readonly<Record<string, unknown>>, upperSk?: string) {
  return Buffer.from(
    JSON.stringify({
      pk: value.pk,
      sk: value.sk,
      ...(upperSk ? { upperSk } : {}),
    }),
    "utf8",
  ).toString("base64url");
}

function locatorKey(locator: ConversationRecordLocator): {
  readonly key: { readonly pk: string; readonly sk: string };
  readonly table: "control" | "events" | "execution";
} {
  switch (locator.kind) {
    case "agent-deployment":
    case "agent-release":
    case "workspace":
      return {
        key: {
          pk: key("ORG", locator.organizationId, "ENV", locator.environmentId),
          sk: key(locator.kind.toUpperCase(), locator.id),
        },
        table: "control",
      };
    case "idempotency":
      return {
        key: {
          pk: key("ORG", locator.organizationId),
          sk: key("IDEMPOTENCY", locator.idempotencyKey),
        },
        table: "events",
      };
    case "message":
      return {
        key: {
          pk: threadPartition(locator),
          sk: key("MESSAGE", String(locator.sequence).padStart(16, "0"), locator.messageId),
        },
        table: "execution",
      };
    case "run":
      return {
        key: {
          pk: threadPartition(locator),
          sk: key("RUN", locator.idempotencyKey),
        },
        table: "execution",
      };
    case "run-delegation":
      return {
        key: {
          pk: key("ORG", locator.organizationId, "RUN", locator.childRunId),
          sk: key("RUN-DELEGATION", locator.childRunId),
        },
        table: "execution",
      };
    case "run-lookup":
      return {
        key: {
          pk: threadPartition(locator),
          sk: key("RUN-LOOKUP", locator.runId),
        },
        table: "execution",
      };
    case "thread":
      return {
        key: {
          pk: threadPartition(locator),
          sk: key("THREAD", locator.threadId),
        },
        table: "execution",
      };
    case "trace":
      return {
        key: {
          pk: key("ORG", locator.organizationId, "TRACE", locator.traceId),
          sk: key("TRACE", locator.traceId),
        },
        table: "execution",
      };
  }
}

export function makeConversationPersistence(database: DynamoDatabaseService) {
  return {
    async get(locator: ConversationRecordLocator): Promise<PlatformRecord | undefined> {
      const location = locatorKey(locator);
      return await database.getRecord(location.table, location.key, true);
    },

    async latestMessage(scope: ConversationHistoryScope): Promise<PlatformRecord | undefined> {
      const partition = threadPartition(scope);
      const result = await database.queryRecords("execution", {
        ConsistentRead: true,
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": partition,
          ":prefix": "MESSAGE#",
        },
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
        Limit: 1,
        ScanIndexForward: false,
      });
      return result.items[0];
    },

    async hasUserMessageAfter(
      scope: ConversationHistoryScope,
      sequence: number,
      signal?: AbortSignal,
    ): Promise<boolean> {
      const partition = threadPartition(scope);
      let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
      do {
        const result = await database.queryRecords(
          "execution",
          {
            ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
            ConsistentRead: true,
            ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
            ExpressionAttributeValues: {
              ":lower": key("MESSAGE", String(sequence).padStart(16, "0"), "~"),
              ":pk": partition,
              ":upper": key("MESSAGE", "~"),
            },
            KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :lower AND :upper",
            Limit: 100,
            ScanIndexForward: true,
          },
          signal,
        );
        if (
          result.items.some(
            (record) =>
              record.itemType === "message" &&
              record.data.sequence > sequence &&
              record.data.role === "user",
          )
        ) {
          return true;
        }
        exclusiveStartKey = result.lastEvaluatedKey;
      } while (exclusiveStartKey);
      return false;
    },

    async latestCheckpoint(
      scope: ConversationHistoryScope,
      maximumSequence = Number.MAX_SAFE_INTEGER,
    ): Promise<ConversationCheckpoint | undefined> {
      const partition = threadPartition(scope);
      const result = await database.queryRecords("execution", {
        ConsistentRead: true,
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": partition,
          ":prefix": "CONVERSATION-CHECKPOINT#",
          ":upper": key(
            "CONVERSATION-CHECKPOINT",
            String(maximumSequence).padStart(16, "0"),
            "~",
            "~",
          ),
        },
        KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :prefix AND :upper",
        Limit: 1,
        ScanIndexForward: false,
      });
      const checkpoint = result.items[0];
      return checkpoint?.itemType === "conversation-checkpoint" ? checkpoint : undefined;
    },

    async causalMessagePage(
      scope: ConversationHistoryScope,
      options: {
        readonly exclusiveStartKey?: Readonly<Record<string, unknown>>;
        readonly limit: number;
        readonly maximumSortKey: string;
      },
    ) {
      return database.queryRecords("execution", {
        ...(options.exclusiveStartKey ? { ExclusiveStartKey: options.exclusiveStartKey } : {}),
        ConsistentRead: true,
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": threadPartition(scope),
          ":prefix": "MESSAGE#",
          ":maximumSk": options.maximumSortKey,
        },
        KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :prefix AND :maximumSk",
        Limit: options.limit,
        ScanIndexForward: false,
      });
    },

    async messagesInSequenceRange(
      scope: ConversationHistoryScope,
      options: {
        readonly afterSequence?: number;
        readonly limit: number;
        readonly throughSequence: number;
      },
    ): Promise<readonly PlatformRecord[]> {
      const partition = threadPartition(scope);
      const firstSequence = Math.max(0, (options.afterSequence ?? -1) + 1);
      const messages: PlatformRecord[] = [];
      let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
      let pages = 0;
      do {
        const result = await database.queryRecords("execution", {
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ConsistentRead: true,
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          ExpressionAttributeValues: {
            ":pk": partition,
            ":lower": key("MESSAGE", String(firstSequence).padStart(16, "0")),
            ":upper": key("MESSAGE", String(options.throughSequence).padStart(16, "0"), "~"),
          },
          KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :lower AND :upper",
          Limit: options.limit,
          ScanIndexForward: true,
        });
        messages.push(
          ...result.items.filter(
            (record) =>
              record.itemType === "message" &&
              !conversationMessageIsTransient(record.data.metadata) &&
              !conversationMessageIsNonReplayable(record.data.metadata),
          ),
        );
        exclusiveStartKey = result.lastEvaluatedKey;
        pages += 1;
      } while (exclusiveStartKey && messages.length < options.limit && pages < 128);
      if (exclusiveStartKey && messages.length < options.limit) {
        throw new Error("Checkpoint message scan exceeded its bounded page limit.");
      }
      return messages.slice(0, options.limit);
    },

    async saveCheckpoint(checkpoint: ConversationCheckpoint): Promise<void> {
      await database.putRecord(checkpoint, "attribute_not_exists(pk) AND attribute_not_exists(sk)");
    },

    async listMessages(
      scope: ConversationHistoryScope,
      options: {
        readonly cursor?: string;
        readonly limit: number;
        readonly upperSk?: string;
      },
    ): Promise<ConversationMessagePage> {
      const partition = threadPartition(scope);
      if (options.upperSk !== undefined && !validMessageSortKey(options.upperSk)) {
        throw new InvalidConversationHistoryCursorError();
      }
      const cursor = decodeCursor(options.cursor, partition, options.upperSk);
      const upperSk = cursor?.upperSk ?? options.upperSk;
      const result = await database.queryRecords("execution", {
        ...(cursor ? { ExclusiveStartKey: cursor.key } : {}),
        ConsistentRead: true,
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": partition,
          ":prefix": "MESSAGE#",
          ...(upperSk ? { ":upper": upperSk } : {}),
        },
        KeyConditionExpression: upperSk
          ? "#pk = :pk AND #sk BETWEEN :prefix AND :upper"
          : "#pk = :pk AND begins_with(#sk, :prefix)",
        Limit: options.limit,
        ScanIndexForward: true,
      });
      return {
        items: result.items,
        ...(result.lastEvaluatedKey
          ? { nextCursor: encodeCursor(result.lastEvaluatedKey, upperSk) }
          : {}),
        ...(upperSk ? { upperSk } : {}),
      };
    },
  };
}
