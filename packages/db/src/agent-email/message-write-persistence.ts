import { MAX_AGENT_EMAIL_ATTACHMENTS } from "@deployments-ai/agent-email";
import type {
  AgentEmailRepositoryContext,
  PersistAgentEmailMessageInput,
} from "./persistence-context.ts";
import { AgentEmailQuotaExceededError } from "./persistence-context.ts";
import { outboundQuotaCounter, readOutboundQuota } from "./outbound-quota.ts";
import {
  inboxAttachmentRecord,
  inboxDraftRecord,
  inboxMessageCreatedIndexRecord,
  inboxMessageRecord,
  inboxMessageThreadAliasRecord,
  inboxMessageThreadIndexRecord,
  inboxResourceLocatorRecord,
  inboxThreadCreatedIndexRecord,
  inboxThreadRecord,
  inboxUsageMeterRecord,
} from "./record-mapping.ts";
import type { TransactionOperation } from "../client-types.ts";
import { InboxMailErasedError } from "../thread-erasure/fences.ts";
import { inboxMessageTombstoneKey } from "../thread-erasure/record-keys.ts";
import { messageAddresses } from "./mail-subjects.ts";

export const MAX_INLINE_MESSAGE_BODY_BYTES = 256 * 1024;
const MAX_MESSAGE_USAGE_EVENTS = 3;

