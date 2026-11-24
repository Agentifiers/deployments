import {
  agentEmailEffectiveDailyLimit,
  agentEmailForwardHtml,
  agentEmailForwardSubject,
  agentEmailForwardText,
  agentEmailReplyRecipients,
  agentEmailReplySubject,
  type AgentEmailDraftRecord,
  type AgentEmailInboxRecord,
  type AgentEmailMessageRecord,
  type AgentEmailThreadRecord,
} from "@deployments-ai/agent-email";
import { deterministicAgentEmailUlid } from "@deployments-ai/agent-email/aws";
import {
  AgentEmailForwardRequest,
  AgentEmailReplyRequest,
  SendAgentEmailMessageRequest,
} from "@deployments-ai/api-contract/agent-email";
import {
  AgentEmailQuotaExceededError,
  Keys,
  type PlatformRecord,
  agentEmailPersistence,
} from "@deployments-ai/db";
import { createHash } from "node:crypto";
import { AgentEmailApiError, type AgentEmailApiInvocation } from "./api-handler.ts";
import { agentEmailClaimOperationLimitFailure } from "./send-processing.ts";

import type { createAgentEmailDraftOperations } from "./application-draft-operations.ts";
import type { AgentEmailApplicationContext } from "./application-service-context.ts";
import {
  apiError,
  decodePublicRequest,
  domainFrom,
  event,
  messageFrom,
  requiredBody,
  requiredParameter,
  type RecordOf,
} from "./application-service-support.ts";
import { activeInboxForRecipient } from "./recipient-verification.ts";

