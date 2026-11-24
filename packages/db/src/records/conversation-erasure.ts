import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  NonEmptyString,
  NonNegativeSafeInteger,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
  tenantScopeFields,
} from "../record-schema.ts";
import { Sha256Hex } from "./evaluations.ts";

export const EndUserKey = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^v1\.[A-Za-z0-9_-]{43}$/)),
  Schema.brand("EndUserKey"),
);
export type EndUserKey = typeof EndUserKey.Type;

export const ThreadTombstoneRecord = makeRecordSchema("thread-tombstone", {
  ...tenantScopeFields,
  erasedAt: Timestamp,
  operationId: Ulid,
  threadId: Ulid,
});

export const EndUserThreadRecord = makeRecordSchema("end-user-thread", {
  ...tenantScopeFields,
  createdAt: Timestamp,
  endUserKey: EndUserKey,
  threadId: Ulid,
});

export const EndUserErasureFenceRecord = makeRecordSchema("end-user-erasure-fence", {
  createdAt: Timestamp,
  endUserKey: EndUserKey,
  environmentId: Ulid,
  operationId: Ulid,
  organizationId: Ulid,
});

export const ConversationErasureItemStage = Schema.Literals(["planned", "fenced", "erased"]);
export type ConversationErasureItemStage = typeof ConversationErasureItemStage.Type;

export const ConversationErasureItemRecord = makeRecordSchema("conversation-erasure-item", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  cancelRequestedAt: Schema.optional(Timestamp),
  fencedAt: Schema.optional(Timestamp),
  ingressRouteIds: Schema.Array(NonEmptyString),
  mailPlannedAt: Schema.optional(Timestamp),
  operationId: Ulid,
  recordsDeleted: NonNegativeSafeInteger,
  runIds: Schema.Array(Ulid),
  stage: ConversationErasureItemStage,
  streamDeletedAt: Schema.optional(Timestamp),
  threadId: Ulid,
});

export const InboxMessageTombstoneRecord = makeRecordSchema("inbox-message-tombstone", {
  ...tenantScopeFields,
  erasedAt: Timestamp,
  inboxId: Ulid,
  messageId: Ulid,
  operationId: Ulid,
});

export const InboxMessageThreadAliasTombstoneRecord = makeRecordSchema(
  "inbox-message-thread-alias-tombstone",
  {
    ...tenantScopeFields,
    inboxId: Ulid,
    inboxThreadId: Ulid,
    internetMessageIdHash: Sha256Hex,
  },
);

export const InboxThreadErasureFenceRecord = makeRecordSchema("inbox-thread-erasure-fence", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  erasedThrough: Timestamp,
  inboxId: Ulid,
  inboxThreadId: Ulid,
  operationId: Ulid,
});

export const InboxMailResourceType = Schema.Literals(["draft", "message"]);
export type InboxMailResourceType = typeof InboxMailResourceType.Type;

export const EndUserInboxMailRecord = makeRecordSchema("end-user-inbox-mail", {
  ...tenantScopeFields,
  createdAt: Timestamp,
  endUserKey: EndUserKey,
  inboxId: Ulid,
  resourceId: Ulid,
  resourceType: InboxMailResourceType,
});

export const ConversationErasureMailTarget = Schema.Union([
  Schema.Struct({ inboxThreadId: Ulid, kind: Schema.Literal("thread") }),
  Schema.Struct({ draftId: Ulid, kind: Schema.Literal("draft") }),
]);
export type ConversationErasureMailTarget = typeof ConversationErasureMailTarget.Type;

export const ConversationErasureMailItemRecord = makeRecordSchema(
  "conversation-erasure-mail-item",
  {
    ...mutableResourceFields,
    ...tenantScopeFields,
    inboxId: Ulid,
    messagesErased: NonNegativeSafeInteger,
    operationId: Ulid,
    pendingCleanupIds: Schema.Array(NonEmptyString),
    stage: Schema.Literals(["planned", "erased"]),
    target: ConversationErasureMailTarget,
  },
);
