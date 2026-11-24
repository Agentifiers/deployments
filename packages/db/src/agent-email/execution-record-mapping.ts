import type {
  AgentEmailDraftRecord,
  AgentEmailMessageRecord,
  AgentEmailThreadRecord,
  AgentEmailUsageEventRecord,
} from "@deployments-ai/agent-email";
import {
  base,
  boundedAgentEmailThreadParticipants,
  metadata,
  record,
  type AgentEmailAttachmentBlob,
  type AgentEmailContentCleanup,
  type AgentEmailDraftBodyReferences,
  type AgentEmailMessageBodyReferences,
  type AgentEmailPlatformScope,
  type RecordOf,
} from "./record-mapping-support.ts";
import type { Ulid } from "../ids.ts";
import type { EndUserKey } from "../records/conversation-erasure.ts";

export function inboxMessageRecord(
  scope: AgentEmailPlatformScope,
  message: AgentEmailMessageRecord,
  participantKeys: readonly EndUserKey[],
  bodyReferences: AgentEmailMessageBodyReferences = {},
): RecordOf<"inbox-message"> {
  if (message.rawPurgedAt && bodyReferences.rawReference) {
    throw new Error("Purged messages cannot retain a raw reference.");
  }
  return record({
    data: {
      ...base(scope),
      ...(message.acceptedAt ? { acceptedAt: message.acceptedAt } : {}),
      bccAddresses: [...message.bccAddresses],
      ccAddresses: [...message.ccAddresses],
      ...(message.clientId ? { clientId: message.clientId } : {}),
      createdAt: message.createdAt,
      ...(message.deliveredAt ? { deliveredAt: message.deliveredAt } : {}),
      direction: message.direction,
      ...(message.draftId ? { draftId: message.draftId as Ulid } : {}),
      ...(message.failureCode ? { failureCode: message.failureCode } : {}),
      ...(message.failureReason ? { failureReason: message.failureReason } : {}),
      fromAddress: message.fromAddress,
      ...(message.htmlBody && !bodyReferences.htmlBodyRef ? { htmlBody: message.htmlBody } : {}),
      ...bodyReferences,
      id: message.id as Ulid,
      inboxId: message.inboxId as Ulid,
      ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
      ...(message.internetMessageId ? { internetMessageId: message.internetMessageId } : {}),
      ...(message.lastReprocessedAt ? { lastReprocessedAt: message.lastReprocessedAt } : {}),
      participantKeys: [...participantKeys],
      priority: 50,
      ...(message.providerMessageId ? { providerMessageId: message.providerMessageId } : {}),
      ...(message.rawPurgedAt ? { rawPurgedAt: message.rawPurgedAt } : {}),
      ...(message.rawRetentionExpiresAt
        ? { rawRetentionExpiresAt: message.rawRetentionExpiresAt }
        : {}),
      ...(message.receivedAt ? { receivedAt: message.receivedAt } : {}),
      references: [...message.references],
      replyToAddresses: [...message.replyToAddresses],
      reprocessCount: message.reprocessCount,
      ...(message.scheduledAt ? { scheduledAt: message.scheduledAt } : {}),
      status: message.status,
      subject: message.subject,
      ...(message.textBody !== undefined && !bodyReferences.textBodyRef
        ? { textBody: message.textBody }
        : {}),
      threadKey: message.threadKey,
      ...(message.threadId ? { threadId: message.threadId as Ulid } : {}),
      toAddresses: [...message.toAddresses],
      updatedAt: message.updatedAt,
      version: 0,
    },
    itemType: "inbox-message",
  });
}

export function inboxMessageCreatedIndexRecord(
  scope: AgentEmailPlatformScope,
  message: Pick<AgentEmailMessageRecord, "createdAt" | "id" | "inboxId">,
): RecordOf<"inbox-message-created-index"> {
  return record({
    data: {
      ...base(scope),
      createdAt: message.createdAt,
      id: message.id as Ulid,
      inboxId: message.inboxId as Ulid,
    },
    itemType: "inbox-message-created-index",
  });
}

