import type {
  AgentEmailDraftRecord,
  AgentEmailPolicyRecord,
  AgentEmailUsageEventRecord,
} from "@deployments-ai/agent-email";
import type {
  AgentEmailDraftBodyReferenceUpdate,
  AgentEmailPolicyInboxUpdate,
  AgentEmailRepositoryContext,
} from "./persistence-context.ts";
import { outboundQuotaCounter, readOutboundQuota } from "./outbound-quota.ts";
import {
  inboxContentCleanupRecord,
  inboxDraftCreatedIndexRecord,
  inboxDraftRecord,
  inboxPolicyRecord,
  inboxResourceLocatorRecord,
  inboxUsageMeterRecord,
  type AgentEmailContentCleanup,
  type AgentEmailDraftBodyReferences,
} from "./record-mapping.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";

const MAX_INLINE_MESSAGE_BODY_BYTES = 256 * 1024;

export function makeAgentEmailDraftAndCleanupRepository(context: AgentEmailRepositoryContext) {
  const { database, failure, getDraft, getEnvironmentRecord, run, scope, updateVersion } = context;

  return {
    async completeContentCleanup(
      previous: Extract<PlatformRecord, { readonly itemType: "inbox-content-cleanup" }>,
      completedAt: string,
    ) {
      const expiresAt = new Date(Date.parse(completedAt) + 30 * 24 * 60 * 60 * 1_000).toISOString();
      const next = updateVersion(
        withCanonicalRecordKeys({
          data: {
            ...previous.data,
            expiresAt,
            status: "completed" as const,
            updatedAt: completedAt,
          },
          itemType: "inbox-content-cleanup" as const,
          ttl: Math.floor(Date.parse(expiresAt) / 1_000),
        }) as Extract<PlatformRecord, { readonly itemType: "inbox-content-cleanup" }>,
        previous,
      );
      await run(
        "complete-content-cleanup",
        database.transactWrite([{ kind: "put", previousRecord: previous, record: next }]),
      );
      return next;
    },

    async cancelScheduledDraft(
      previousDraft: Extract<PlatformRecord, { readonly itemType: "inbox-draft" }>,
      draft: AgentEmailDraftRecord,
      previousMessage: Extract<PlatformRecord, { readonly itemType: "inbox-message" }>,
    ) {
      if (
        previousDraft.data.status !== "scheduled" ||
        draft.status !== "cancelled" ||
        previousDraft.data.sentMessageId !== previousMessage.data.id ||
        draft.sentMessageId !== previousMessage.data.id ||
        previousDraft.data.inboxId !== previousMessage.data.inboxId ||
        previousMessage.data.status !== "scheduled" ||
        !previousMessage.data.scheduledAt
      ) {
        throw failure(
          "cancel-scheduled-draft",
          new Error("Scheduled draft cancellation does not match a sendable persisted message."),
        );
      }
      const nextDraft = updateVersion(
        inboxDraftRecord(scope, draft, previousDraft.data.participantKeys, {
          ...(previousDraft.data.htmlBodyRef
            ? { htmlBodyRef: previousDraft.data.htmlBodyRef }
            : {}),
          ...(previousDraft.data.textBodyRef
            ? { textBodyRef: previousDraft.data.textBodyRef }
            : {}),
        }),
        previousDraft,
      );
      const nextMessage = updateVersion(
        withCanonicalRecordKeys({
          data: {
            ...previousMessage.data,
            failureCode: "cancelled",
            failureReason: "The scheduled draft was cancelled before delivery.",
            status: "failed" as const,
            updatedAt: draft.updatedAt,
          },
          itemType: "inbox-message" as const,
        }) as Extract<PlatformRecord, { readonly itemType: "inbox-message" }>,
        previousMessage,
      );
      const quotaWindow = previousMessage.data.scheduledAt.slice(0, 10);
      const quotaExpiresAt = new Date(
        Date.parse(`${quotaWindow}T00:00:00.000Z`) + 24 * 60 * 60 * 1_000,
      ).toISOString();
      const quotaIdentity = outboundQuotaCounter(
        scope.organizationId,
        scope.environmentId,
        quotaWindow,
        quotaExpiresAt,
      );
      const persistedQuota = await run(
        "get-outbound-quota",
        database.getRecord("usage", { pk: quotaIdentity.pk, sk: quotaIdentity.sk }, true),
      );
      const currentQuota =
        persistedQuota?.itemType === "rate-limit-counter" ? persistedQuota : undefined;
      const nextQuota =
        currentQuota && currentQuota.data.count > 0
          ? {
              ...currentQuota,
              data: {
                ...currentQuota.data,
                count: currentQuota.data.count - 1,
                organizationId: scope.organizationId,
                version: currentQuota.data.version + 1,
              },
            }
          : undefined;
      const usageCorrection = inboxUsageMeterRecord(scope, {
        ...(previousMessage.data.clientId ? { clientId: previousMessage.data.clientId } : {}),
        createdAt: previousMessage.data.scheduledAt,
        id: previousMessage.data.id,
        inboxId: previousMessage.data.inboxId,
        kind: "outbound_message",
        messageId: previousMessage.data.id,
        organizationId: previousMessage.data.organizationId,
        quantity: -1,
      });
      await run(
        "cancel-scheduled-draft",
        database.transactWrite([
          { kind: "put", previousRecord: previousDraft, record: nextDraft },
          { kind: "put", previousRecord: previousMessage, record: nextMessage },
          ...(currentQuota && nextQuota
            ? [
                {
                  kind: "put" as const,
                  previousRecord: currentQuota,
                  record: nextQuota,
                },
              ]
            : []),
          {
            conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            kind: "put",
            record: usageCorrection,
          },
        ]),
      );
      return nextDraft;
    },
    getDraft,
    getOutboundQuota: (window: string) => readOutboundQuota(context, window),
    async putDraft(
      draft: AgentEmailDraftRecord,
      bodyReferences?: AgentEmailDraftBodyReferenceUpdate,
      cleanup?: AgentEmailContentCleanup,
    ) {
      const inlineBodyBytes =
        (bodyReferences?.htmlBodyRef ? 0 : Buffer.byteLength(draft.htmlBody ?? "", "utf8")) +
        (bodyReferences?.textBodyRef ? 0 : Buffer.byteLength(draft.textBody ?? "", "utf8"));
      if (inlineBodyBytes > MAX_INLINE_MESSAGE_BODY_BYTES) {
        throw failure(
          "persist-draft",
          new Error("Draft bodies larger than 256 KiB must be stored in S3."),
        );
      }
      const previous = await getDraft(draft.inboxId, draft.id);
      const htmlBodyRef = Object.hasOwn(bodyReferences ?? {}, "htmlBodyRef")
        ? (bodyReferences?.htmlBodyRef ?? undefined)
        : draft.htmlBody !== undefined
          ? undefined
          : previous?.data.htmlBodyRef;
      const textBodyRef = Object.hasOwn(bodyReferences ?? {}, "textBodyRef")
        ? (bodyReferences?.textBodyRef ?? undefined)
        : draft.textBody !== undefined
          ? undefined
          : previous?.data.textBodyRef;
      const effectiveBodyReferences: AgentEmailDraftBodyReferences = {
        ...(htmlBodyRef ? { htmlBodyRef } : {}),
        ...(textBodyRef ? { textBodyRef } : {}),
      };
      const mailResource = {
        createdAt: draft.createdAt,
        inboxId: draft.inboxId,
        resourceId: draft.id,
        resourceType: "draft" as const,
      };
      const addresses = [...draft.toAddresses, ...draft.ccAddresses, ...draft.bccAddresses];
      const participants = previous
        ? await context.mailSubjects.rekey(
            draft.inboxId,
            {
              addresses: [
                ...previous.data.recipients,
                ...previous.data.ccAddresses,
                ...previous.data.bccAddresses,
              ],
              keys: previous.data.participantKeys,
            },
            addresses,
          )
        : await context.mailSubjects.participantsFor(draft.inboxId, addresses);
      const next = inboxDraftRecord(scope, draft, participants.keys, effectiveBodyReferences);
      if (!previous) {
        const createdIndex = inboxDraftCreatedIndexRecord(scope, draft);
        await context.mailSubjects.writeIndexed(mailResource, participants, () =>
          run(
            "create-draft",
            database.transactWrite([
              { kind: "put", record: next },
              {
                conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                kind: "put",
                record: createdIndex,
              },
              {
                conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                kind: "put",
                record: inboxResourceLocatorRecord(scope, {
                  createdAt: draft.createdAt,
                  id: draft.id,
                  inboxId: draft.inboxId,
                  resourceType: "draft",
                }),
              },
            ]),
          ),
        );
        return next;
      }
      const updated = updateVersion(next, previous);
      await context.mailSubjects.writeIndexed(mailResource, participants, () =>
        run(
          "update-draft",
          database.transactWrite([
            { kind: "put", previousRecord: previous, record: updated },
            ...(cleanup
              ? [
                  {
                    conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                    kind: "put" as const,
                    record: inboxContentCleanupRecord(scope, cleanup),
                  },
                ]
              : []),
          ]),
        ),
      );
      return updated;
    },

    async putPolicy(policy: AgentEmailPolicyRecord, inboxId?: AgentEmailPolicyInboxUpdate) {
      const previous = await getEnvironmentRecord("inbox-policy", policy.id);
      const previousPolicy = previous as
        | Extract<PlatformRecord, { readonly itemType: "inbox-policy" }>
        | undefined;
      const effectiveInboxId =
        inboxId === null ? undefined : (inboxId ?? previousPolicy?.data.inboxId);
      const next = inboxPolicyRecord(
        scope,
        {
          ...policy,
          allowlist: policy.allowlist ?? previousPolicy?.data.allowlist ?? [],
          blocklist: policy.blocklist ?? previousPolicy?.data.blocklist ?? [],
        },
        effectiveInboxId,
        {
          ...(previousPolicy?.data.bounceMessageCount !== undefined
            ? { bounceMessageCount: previousPolicy.data.bounceMessageCount }
            : {}),
          ...(previousPolicy?.data.complaintMessageCount !== undefined
            ? {
                complaintMessageCount: previousPolicy.data.complaintMessageCount,
              }
            : {}),
          ...(previousPolicy?.data.outboundOutcomeMessageCount !== undefined
            ? {
                outboundOutcomeMessageCount: previousPolicy.data.outboundOutcomeMessageCount,
              }
            : {}),
        },
      );
      if (!previous) {
        await run(
          "create-policy",
          database.putRecord(next, "attribute_not_exists(pk) AND attribute_not_exists(sk)"),
        );
        return next;
      }
      const updated = updateVersion(next, previous);
      await run(
        "update-policy",
        database.transactWrite([{ kind: "put", previousRecord: previous, record: updated }]),
      );
      return updated;
    },

    async recordUsage(usage: AgentEmailUsageEventRecord) {
      const created = inboxUsageMeterRecord(scope, usage);
      await run("record-usage", database.putRecord(created));
      return created;
    },
  };
}