export function makeAgentEmailMessageWriteRepository(context: AgentEmailRepositoryContext) {
  const {
    createWithEvent,
    database,
    failure,
    getMessage,
    getThread,
    inScope,
    mergeThreadRecord,
    run,
    scope,
    updateVersion,
  } = context;

  return {
    async persistMessage(input: PersistAgentEmailMessageInput) {
      if (input.thread && input.thread.inboxId !== input.message.inboxId) {
        throw failure(
          "persist-message",
          new Error("Message and thread must belong to the same inbox."),
        );
      }
      const inlineBodyBytes =
        (input.bodyReferences?.htmlBodyRef
          ? 0
          : Buffer.byteLength(input.message.htmlBody ?? "", "utf8")) +
        (input.bodyReferences?.textBodyRef
          ? 0
          : Buffer.byteLength(input.message.textBody ?? "", "utf8"));
      if (inlineBodyBytes > MAX_INLINE_MESSAGE_BODY_BYTES) {
        throw failure(
          "persist-message",
          new Error("Message bodies larger than 256 KiB must be stored in S3."),
        );
      }
      if ((input.attachments?.length ?? 0) > MAX_AGENT_EMAIL_ATTACHMENTS) {
        throw failure(
          "persist-message",
          new Error(`Messages support at most ${MAX_AGENT_EMAIL_ATTACHMENTS} attachments.`),
        );
      }
      if (input.usage.length > MAX_MESSAGE_USAGE_EVENTS) {
        throw failure(
          "persist-message",
          new Error(`Messages support at most ${MAX_MESSAGE_USAGE_EVENTS} usage events.`),
        );
      }
      const existingMessage = await getMessage(input.message.inboxId, input.message.id);
      if (existingMessage) return existingMessage;
      if (
        await run(
          "get-message-tombstone",
          database.getRecord(
            "execution",
            inboxMessageTombstoneKey(scope.organizationId, input.message.id),
          ),
        )
      ) {
        throw new InboxMailErasedError(new Error(`Inbox message ${input.message.id} was erased.`));
      }
      const participants = await context.mailSubjects.participantsFor(
        input.message.inboxId,
        messageAddresses(input.message),
      );
      const quotaOperation: TransactionOperation[] = [];
      if (input.dailyQuota) {
        const identity = outboundQuotaCounter(
          scope.organizationId,
          scope.environmentId,
          input.dailyQuota.window,
          input.dailyQuota.expiresAt,
        );
        const currentQuota = await readOutboundQuota(context, input.dailyQuota.window);
        const usage = currentQuota?.data.count ?? input.dailyQuota.observedUsage;
        if (usage >= input.dailyQuota.limit) {
          throw new AgentEmailQuotaExceededError({
            limit: input.dailyQuota.limit,
            message: "The daily outbound email quota has been reached.",
            usage,
          });
        }
        const nextQuota = {
          ...identity,
          data: {
            ...identity.data,
            count: usage + 1,
            version: (currentQuota?.data.version ?? -1) + 1,
          },
        } as typeof identity;
        quotaOperation.push({
          ...(currentQuota
            ? { previousRecord: currentQuota }
            : {
                conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              }),
          kind: "put",
          record: nextQuota,
        });
      }
      const message = inboxMessageRecord(
        scope,
        {
          ...input.message,
          ...(input.thread ? { threadId: input.thread.id } : {}),
        },
        participants.keys,
        input.bodyReferences,
      );
      const messageCreatedIndex = inboxMessageCreatedIndexRecord(scope, input.message);
      const messageThreadIndex = input.thread
        ? inboxMessageThreadIndexRecord(scope, {
            ...input.message,
            threadId: input.thread.id,
          })
        : input.message.threadId
          ? inboxMessageThreadIndexRecord(scope, {
              ...input.message,
              threadId: input.message.threadId,
            })
          : undefined;
      const effectiveThreadId = input.thread?.id ?? input.message.threadId;
      const messageThreadAlias =
        input.message.internetMessageId?.trim() && effectiveThreadId
          ? inboxMessageThreadAliasRecord(scope, {
              ...input.message,
              internetMessageId: input.message.internetMessageId,
              threadId: effectiveThreadId,
            })
          : undefined;
      const existingMessageThreadAlias = messageThreadAlias
        ? await run(
            "get-message-thread-alias",
            database.getRecord(
              "execution",
              { pk: messageThreadAlias.pk, sk: messageThreadAlias.sk },
              true,
            ),
          )
        : undefined;
      if (
        existingMessageThreadAlias &&
        (existingMessageThreadAlias.itemType !== "inbox-message-thread-alias" ||
          !inScope(existingMessageThreadAlias) ||
          existingMessageThreadAlias.data.inboxId !== input.message.inboxId ||
          existingMessageThreadAlias.data.internetMessageId !==
            input.message.internetMessageId?.trim() ||
          existingMessageThreadAlias.data.threadId !== effectiveThreadId)
      ) {
        throw failure(
          "persist-message",
          new Error("The inbound Internet Message-ID is already assigned to another thread."),
        );
      }
      const messageLocator = inboxResourceLocatorRecord(scope, {
        createdAt: input.message.createdAt,
        id: input.message.id,
        inboxId: input.message.inboxId,
        resourceType: "message",
      });
      const attachmentOperations = (input.attachments ?? []).map(
        (attachment, ordinal): TransactionOperation => ({
          kind: "put",
          record: inboxAttachmentRecord(
            scope,
            message.data.id,
            attachment,
            input.message.createdAt,
            ordinal,
          ),
        }),
      );
      const usageOperations = input.usage.map(
        (usage): TransactionOperation => ({
          kind: "put",
          record: inboxUsageMeterRecord(scope, usage),
        }),
      );
      const draftOperation = input.draftTransition
        ? [
            {
              kind: "put" as const,
              previousRecord: input.draftTransition.previous,
              record: updateVersion(
                inboxDraftRecord(
                  scope,
                  input.draftTransition.next,
                  input.draftTransition.previous.data.participantKeys,
                  {
                    ...(input.draftTransition.previous.data.htmlBodyRef
                      ? {
                          htmlBodyRef: input.draftTransition.previous.data.htmlBodyRef,
                        }
                      : {}),
                    ...(input.draftTransition.previous.data.textBodyRef
                      ? {
                          textBodyRef: input.draftTransition.previous.data.textBodyRef,
                        }
                      : {}),
                  },
                ),
                input.draftTransition.previous,
              ),
            },
          ]
        : [];
      if (
        input.draftTransition &&
        (input.draftTransition.previous.data.status !== "approved" ||
          input.draftTransition.next.sentMessageId !== input.message.id ||
          input.draftTransition.next.id !== input.draftTransition.previous.data.id)
      ) {
        throw failure(
          "persist-message",
          new Error("Draft send transitions must atomically claim an approved draft."),
        );
      }
      const previousThread = input.thread
        ? await getThread(input.thread.inboxId, input.thread.id)
        : undefined;
      const threadRecord = input.thread
        ? inboxThreadRecord(scope, input.thread, input.message.threadKey, input.message.clientId)
        : undefined;
      const threadCreatedIndex =
        input.thread && !previousThread
          ? inboxThreadCreatedIndexRecord(scope, input.thread)
          : undefined;
      const threadOperation = threadRecord
        ? [
            {
              kind: "put" as const,
              ...(previousThread
                ? {
                    previousRecord: previousThread,
                    record: updateVersion(
                      mergeThreadRecord(previousThread, threadRecord),
                      previousThread,
                    ),
                  }
                : { record: threadRecord }),
            },
            ...(threadCreatedIndex
              ? [
                  {
                    conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                    kind: "put" as const,
                    record: threadCreatedIndex,
                  },
                ]
              : []),
          ]
        : [];
      const mailResource = {
        createdAt: input.message.createdAt,
        inboxId: input.message.inboxId,
        resourceId: input.message.id,
        resourceType: "message" as const,
      };
      return context.mailSubjects.writeIndexed(mailResource, participants, () =>
        createWithEvent(message, input.event, [
          {
            conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            kind: "put",
            record: messageCreatedIndex,
          },
          {
            conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            kind: "put",
            record: messageLocator,
          },
          ...(messageThreadIndex
            ? [
                {
                  conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                  kind: "put" as const,
                  record: messageThreadIndex,
                },
              ]
            : []),
          ...(messageThreadAlias && !existingMessageThreadAlias
            ? [
                {
                  conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                  kind: "put" as const,
                  record: messageThreadAlias,
                },
              ]
            : []),
          ...quotaOperation,
          ...draftOperation,
          ...threadOperation,
          ...attachmentOperations,
          ...usageOperations,
        ]),
      );
    },
  };
}
