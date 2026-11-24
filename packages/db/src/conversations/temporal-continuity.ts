import type { DynamoDatabaseService } from "../client-types.ts";
import {
  conversationMessageIsNonReplayable,
  conversationMessageIsTransient,
} from "../conversation-message-visibility.ts";
import { key } from "../keys.ts";
import type { PlatformRecord } from "../records/index.ts";
import {
  InvalidConversationContinuityError,
  validatedConversationPredecessorLineage,
  type ConversationContinuationScope,
  type ConversationContinuationThread,
} from "./continuation-ancestry.ts";
export type { ConversationContinuationScope } from "./continuation-ancestry.ts";

const MESSAGE_QUERY_LIMIT = 25;
const MAX_MESSAGE_QUERY_PAGES = 128;

type Message = Extract<PlatformRecord, { readonly itemType: "message" }>;

export interface ConversationTemporalAnchor {
  readonly createdAt: string;
  readonly role: "assistant" | "user";
}

function scopedMessage(
  value: Message,
  input: ConversationContinuationScope,
  thread: ConversationContinuationThread,
) {
  if (
    value.data.threadId !== thread.data.id ||
    value.data.environmentId !== input.environmentId ||
    value.data.organizationId !== input.organizationId ||
    value.data.projectId !== input.projectId
  ) {
    throw new InvalidConversationContinuityError(
      "Conversation temporal continuity crossed its canonical message scope.",
    );
  }
  return value;
}

async function replayablePredecessorMessages(
  database: DynamoDatabaseService,
  input: ConversationContinuationScope,
  options: {
    readonly maximumCharacters: number;
    readonly maximumMessages: number;
    readonly maximumPages: number;
    readonly throughCreatedAt?: string;
  },
  signal?: AbortSignal,
): Promise<readonly Message[]> {
  if (options.maximumCharacters <= 0 || options.maximumMessages <= 0 || options.maximumPages <= 0) {
    return [];
  }
  const predecessors = await validatedConversationPredecessorLineage(database, input);
  const descending: Message[] = [];
  let characters = 0;
  let pages = 0;
  for (const { thread, successor, throughCreatedAt } of predecessors) {
    const cutoff = Math.min(
      Date.parse(throughCreatedAt),
      options.throughCreatedAt === undefined ? Infinity : Date.parse(options.throughCreatedAt),
    );
    // The inherited checkpoint records the complete replayable handoff boundary. Later local
    // checkpoints can also cover sequence zero, so locate the inherited row, not the latest row.
    let throughSequence: number | undefined;
    let checkpointCursor: Readonly<Record<string, unknown>> | undefined;
    do {
      if (pages >= Math.min(options.maximumPages, MAX_MESSAGE_QUERY_PAGES)) {
        throw new InvalidConversationContinuityError(
          "Conversation continuity exceeded its bounded predecessor message scan limit.",
        );
      }
      pages += 1;
      const checkpoints = await database.queryRecords(
        "execution",
        {
          ...(checkpointCursor ? { ExclusiveStartKey: checkpointCursor } : {}),
          ConsistentRead: true,
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          ExpressionAttributeValues: {
            ":pk": key("ORG", input.organizationId, "THREAD", successor.data.id),
            ":prefix": `${key("CONVERSATION-CHECKPOINT", "0000000000000000")}#`,
          },
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
          Limit: MESSAGE_QUERY_LIMIT,
          ScanIndexForward: false,
        },
        signal,
      );
      for (const checkpoint of checkpoints.items) {
        if (checkpoint.itemType !== "conversation-checkpoint") continue;
        if (
          checkpoint.data.organizationId !== input.organizationId ||
          checkpoint.data.projectId !== input.projectId ||
          checkpoint.data.environmentId !== input.environmentId ||
          checkpoint.data.threadId !== successor.data.id ||
          checkpoint.data.agentDeploymentId !== successor.data.agentDeploymentId
        ) {
          throw new InvalidConversationContinuityError(
            "Conversation continuity crossed its canonical checkpoint scope.",
          );
        }
        if (checkpoint.data.continuedFromThreadId === undefined) continue;
        if (
          checkpoint.data.continuedFromThreadId !== thread.data.id ||
          checkpoint.data.continuedFromThroughSequence === undefined
        ) {
          throw new InvalidConversationContinuityError(
            "Conversation continuity has an invalid inherited checkpoint boundary.",
          );
        }
        throughSequence = checkpoint.data.continuedFromThroughSequence;
        break;
      }
      checkpointCursor = checkpoints.lastEvaluatedKey;
    } while (throughSequence === undefined && checkpointCursor);
    if (throughSequence === undefined) break;
    const partition = key("ORG", input.organizationId, "THREAD", thread.data.id);
    let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
    do {
      if (pages >= Math.min(options.maximumPages, MAX_MESSAGE_QUERY_PAGES)) {
        throw new InvalidConversationContinuityError(
          "Conversation continuity exceeded its bounded predecessor message scan limit.",
        );
      }
      pages += 1;
      const result = await database.queryRecords(
        "execution",
        {
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ConsistentRead: true,
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          ExpressionAttributeValues: {
            ":pk": partition,
            ":prefix": "MESSAGE#",
            ":maximumSk": key("MESSAGE", String(throughSequence).padStart(16, "0"), "~"),
          },
          KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :prefix AND :maximumSk",
          Limit: MESSAGE_QUERY_LIMIT,
          ScanIndexForward: false,
        },
        signal,
      );
      for (const candidate of result.items) {
        if (candidate.itemType !== "message") continue;
        const message = scopedMessage(candidate, input, thread);
        if (
          !(Date.parse(message.data.createdAt) <= cutoff) ||
          message.data.sequence > throughSequence ||
          (message.data.role !== "assistant" && message.data.role !== "user") ||
          conversationMessageIsTransient(message.data.metadata) ||
          conversationMessageIsNonReplayable(message.data.metadata)
        ) {
          continue;
        }
        descending.push(message);
        characters +=
          message.data.body?.length ?? message.data.bodyRef?.byteSize ?? options.maximumCharacters;
        if (
          characters >= options.maximumCharacters ||
          descending.length >= options.maximumMessages
        ) {
          return descending.reverse();
        }
      }
      exclusiveStartKey = result.lastEvaluatedKey;
    } while (exclusiveStartKey);
  }
  return descending.reverse();
}

export function makeConversationTemporalContinuityPersistence(database: DynamoDatabaseService) {
  return {
    async recentReplayablePredecessorMessages(
      input: ConversationContinuationScope,
      options: {
        readonly maximumCharacters: number;
        readonly maximumMessages: number;
        readonly maximumPages: number;
        readonly throughCreatedAt: string;
      },
      signal?: AbortSignal,
    ): Promise<readonly Message[]> {
      return replayablePredecessorMessages(database, input, options, signal);
    },
    async latestReplayablePredecessorMessage(
      input: ConversationContinuationScope & { readonly throughCreatedAt?: string },
      signal?: AbortSignal,
    ): Promise<ConversationTemporalAnchor | undefined> {
      const messages = await replayablePredecessorMessages(
        database,
        input,
        {
          maximumCharacters: Infinity,
          maximumMessages: 1,
          maximumPages: MAX_MESSAGE_QUERY_PAGES,
          ...(input.throughCreatedAt ? { throughCreatedAt: input.throughCreatedAt } : {}),
        },
        signal,
      );
      const message = messages[0];
      return message && (message.data.role === "assistant" || message.data.role === "user")
        ? { createdAt: message.data.createdAt, role: message.data.role }
        : undefined;
    },
  };
}