export function inboxMessageThreadIndexRecord(
  scope: AgentEmailPlatformScope,
  message: Pick<AgentEmailMessageRecord, "createdAt" | "id" | "inboxId" | "threadId"> & {
    readonly threadId: string;
  },
): RecordOf<"inbox-message-thread-index"> {
  return record({
    data: {
      ...base(scope),
      createdAt: message.createdAt,
      id: message.id as Ulid,
      inboxId: message.inboxId as Ulid,
      threadId: message.threadId as Ulid,
    },
    itemType: "inbox-message-thread-index",
  });
}

export function inboxThreadCreatedIndexRecord(
  scope: AgentEmailPlatformScope,
  thread: Pick<AgentEmailThreadRecord, "createdAt" | "id" | "inboxId">,
): RecordOf<"inbox-thread-created-index"> {
  return record({
    data: {
      ...base(scope),
      createdAt: thread.createdAt,
      id: thread.id as Ulid,
      inboxId: thread.inboxId as Ulid,
    },
    itemType: "inbox-thread-created-index",
  });
}

export function inboxMessageThreadAliasRecord(
  scope: AgentEmailPlatformScope,
  message: Pick<
    AgentEmailMessageRecord,
    "createdAt" | "inboxId" | "internetMessageId" | "id" | "threadId"
  > & {
    readonly internetMessageId: string;
    readonly threadId: string;
  },
): RecordOf<"inbox-message-thread-alias"> {
  return record({
    data: {
      ...base(scope),
      createdAt: message.createdAt,
      inboxId: message.inboxId as Ulid,
      internetMessageId: message.internetMessageId.trim(),
      messageId: message.id as Ulid,
      threadId: message.threadId as Ulid,
    },
    itemType: "inbox-message-thread-alias",
  });
}

export function inboxResourceLocatorRecord(
  scope: AgentEmailPlatformScope,
  input: {
    readonly createdAt: string;
    readonly id: string;
    readonly inboxId: string;
    readonly resourceType: "draft" | "message";
  },
): RecordOf<"inbox-resource-locator"> {
  return record({
    data: {
      ...base(scope),
      createdAt: input.createdAt,
      id: input.id as Ulid,
      inboxId: input.inboxId as Ulid,
      resourceType: input.resourceType,
    },
    itemType: "inbox-resource-locator",
  });
}

export function inboxThreadRecord(
  scope: AgentEmailPlatformScope,
  thread: AgentEmailThreadRecord,
  threadKey: string,
  clientId?: string,
): RecordOf<"inbox-thread"> {
  return record({
    data: {
      ...base(scope),
      ...(clientId ? { clientId } : {}),
      createdAt: thread.createdAt,
      id: thread.id as Ulid,
      inboxId: thread.inboxId as Ulid,
      lastMessageAt: thread.lastMessageAt,
      messageCount: thread.messageCount,
      participants: boundedAgentEmailThreadParticipants(thread.participants),
      subject: thread.subject,
      threadKey,
      updatedAt: thread.updatedAt,
      version: 0,
    },
    itemType: "inbox-thread",
  });
}

