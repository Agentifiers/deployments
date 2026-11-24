import type { AgentEmailDomainEvent, AgentEmailMessageRecord } from "@deployments-ai/agent-email";
import { messageAddresses } from "./mail-subjects.ts";
import { MAX_INLINE_MESSAGE_BODY_BYTES } from "./message-write-persistence.ts";
import type {
  AgentEmailMessageBodyReferenceUpdate,
  AgentEmailRepositoryContext,
} from "./persistence-context.ts";
import {
  inboxAttachmentRecord,
  inboxContentCleanupRecord,
  inboxMessageRecord,
  inboxMessageThreadAliasRecord,
  type AgentEmailAttachmentBlob,
  type AgentEmailContentCleanup,
  type AgentEmailMessageBodyReferences,
} from "./record-mapping.ts";
import type { TransactionOperation } from "../client-types.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";

export function makeAgentEmailMessageUpdateRepository(context: AgentEmailRepositoryContext) {
  const {
    allPages,
    database,
    failure,
    getDraft,
    inScope,
    only,
    queryAggregate,
    queryByEnvironment,
    run,
    scope,
    updateVersion,
    updateWithEvent,
  } = context;

  return {
    async updateMessage(
      previous: Extract<PlatformRecord, { readonly itemType: "inbox-message" }>,
      message: AgentEmailMessageRecord,
      event: AgentEmailDomainEvent,
      bodyReferences?: AgentEmailMessageBodyReferenceUpdate,
      attachments?: readonly AgentEmailAttachmentBlob[],
      cleanup?: AgentEmailContentCleanup,
      prerequisites: readonly TransactionOperation[] = [],
    ) {
      const htmlBodyRef = Object.hasOwn(bodyReferences ?? {}, "htmlBodyRef")
        ? (bodyReferences?.htmlBodyRef ?? undefined)
        : message.htmlBody !== undefined
          ? undefined
          : previous.data.htmlBodyRef;
      const textBodyRef = Object.hasOwn(bodyReferences ?? {}, "textBodyRef")
        ? (bodyReferences?.textBodyRef ?? undefined)
        : message.textBody !== undefined
          ? undefined
          : previous.data.textBodyRef;
      const rawReference = Object.hasOwn(bodyReferences ?? {}, "rawReference")
        ? (bodyReferences?.rawReference ?? undefined)
        : previous.data.rawReference;
      if (previous.data.rawPurgeClaimedAt && Object.hasOwn(bodyReferences ?? {}, "rawReference")) {
        throw failure(
          "update-message",
          new Error("Raw references cannot change while a retention purge is claimed."),
        );
      }
      if (
        previous.data.rawPurgeClaimedAt &&
        (message.rawRetentionExpiresAt !== previous.data.rawRetentionExpiresAt ||
          message.rawPurgedAt !== previous.data.rawPurgedAt)
      ) {
        throw failure(
          "update-message",
          new Error("Raw retention cannot change while a retention purge is claimed."),
        );
      }
      const effectiveBodyReferences: AgentEmailMessageBodyReferences = {
        ...(htmlBodyRef ? { htmlBodyRef } : {}),
        ...(rawReference ? { rawReference } : {}),
        ...(textBodyRef ? { textBodyRef } : {}),
      };
      const inlineBodyBytes =
        (htmlBodyRef ? 0 : Buffer.byteLength(message.htmlBody ?? "", "utf8")) +
        (textBodyRef ? 0 : Buffer.byteLength(message.textBody ?? "", "utf8"));
      if (inlineBodyBytes > MAX_INLINE_MESSAGE_BODY_BYTES) {
        throw failure(
          "update-message",
          new Error("Message bodies larger than 256 KiB must be stored in S3."),
        );
      }
      const mailResource = {
        createdAt: previous.data.createdAt,
        inboxId: previous.data.inboxId,
        resourceId: previous.data.id,
        resourceType: "message" as const,
      };
      const participants = await context.mailSubjects.rekey(
        previous.data.inboxId,
        { addresses: messageAddresses(previous.data), keys: previous.data.participantKeys },
        messageAddresses(message),
      );
      const candidate = inboxMessageRecord(
        scope,
        {
          ...message,
          ...(message.threadId
            ? {}
            : previous.data.threadId
              ? { threadId: previous.data.threadId }
              : {}),
        },
        participants.keys,
        effectiveBodyReferences,
      );
      const next = updateVersion(
        previous.data.rawPurgeClaimedAt
          ? (withCanonicalRecordKeys({
              data: {
                ...candidate.data,
                rawPurgeClaimedAt: previous.data.rawPurgeClaimedAt,
                ...(previous.data.rawPurgeClaimFingerprint
                  ? {
                      rawPurgeClaimFingerprint: previous.data.rawPurgeClaimFingerprint,
                    }
                  : {}),
                ...(previous.data.rawPurgeClaimKey
                  ? { rawPurgeClaimKey: previous.data.rawPurgeClaimKey }
                  : {}),
              },
              itemType: "inbox-message",
            }) as Extract<PlatformRecord, { readonly itemType: "inbox-message" }>)
          : candidate,
        previous,
      );
      const draftOperations: TransactionOperation[] = [];
      const recoversUnknownSendOutcome =
        previous.data.status === "failed" &&
        previous.data.failureCode === "send_outcome_unknown" &&
        ["accepted", "bounced", "complained", "delivered"].includes(next.data.status);
      const terminalDraftStatus =
        next.data.status === "failed"
          ? "failed"
          : ["accepted", "bounced", "complained", "delivered"].includes(next.data.status)
            ? "sent"
            : undefined;
      if (next.data.draftId && terminalDraftStatus) {
        const previousDraft = await getDraft(next.data.inboxId, next.data.draftId);
        if (
          !previousDraft ||
          previousDraft.data.inboxId !== next.data.inboxId ||
          previousDraft.data.sentMessageId !== next.data.id
        ) {
          throw failure(
            "update-message",
            new Error("The sent message draft association is invalid."),
          );
        }
        const allowedStatuses =
          terminalDraftStatus === "failed"
            ? ["queued", "scheduled", "sent"]
            : ["queued", "scheduled", ...(recoversUnknownSendOutcome ? (["failed"] as const) : [])];
        if (
          previousDraft.data.status !== terminalDraftStatus &&
          !allowedStatuses.includes(previousDraft.data.status)
        ) {
          throw failure(
            "update-message",
            new Error("The sent draft cannot transition from its current status."),
          );
        }
        if (previousDraft.data.status !== terminalDraftStatus) {
          const { failureReason: _failureReason, ...previousDraftData } = previousDraft.data;
          const nextDraft = updateVersion(
            withCanonicalRecordKeys({
              data: {
                ...previousDraftData,
                ...(terminalDraftStatus === "failed"
                  ? {
                      failureReason: next.data.failureReason ?? "Outbound email delivery failed.",
                    }
                  : {}),
                status: terminalDraftStatus,
                updatedAt: next.data.updatedAt,
              },
              itemType: "inbox-draft" as const,
            }) as Extract<PlatformRecord, { readonly itemType: "inbox-draft" }>,
            previousDraft,
          );
          draftOperations.push({
            kind: "put",
            previousRecord: previousDraft,
            record: nextDraft,
          });
        }
      }
      const attachmentOperations: TransactionOperation[] = [];
      if (attachments) {
        const existingAttachments = only(
          await allPages("list-message-attachments", (exclusiveStartKey) =>
            queryAggregate(
              database,
              "execution",
              `ORG#${scope.organizationId}#INBOX-MESSAGE#${message.id}`,
              "inbox-attachment",
              exclusiveStartKey,
              true,
            ),
          ),
          "inbox-attachment",
        ).filter(inScope);
        const replacementIds = new Set(attachments.map((attachment) => attachment.id));
        const existingAttachmentsById = new Map(
          existingAttachments.map((attachment) => [attachment.data.id, attachment]),
        );
        attachmentOperations.push(
          ...existingAttachments
            .filter((record) => !replacementIds.has(record.data.id))
            .map(
              (record): TransactionOperation => ({
                kind: "delete",
                record,
              }),
            ),
          ...attachments.map((attachment, ordinal): TransactionOperation => {
            const previousAttachment = existingAttachmentsById.get(attachment.id);
            const candidate = inboxAttachmentRecord(
              scope,
              next.data.id,
              attachment,
              previousAttachment?.data.createdAt ?? message.createdAt,
              ordinal,
              next.data.updatedAt,
            );
            return {
              kind: "put",
              ...(previousAttachment
                ? {
                    previousRecord: previousAttachment,
                    record: updateVersion(candidate, previousAttachment),
                  }
                : { record: candidate }),
            };
          }),
        );
      }
      const aliasOperations: TransactionOperation[] = [];
      if (next.data.internetMessageId?.trim() && next.data.threadId) {
        const alias = inboxMessageThreadAliasRecord(scope, {
          createdAt: next.data.createdAt,
          id: next.data.id,
          inboxId: next.data.inboxId,
          internetMessageId: next.data.internetMessageId,
          threadId: next.data.threadId,
        });
        const existingAlias = await run(
          "get-message-thread-alias",
          database.getRecord("execution", { pk: alias.pk, sk: alias.sk }, true),
        );
        if (existingAlias) {
          if (
            existingAlias.itemType !== "inbox-message-thread-alias" ||
            !inScope(existingAlias) ||
            existingAlias.data.inboxId !== next.data.inboxId ||
            existingAlias.data.internetMessageId !== next.data.internetMessageId.trim() ||
            existingAlias.data.messageId !== next.data.id ||
            existingAlias.data.threadId !== next.data.threadId
          ) {
            throw failure(
              "update-message",
              new Error("The outbound Internet Message-ID is already assigned to another thread."),
            );
          }
        } else {
          aliasOperations.push({
            conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            kind: "put",
            record: alias,
          });
        }
      }
      const reputationOperations: TransactionOperation[] = [];
      if (next.data.direction === "outbound") {
        const countedStatuses = new Set(["accepted", "bounced", "complained", "delivered"]);
        const preOutcomeStatuses = new Set(["queued", "scheduled", "sending"]);
        const outboundIncrement =
          (preOutcomeStatuses.has(previous.data.status) || recoversUnknownSendOutcome) &&
          countedStatuses.has(next.data.status)
            ? 1
            : 0;
        const bounceIncrement =
          next.data.status === "bounced" && previous.data.status !== "bounced" ? 1 : 0;
        const complaintIncrement =
          next.data.status === "complained" && previous.data.status !== "complained" ? 1 : 0;
        if (outboundIncrement || bounceIncrement || complaintIncrement) {
          const policies = only(
            await allPages("list-message-reputation-policies", (exclusiveStartKey) =>
              queryByEnvironment(
                database,
                "control",
                scope.environmentId,
                "inbox-policy",
                exclusiveStartKey,
              ),
            ),
            "inbox-policy",
          ).filter(inScope);
          const inboxPolicies = policies.filter(
            (candidatePolicy) => candidatePolicy.data.inboxId === next.data.inboxId,
          );
          const environmentPolicies = policies.filter(
            (candidatePolicy) => !candidatePolicy.data.inboxId,
          );
          const selectedPolicies = inboxPolicies.length > 0 ? inboxPolicies : environmentPolicies;
          if (selectedPolicies.length > 1) {
            throw failure(
              "update-message",
              new Error("The outbound message resolves more than one reputation policy."),
            );
          }
          const selectedPolicy = selectedPolicies[0];
          if (selectedPolicy) {
            const durablePolicy = await run(
              "get-message-reputation-policy",
              database.getRecord("control", { pk: selectedPolicy.pk, sk: selectedPolicy.sk }, true),
            );
            if (
              durablePolicy?.itemType !== "inbox-policy" ||
              !inScope(durablePolicy) ||
              durablePolicy.data.inboxId !== selectedPolicy.data.inboxId
            ) {
              throw failure(
                "update-message",
                new Error("The outbound message reputation policy changed during evaluation."),
              );
            }
            const outboundOutcomeMessageCount =
              (durablePolicy.data.outboundOutcomeMessageCount ?? 0) + outboundIncrement;
            const bounceMessageCount =
              (durablePolicy.data.bounceMessageCount ?? 0) + bounceIncrement;
            const complaintMessageCount =
              (durablePolicy.data.complaintMessageCount ?? 0) + complaintIncrement;
            const bounceExceeded =
              bounceMessageCount > 0 &&
              bounceMessageCount * 10_000 >=
                durablePolicy.data.bounceRateThresholdBasisPoints * outboundOutcomeMessageCount;
            const complaintExceeded =
              complaintMessageCount > 0 &&
              complaintMessageCount * 10_000 >=
                durablePolicy.data.complaintRateThresholdBasisPoints * outboundOutcomeMessageCount;
            const shouldPause =
              durablePolicy.data.sendingStatus === "active" &&
              outboundOutcomeMessageCount > 0 &&
              (bounceExceeded || complaintExceeded);
            const nextPolicy = updateVersion(
              withCanonicalRecordKeys({
                data: {
                  ...durablePolicy.data,
                  bounceMessageCount,
                  complaintMessageCount,
                  outboundOutcomeMessageCount,
                  ...(shouldPause
                    ? {
                        sendingStatus: "paused" as const,
                        sendingStatusReason: bounceExceeded
                          ? "Outbound sending paused after the configured bounce-rate threshold was reached."
                          : "Outbound sending paused after the configured complaint-rate threshold was reached.",
                        updatedAt: next.data.updatedAt,
                      }
                    : {}),
                },
                itemType: "inbox-policy" as const,
              }) as Extract<PlatformRecord, { readonly itemType: "inbox-policy" }>,
              durablePolicy,
            );
            reputationOperations.push({
              kind: "put",
              previousRecord: durablePolicy,
              record: nextPolicy,
            });
          }
        }
      }
      return context.mailSubjects.writeIndexed(mailResource, participants, () =>
        updateWithEvent(previous, next, event, [
          ...prerequisites,
          ...(cleanup
            ? [
                {
                  conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                  kind: "put" as const,
                  record: inboxContentCleanupRecord(scope, cleanup),
                },
              ]
            : []),
          ...draftOperations,
          ...attachmentOperations,
          ...aliasOperations,
          ...reputationOperations,
        ]),
      );
    },
  };
}
