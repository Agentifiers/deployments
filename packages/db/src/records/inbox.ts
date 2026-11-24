import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import { EndUserKey } from "./conversation-erasure.ts";
import {
  BlobReference,
  Metadata,
  NonNegativeSafeInteger,
  QueuePriority,
  StringList,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
  tenantScopeFields,
} from "../record-schema.ts";

export const InboxMessageRecord = makeRecordSchema("inbox-message", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  acceptedAt: Schema.optional(Timestamp),
  bccAddresses: StringList,
  ccAddresses: StringList,
  clientId: Schema.optional(Schema.String),
  deliveredAt: Schema.optional(Timestamp),
  direction: Schema.Literals(["inbound", "outbound"]),
  draftId: Schema.optional(Ulid),
  failureCode: Schema.optional(Schema.String),
  failureReason: Schema.optional(Schema.String),
  fromAddress: Schema.String,
  htmlBody: Schema.optional(Schema.String),
  htmlBodyRef: Schema.optional(BlobReference),
  id: Ulid,
  inboxId: Ulid,
  inReplyTo: Schema.optional(Schema.String),
  internetMessageId: Schema.optional(Schema.String),
  lastReprocessedAt: Schema.optional(Timestamp),
  participantKeys: Schema.Array(EndUserKey),
  priority: QueuePriority,
  providerMessageId: Schema.optional(Schema.String),
  rawPurgeClaimedAt: Schema.optional(Timestamp),
  rawPurgeClaimFingerprint: Schema.optional(Schema.String),
  rawPurgeClaimKey: Schema.optional(Schema.String),
  rawPurgedAt: Schema.optional(Timestamp),
  rawReference: Schema.optional(BlobReference),
  rawRetentionExpiresAt: Schema.optional(Timestamp),
  receivedAt: Schema.optional(Timestamp),
  references: StringList,
  replyToAddresses: StringList,
  reprocessCount: Schema.Number,
  scheduledAt: Schema.optional(Timestamp),
  status: Schema.Literals([
    "accepted",
    "bounced",
    "complained",
    "delivered",
    "failed",
    "queued",
    "received",
    "scheduled",
    "sending",
  ]),
  subject: Schema.String,
  textBody: Schema.optional(Schema.String),
  textBodyRef: Schema.optional(BlobReference),
  threadKey: Schema.String,
  threadId: Schema.optional(Ulid),
  toAddresses: StringList,
});

export const InboxMessageCreatedIndexRecord = makeRecordSchema("inbox-message-created-index", {
  ...tenantScopeFields,
  createdAt: Timestamp,
  id: Ulid,
  inboxId: Ulid,
});

export const InboxDraftCreatedIndexRecord = makeRecordSchema("inbox-draft-created-index", {
  ...tenantScopeFields,
  createdAt: Timestamp,
  id: Ulid,
  inboxId: Ulid,
});

export const InboxMessageThreadIndexRecord = makeRecordSchema("inbox-message-thread-index", {
  ...tenantScopeFields,
  createdAt: Timestamp,
  id: Ulid,
  inboxId: Ulid,
  threadId: Ulid,
});

export const InboxMessageThreadAliasRecord = makeRecordSchema("inbox-message-thread-alias", {
  ...tenantScopeFields,
  createdAt: Timestamp,
  inboxId: Ulid,
  internetMessageId: Schema.String,
  messageId: Ulid,
  threadId: Ulid,
});

export const InboxThreadCreatedIndexRecord = makeRecordSchema("inbox-thread-created-index", {
  ...tenantScopeFields,
  createdAt: Timestamp,
  id: Ulid,
  inboxId: Ulid,
});

export const InboxResourceLocatorRecord = makeRecordSchema("inbox-resource-locator", {
  ...tenantScopeFields,
  createdAt: Timestamp,
  id: Ulid,
  inboxId: Ulid,
  resourceType: Schema.Literals(["draft", "message"]),
});

export const InboxThreadRecord = makeRecordSchema("inbox-thread", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  clientId: Schema.optional(Schema.String),
  id: Ulid,
  inboxId: Ulid,
  lastMessageAt: Timestamp,
  messageCount: Schema.Number,
  participants: StringList,
  subject: Schema.String,
  threadKey: Schema.String,
});

export const InboxAttachmentRecord = makeRecordSchema("inbox-attachment", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  contentId: Schema.optional(Schema.String),
  contentType: Schema.String,
  disposition: Schema.Literals(["attachment", "inline"]),
  fileName: Schema.String,
  id: Ulid,
  inboxMessageId: Ulid,
  ordinal: Schema.optional(NonNegativeSafeInteger),
  sha256: Schema.String,
  storage: BlobReference,
});

export const InboxContentCleanupRecord = makeRecordSchema(
  "inbox-content-cleanup",
  {
    ...mutableResourceFields,
    ...tenantScopeFields,
    expiresAt: Schema.optional(Timestamp),
    id: Ulid,
    references: Schema.Array(BlobReference),
    resourceId: Ulid,
    resourceType: Schema.Literals(["draft", "message"]),
    status: Schema.Literals(["completed", "pending"]),
  },
  { expiresAtField: "expiresAt", expiresAtRequired: false },
);

export const InboxDraftRecord = makeRecordSchema("inbox-draft", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  approvedAt: Schema.optional(Timestamp),
  bccAddresses: StringList,
  ccAddresses: StringList,
  clientId: Schema.optional(Schema.String),
  failureReason: Schema.optional(Schema.String),
  htmlBody: Schema.optional(Schema.String),
  htmlBodyRef: Schema.optional(BlobReference),
  id: Ulid,
  inboxId: Ulid,
  metadata: Metadata,
  participantKeys: Schema.Array(EndUserKey),
  recipients: StringList,
  rejectedAt: Schema.optional(Timestamp),
  replyToMessageId: Schema.optional(Ulid),
  scheduledAt: Schema.optional(Timestamp),
  sentMessageId: Schema.optional(Ulid),
  status: Schema.Literals([
    "approved",
    "cancelled",
    "draft",
    "failed",
    "pending_approval",
    "queued",
    "rejected",
    "scheduled",
    "sent",
  ]),
  subject: Schema.String,
  textBody: Schema.optional(Schema.String),
  textBodyRef: Schema.optional(BlobReference),
});

export const InboxProviderEventRecord = makeRecordSchema("inbox-provider-event", {
  ...tenantScopeFields,
  eventType: Schema.String,
  id: Ulid,
  inboxId: Schema.optional(Ulid),
  inboxMessageId: Schema.optional(Ulid),
  occurredAt: Timestamp,
  payload: Metadata,
  provider: Schema.String,
  providerEventId: Schema.String,
});