export function inboxDraftRecord(
  scope: AgentEmailPlatformScope,
  draft: AgentEmailDraftRecord,
  participantKeys: readonly EndUserKey[],
  bodyReferences: AgentEmailDraftBodyReferences = {},
): RecordOf<"inbox-draft"> {
  return record({
    data: {
      ...base(scope),
      ...(draft.approvedAt ? { approvedAt: draft.approvedAt } : {}),
      bccAddresses: [...draft.bccAddresses],
      ccAddresses: [...draft.ccAddresses],
      ...(draft.clientId ? { clientId: draft.clientId } : {}),
      createdAt: draft.createdAt,
      ...(draft.failureReason ? { failureReason: draft.failureReason } : {}),
      ...(draft.htmlBody && !bodyReferences.htmlBodyRef ? { htmlBody: draft.htmlBody } : {}),
      ...bodyReferences,
      id: draft.id as Ulid,
      inboxId: draft.inboxId as Ulid,
      metadata: metadata(draft.metadata),
      participantKeys: [...participantKeys],
      recipients: [...draft.toAddresses],
      ...(draft.rejectedAt ? { rejectedAt: draft.rejectedAt } : {}),
      ...(draft.replyToMessageId ? { replyToMessageId: draft.replyToMessageId as Ulid } : {}),
      ...(draft.scheduledAt ? { scheduledAt: draft.scheduledAt } : {}),
      ...(draft.sentMessageId ? { sentMessageId: draft.sentMessageId as Ulid } : {}),
      status: draft.status,
      subject: draft.subject,
      ...(draft.textBody !== undefined && !bodyReferences.textBodyRef
        ? { textBody: draft.textBody }
        : {}),
      updatedAt: draft.updatedAt,
      version: 0,
    },
    itemType: "inbox-draft",
  });
}

export function inboxDraftCreatedIndexRecord(
  scope: AgentEmailPlatformScope,
  draft: Pick<AgentEmailDraftRecord, "createdAt" | "id" | "inboxId">,
): RecordOf<"inbox-draft-created-index"> {
  return record({
    data: {
      ...base(scope),
      createdAt: draft.createdAt,
      id: draft.id as Ulid,
      inboxId: draft.inboxId as Ulid,
    },
    itemType: "inbox-draft-created-index",
  });
}

export function inboxAttachmentRecord(
  scope: AgentEmailPlatformScope,
  messageId: Ulid,
  attachment: AgentEmailAttachmentBlob,
  createdAt: string,
  ordinal: number,
  updatedAt = createdAt,
): RecordOf<"inbox-attachment"> {
  return record({
    data: {
      ...base(scope),
      createdAt,
      ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
      contentType: attachment.contentType,
      disposition: attachment.disposition,
      fileName: attachment.fileName,
      id: attachment.id,
      inboxMessageId: messageId,
      ordinal,
      sha256: attachment.sha256,
      storage: {
        bucket: attachment.bucket,
        byteSize: attachment.byteSize,
        contentType: attachment.contentType,
        ...(attachment.etag ? { etag: attachment.etag } : {}),
        fileName: attachment.fileName,
        key: attachment.key,
        sha256: attachment.sha256,
        ...(attachment.versionId ? { versionId: attachment.versionId } : {}),
      },
      updatedAt,
      version: 0,
    },
    itemType: "inbox-attachment",
  });
}

export function inboxContentCleanupRecord(
  scope: AgentEmailPlatformScope,
  cleanup: AgentEmailContentCleanup,
): RecordOf<"inbox-content-cleanup"> {
  return record({
    data: {
      ...base(scope),
      createdAt: cleanup.createdAt,
      id: cleanup.id,
      references: [...cleanup.references],
      resourceId: cleanup.resourceId,
      resourceType: cleanup.resourceType,
      status: "pending",
      updatedAt: cleanup.createdAt,
      version: 0,
    },
    itemType: "inbox-content-cleanup",
  });
}

export function inboxUsageMeterRecord(
  scope: AgentEmailPlatformScope,
  event: AgentEmailUsageEventRecord,
): RecordOf<"meter-event"> {
  return record({
    data: {
      ...base(scope),
      dimensions: {
        ...(event.clientId ? { clientId: event.clientId } : {}),
        ...(event.inboxId ? { inboxId: event.inboxId } : {}),
        ...(event.messageId ? { messageId: event.messageId } : {}),
      },
      id: event.id as Ulid,
      idempotencyKey: `agent-email:${event.id}`,
      metric: `agent_email.${event.kind}`,
      occurredAt: event.createdAt,
      quantity: event.quantity,
      source: "agent-email",
      unit: event.kind.endsWith("bytes") ? "bytes" : "count",
    },
    itemType: "meter-event",
  });
}