export function createAgentEmailSendOperations(
  context: AgentEmailApplicationContext,
  draftOperations: ReturnType<typeof createAgentEmailDraftOperations>,
) {
  const { createId, defaultPolicy, dependencies, now, requireInbox, requireMessage, scoped } =
    context;
  const { externalizeBodies, rethrowAfterBlobCleanup, uploadAttachments } = draftOperations;
  async function sendMessage(
    invocation: AgentEmailApiInvocation,
    input: typeof SendAgentEmailMessageRequest.Type,
    options: {
      readonly inbox: AgentEmailInboxRecord;
      readonly draftTransition?: {
        readonly next: AgentEmailDraftRecord;
        readonly previous: RecordOf<"inbox-draft">;
      };
      readonly inReplyTo?: string;
      readonly messageId?: string;
      readonly references?: readonly string[];
      readonly threadKey?: string;
      readonly threadId?: string;
    },
  ) {
    const selected = scoped(invocation);
    if (options.inbox.status !== "active") {
      apiError(409, "inbox_not_active", "Only active inboxes can send email.");
    }
    const domainRecord = await selected.repository.getDomain(options.inbox.domainId);
    if (
      !domainRecord ||
      domainFrom(domainRecord as RecordOf<"inbox-domain">).status !== "verified"
    ) {
      apiError(409, "domain_not_verified", "The inbox domain is not verified.");
    }
    const durableInbox = await selected.repository.getInbox(options.inbox.id);
    const placements = await selected.records("inbox-placement");
    const effectivePlacements = durableInbox?.data.placementId
      ? placements.filter((placement) => placement.data.id === durableInbox.data.placementId)
      : placements.filter((placement) => placement.data.isDefault);
    const placement = effectivePlacements[0];
    if (
      effectivePlacements.length !== 1 ||
      !placement ||
      placement.data.status !== "active" ||
      placement.data.provider !== "ses" ||
      typeof placement.data.providerMetadata.configurationSetName !== "string" ||
      !placement.data.providerMetadata.configurationSetName.trim() ||
      (placement.data.secondaryRegion &&
        (typeof placement.data.providerMetadata.endpointId !== "string" ||
          !placement.data.providerMetadata.endpointId.trim()))
    ) {
      apiError(
        409,
        "placement_not_ready",
        "The inbox must resolve exactly one active, provisioned SES placement before sending.",
      );
    }
    const policies = await selected.records("inbox-policy");
    const inboxPolicies = policies.filter(
      (candidate) => candidate.data.inboxId === options.inbox.id,
    );
    const environmentPolicies = policies.filter((candidate) => !candidate.data.inboxId);
    const policyCandidates = inboxPolicies.length > 0 ? inboxPolicies : environmentPolicies;
    if (policyCandidates.length > 1) {
      apiError(
        500,
        "email_policy_ambiguous",
        "The inbox resolves more than one outbound email policy.",
      );
    }
    let policyRecord = policyCandidates[0];
    if (!policyRecord) {
      try {
        policyRecord = (await selected.repository.putPolicy(
          defaultPolicy(invocation, now()),
        )) as RecordOf<"inbox-policy">;
      } catch (cause) {
        policyRecord = (await selected.records("inbox-policy")).find(
          (candidate) => !candidate.data.inboxId,
        );
        if (!policyRecord) throw cause;
      }
    }
    const policy = policyRecord.data;
    if (policy.sendingStatus !== "active") {
      apiError(
        409,
        "email_sending_paused",
        policy.sendingStatusReason ?? "Outbound email sending is not active.",
      );
    }
    const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])];
    if (recipients.length === 0) {
      apiError(400, "recipient_required", "At least one recipient is required to send email.");
    }
    if (recipients.length > policy.maxRecipientsPerMessage) {
      apiError(
        409,
        "recipient_limit_exceeded",
        `The message exceeds the ${policy.maxRecipientsPerMessage}-recipient policy limit.`,
      );
    }
    const blocked = new Set(
      (policy.blocklist ?? []).map((address) => address.trim().toLowerCase()),
    );
    const blockedRecipient = recipients.find((address) =>
      blocked.has(address.trim().toLowerCase()),
    );
    if (blockedRecipient) {
      apiError(
        409,
        "recipient_blocked",
        `Recipient ${blockedRecipient} is blocked by the outbound email policy.`,
      );
    }
    const attachmentBodies = (input.attachments ?? []).map((attachment, index) => {
      const body = Buffer.from(attachment.contentBase64, "base64");
      if (
        body.toString("base64").replaceAll("=", "") !== attachment.contentBase64.replaceAll("=", "")
      ) {
        apiError(400, "invalid_attachment", `Attachment ${index + 1} is not valid base64.`);
      }
      return body;
    });
    const requestedAttachmentBytes = attachmentBodies.reduce(
      (total, attachment) => total + attachment.byteLength,
      0,
    );
    if (requestedAttachmentBytes > policy.maxAttachmentBytes) {
      apiError(
        409,
        "attachment_limit_exceeded",
        `The message exceeds the ${policy.maxAttachmentBytes}-byte attachment policy limit.`,
      );
    }
    const timestamp = now();
    if (input.scheduledAt && input.scheduledAt <= timestamp) {
      apiError(400, "scheduled_at_in_past", "scheduledAt must be later than the current time.");
    }
    const normalizedRecipients = [
      ...new Set(recipients.map((address) => address.trim().toLowerCase())),
    ];
    const senderInboxRecipients = new Set<string>();
    if (policy.requireRecipientVerification) {
      const verified = new Set(
        [
          ...(policy.allowlist ?? []),
          ...(await selected.records("inbox-recipient-verification"))
            .filter(
              (record) =>
                record.data.status === "verified" &&
                (!record.data.expiresAt || record.data.expiresAt > timestamp),
            )
            .map((record) => record.data.address),
        ].map((address) => address.trim().toLowerCase()),
      );
      const unverified = (
        await Promise.all(
          normalizedRecipients.map(async (address) => {
            if (verified.has(address.trim().toLowerCase())) return undefined;
            const recipientInbox = await activeInboxForRecipient(
              dependencies.database,
              selected.scope,
              address,
              options.inbox.domainId,
            );
            if (recipientInbox?.data.id === options.inbox.id) {
              senderInboxRecipients.add(address);
            }
            return recipientInbox ? undefined : address;
          }),
        )
      ).find((address) => address !== undefined);
      if (unverified) {
        apiError(
          409,
          "recipient_not_verified",
          `Recipient ${unverified} is not verified for warmup sending.`,
        );
      }
    }
    const allowedRecipients = new Set(
      (policy.allowlist ?? []).map((address) => address.trim().toLowerCase()),
    );
    const claimLimitFailure = agentEmailClaimOperationLimitFailure(
      normalizedRecipients.length,
      policy.requireRecipientVerification
        ? normalizedRecipients.filter(
            (address) => !allowedRecipients.has(address) && !senderInboxRecipients.has(address),
          ).length
        : 0,
    );
    if (claimLimitFailure) {
      apiError(409, claimLimitFailure.failureCode, claimLimitFailure.failureReason);
    }
    const quotaTimestamp = input.scheduledAt ?? timestamp;
    const dayStart = `${quotaTimestamp.slice(0, 10)}T00:00:00.000Z`;
    const dayEnd = `${quotaTimestamp.slice(0, 10)}T23:59:59.999Z`;
    const quotaWindow = dayStart.slice(0, 10);
    const persistedQuota = await selected.repository.getOutboundQuota(quotaWindow);
    const outboundToday =
      persistedQuota?.data.count ??
      (
        await selected.usageRecords({
          from: dayStart,
          kinds: ["outbound_message"],
          to: dayEnd,
        })
      )
        .filter(
          (record) =>
            record.data.metric === "agent_email.outbound_message" &&
            record.data.occurredAt >= dayStart &&
            record.data.occurredAt <= dayEnd,
        )
        .reduce((total, record) => total + record.data.quantity, 0);
    const dailyOutboundLimit = agentEmailEffectiveDailyLimit({
      policyLimit: policy.dailyOutboundMessageLimit,
      warmupStage: policy.warmupStage,
    });
    if (outboundToday >= dailyOutboundLimit) {
      apiError(
        409,
        "daily_outbound_limit_exceeded",
        `The ${dailyOutboundLimit}-message daily outbound limit has been reached.`,
      );
    }
    const suppressionNamespace = `organization:${invocation.scope.organizationId}:project:${invocation.scope.projectId}:environment:${invocation.scope.environmentId}:inbox-suppression`;
    const suppressionClaims = await Promise.all(
      normalizedRecipients.map(async (address) => ({
        address,
        claim: await agentEmailPersistence.read(
          dependencies.database,
          "control",
          Keys.control.uniqueClaim(
            suppressionNamespace,
            createHash("sha256").update(address).digest("hex"),
          ),
          true,
        ),
      })),
    );
    const suppressedRecipient = suppressionClaims.find(({ claim }) => claim)?.address;
    if (suppressedRecipient) {
      apiError(
        409,
        "recipient_suppressed",
        `Recipient ${suppressedRecipient} is actively suppressed.`,
      );
    }
    const id = options.messageId ?? (await createId());
    const attachments = await uploadAttachments(invocation, id, input.attachments);
    let bodies: Awaited<ReturnType<typeof externalizeBodies>> | undefined;
    let saved!: RecordOf<"inbox-message">;
    try {
      bodies = await externalizeBodies(invocation, id, input.html, input.text);
      const threadId = options.threadId ?? (await createId());
      const message: AgentEmailMessageRecord = {
        attachments: attachments.records,
        bccAddresses: input.bcc ?? [],
        ccAddresses: input.cc ?? [],
        ...(input.clientId ? { clientId: input.clientId } : {}),
        createdAt: timestamp,
        direction: "outbound",
        fromAddress: options.inbox.address,
        ...("htmlBody" in bodies ? { htmlBody: bodies.htmlBody } : {}),
        id,
        ...(options.inReplyTo ? { inReplyTo: options.inReplyTo } : {}),
        ...(options.draftTransition ? { draftId: options.draftTransition.next.id } : {}),
        inboxId: options.inbox.id,
        organizationId: invocation.scope.organizationId,
        reprocessCount: 0,
        references: options.references ?? [],
        replyToAddresses: [],
        ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
        status: input.scheduledAt ? "scheduled" : "queued",
        subject: input.subject,
        ...("textBody" in bodies ? { textBody: bodies.textBody } : {}),
        threadKey: options.threadKey ?? id,
        threadId,
        toAddresses: input.to,
        updatedAt: timestamp,
      };
      const thread: AgentEmailThreadRecord = {
        createdAt: timestamp,
        id: threadId,
        inboxId: options.inbox.id,
        lastMessageAt: timestamp,
        messageCount: 1,
        organizationId: invocation.scope.organizationId,
        participants: [...new Set([options.inbox.address, ...input.to, ...(input.cc ?? [])])],
        subject: input.subject,
        updatedAt: timestamp,
      };
      const attachmentBytes = attachments.records.reduce(
        (total, attachment) => total + attachment.byteSize,
        0,
      );
      const bodyBytes = bodies.byteSize;
      saved = await selected.repository.persistMessage({
        attachments: attachments.blobs,
        bodyReferences: bodies.bodyReferences,
        dailyQuota: {
          expiresAt: new Date(Date.parse(dayStart) + 24 * 60 * 60 * 1_000).toISOString(),
          limit: dailyOutboundLimit,
          observedUsage: outboundToday,
          window: quotaWindow,
        },
        event: event(
          "agent-email.send-requested",
          message,
          await createId(),
          invocation.scope,
          timestamp,
        ),
        message,
        thread,
        ...(options.draftTransition ? { draftTransition: options.draftTransition } : {}),
        usage: [
          {
            ...(message.clientId ? { clientId: message.clientId } : {}),
            createdAt: quotaTimestamp,
            id: await createId(),
            inboxId: message.inboxId,
            kind: "outbound_message",
            messageId: message.id,
            organizationId: invocation.scope.organizationId,
            quantity: 1,
          },
          ...(attachmentBytes > 0
            ? [
                {
                  ...(message.clientId ? { clientId: message.clientId } : {}),
                  createdAt: timestamp,
                  id: await createId(),
                  inboxId: message.inboxId,
                  kind: "attachment_bytes" as const,
                  messageId: message.id,
                  organizationId: invocation.scope.organizationId,
                  quantity: attachmentBytes,
                },
              ]
            : []),
          ...(attachmentBytes + bodyBytes > 0
            ? [
                {
                  ...(message.clientId ? { clientId: message.clientId } : {}),
                  createdAt: timestamp,
                  id: await createId(),
                  inboxId: message.inboxId,
                  kind: "stored_bytes" as const,
                  messageId: message.id,
                  organizationId: invocation.scope.organizationId,
                  quantity: attachmentBytes + bodyBytes,
                },
              ]
            : []),
        ],
      });
    } catch (cause) {
      let committed: PlatformRecord | undefined;
      try {
        committed = await agentEmailPersistence.read(
          dependencies.database,
          "execution",
          {
            pk: `ORG#${invocation.scope.organizationId}#INBOX#${options.inbox.id}`,
            sk: `INBOX-MESSAGE#${id}`,
          },
          true,
        );
      } catch (reconciliationCause) {
        throw new AggregateError(
          [cause, reconciliationCause],
          "Agent email message persistence outcome could not be reconciled.",
        );
      }
      if (
        committed?.itemType === "inbox-message" &&
        committed.data.id === id &&
        committed.data.inboxId === options.inbox.id &&
        committed.data.organizationId === invocation.scope.organizationId &&
        committed.data.projectId === invocation.scope.projectId &&
        committed.data.environmentId === invocation.scope.environmentId
      ) {
        saved = committed;
      } else {
        const mappedCause =
          cause instanceof AgentEmailQuotaExceededError
            ? new AgentEmailApiError(409, "daily_outbound_limit_exceeded", cause.message)
            : cause;
        await rethrowAfterBlobCleanup(mappedCause, [
          ...attachments.createdBlobs,
          ...(bodies?.createdBlobs ?? []),
        ]);
      }
    }
    const {
      htmlBody: _htmlBody,
      textBody: _textBody,
      ...summary
    } = messageFrom(saved, attachments.records);
    return summary;
  }

  async function replyThreadingOptions(
    invocation: AgentEmailApiInvocation,
    inbox: AgentEmailInboxRecord,
    replyToMessageId: string | undefined,
  ) {
    if (!replyToMessageId) return {};
    const selected = scoped(invocation);
    const record = await selected.record("inbox-message", replyToMessageId);
    if (!record) {
      apiError(404, "reply_message_not_found", `Reply message ${replyToMessageId} was not found.`);
    }
    const original = await selected.hydrateMessage(record);
    if (original.inboxId !== inbox.id) {
      apiError(
        409,
        "reply_message_inbox_mismatch",
        "Reply messages must belong to the sending inbox.",
      );
    }
    return {
      ...(original.internetMessageId ? { inReplyTo: original.internetMessageId } : {}),
      references: [
        ...new Set([
          ...original.references,
          ...(original.internetMessageId ? [original.internetMessageId] : []),
        ]),
      ],
      threadKey: original.threadKey,
      ...(original.threadId ? { threadId: original.threadId } : {}),
    };
  }

  async function sendInboxMessage(invocation: AgentEmailApiInvocation) {
    const input = decodePublicRequest(SendAgentEmailMessageRequest, requiredBody(invocation));
    const inbox = await requireInbox(invocation);
    return sendMessage(invocation, input, {
      inbox,
      ...(await replyThreadingOptions(invocation, inbox, input.replyToMessageId)),
    });
  }

  async function replyOrForward(
    invocation: AgentEmailApiInvocation,
    mode: "forward" | "reply" | "replyAll",
  ) {
    if (mode === "forward") {
      const input = decodePublicRequest(AgentEmailForwardRequest, requiredBody(invocation));
      const original = await requireMessage(
        invocation,
        input.includeOriginal !== false && (input.html === undefined || input.text === undefined),
      );
      const inbox = await requireInbox(invocation, original.inboxId);
      return sendMessage(
        invocation,
        {
          ...input,
          html:
            input.html ??
            (input.includeOriginal === false ? undefined : agentEmailForwardHtml(original)),
          subject: agentEmailForwardSubject(original.subject),
          text:
            input.text ??
            (input.includeOriginal === false ? undefined : agentEmailForwardText(original)),
        },
        { inbox },
      );
    }
    const original = await requireMessage(invocation);
    const inbox = await requireInbox(invocation, original.inboxId);
    const input = decodePublicRequest(AgentEmailReplyRequest, requiredBody(invocation));
    const to = agentEmailReplyRecipients(original, inbox.address, mode === "replyAll");
    if (to.length === 0) apiError(409, "reply_recipient_unavailable", "No reply recipient exists.");
    return sendMessage(
      invocation,
      {
        ...input,
        subject: agentEmailReplySubject(original.subject),
        to,
      },
      {
        inbox,
        ...(original.internetMessageId ? { inReplyTo: original.internetMessageId } : {}),
        references: [
          ...original.references,
          ...(original.internetMessageId ? [original.internetMessageId] : []),
        ],
        threadKey: original.threadKey,
        ...(original.threadId ? { threadId: original.threadId } : {}),
      },
    );
  }

  async function sendDraft(invocation: AgentEmailApiInvocation) {
    const draftId = requiredParameter(invocation, "draftId");
    const selected = scoped(invocation);
    const previous = await selected.record("inbox-draft", draftId);
    if (!previous) apiError(404, "draft_not_found", `Draft ${draftId} was not found.`);
    const existing = await selected.hydrateDraft(previous);
    if (
      ["failed", "queued", "scheduled", "sent"].includes(existing.status) &&
      existing.sentMessageId
    ) {
      const sent = await selected.record("inbox-message", existing.sentMessageId);
      if (sent) return selected.summarizeMessage(sent);
    }
    if (existing.status !== "approved") {
      apiError(409, "draft_not_approved", "Only approved drafts can be sent.");
    }
    const inbox = await requireInbox(invocation, existing.inboxId);
    const messageId = deterministicAgentEmailUlid(
      existing.createdAt,
      "draft-send-v1",
      invocation.scope.organizationId,
      invocation.scope.environmentId,
      existing.inboxId,
      existing.id,
    );
    const next: AgentEmailDraftRecord = {
      ...existing,
      sentMessageId: messageId,
      status: existing.scheduledAt ? "scheduled" : "queued",
      updatedAt: now(),
    };
    const threading = await replyThreadingOptions(invocation, inbox, existing.replyToMessageId);
    try {
      return await sendMessage(
        invocation,
        {
          bcc: existing.bccAddresses,
          cc: existing.ccAddresses,
          ...(existing.clientId ? { clientId: existing.clientId } : {}),
          ...(existing.htmlBody !== undefined ? { html: existing.htmlBody } : {}),
          ...(existing.scheduledAt ? { scheduledAt: existing.scheduledAt } : {}),
          subject: existing.subject,
          ...(existing.textBody !== undefined ? { text: existing.textBody } : {}),
          to: existing.toAddresses,
        },
        {
          draftTransition: { next, previous },
          inbox,
          messageId,
          ...threading,
        },
      );
    } catch (cause) {
      const committedDraft = await selected.record("inbox-draft", draftId);
      if (committedDraft?.data.sentMessageId === messageId) {
        const committedMessage = await selected.record("inbox-message", messageId);
        if (committedMessage) return selected.summarizeMessage(committedMessage);
      }
      throw cause;
    }
  }

  return {
    replyOrForward,
    sendDraft,
    sendInboxMessage,
    sendMessage,
  };
}
