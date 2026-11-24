import { createHash } from "node:crypto";
import { key } from "../keys.ts";
import { field, requiredField, type KeyableRecord } from "../record-key-fields.ts";

export function governanceThreadInventoryPartition(organizationId: string, threadId: string) {
  return key("ORG", organizationId, "THREAD", threadId, "GOVERNANCE-INVENTORY");
}

export function governanceMultiThreadInventoryPartition(organizationId: string) {
  return key("ORG", organizationId, "GOVERNANCE-INVENTORY", "MULTI-THREAD");
}

export function governanceThreadInventoryKeys(record: KeyableRecord, identity: readonly string[]) {
  if (record.itemType !== "governance-tenant-record") return {};
  const threadIds = record.data.threadIds;
  const organizationId = field(record.data, "organizationId");
  if (!organizationId || !Array.isArray(threadIds) || threadIds.length === 0) return {};
  return {
    gsi1pk:
      threadIds.length === 1
        ? governanceThreadInventoryPartition(organizationId, String(threadIds[0]))
        : governanceMultiThreadInventoryPartition(organizationId),
    gsi1sk: key("RECORD", createHash("sha256").update(identity.join("\0")).digest("hex")),
  };
}

export function threadTombstoneKey(organizationId: string, threadId: string) {
  return { pk: key("ORG", organizationId, "THREAD", threadId), sk: key("TOMBSTONE") };
}

export function endUserPartition(
  organizationId: string,
  environmentId: string,
  endUserKey: string,
) {
  return key("ORG", organizationId, "ENV", environmentId, "END-USER", endUserKey);
}

export function endUserErasureFenceKey(
  organizationId: string,
  environmentId: string,
  endUserKey: string,
) {
  return {
    pk: endUserPartition(organizationId, environmentId, endUserKey),
    sk: key("END-USER-ERASURE-FENCE"),
  };
}

export function conversationErasureItemPartition(organizationId: string, operationId: string) {
  return key("ORG", organizationId, "GOVERNANCE-OPERATION", operationId);
}

export function inboxMessageTombstoneKey(organizationId: string, messageId: string) {
  return {
    pk: key("ORG", organizationId, "INBOX-MESSAGE", messageId),
    sk: key("INBOX-MESSAGE-TOMBSTONE"),
  };
}

export function internetMessageIdHash(internetMessageId: string) {
  return createHash("sha256").update(internetMessageId.trim()).digest("hex");
}

export function inboxThreadPartition(organizationId: string, inboxThreadId: string) {
  return key("ORG", organizationId, "INBOX-THREAD", inboxThreadId);
}

export function inboxThreadErasureFenceKey(organizationId: string, inboxThreadId: string) {
  return {
    pk: inboxThreadPartition(organizationId, inboxThreadId),
    sk: key("INBOX-THREAD-ERASURE-FENCE"),
  };
}

export function conversationThreadPartition(organizationId: string, threadId: string) {
  return key("ORG", organizationId, "THREAD", threadId);
}

function mailTargetParts(record: KeyableRecord): readonly [string, string] {
  const target = record.data.target as
    | { readonly draftId: string; readonly kind: "draft" }
    | { readonly inboxThreadId: string; readonly kind: "thread" };
  return target.kind === "draft" ? ["DRAFT", target.draftId] : ["THREAD", target.inboxThreadId];
}

export function conversationErasureIdentityParts(
  record: KeyableRecord,
): readonly string[] | undefined {
  switch (record.itemType) {
    case "thread-tombstone":
    case "end-user-thread":
      return [requiredField(record, "threadId")];
    case "end-user-erasure-fence":
      return [requiredField(record, "endUserKey")];
    case "conversation-erasure-item":
      return [requiredField(record, "operationId"), requiredField(record, "threadId")];
    case "conversation-erasure-mail-item":
      return [
        requiredField(record, "operationId"),
        requiredField(record, "inboxId"),
        ...mailTargetParts(record),
      ];
    case "inbox-message-tombstone":
      return [requiredField(record, "messageId")];
    case "inbox-message-thread-alias-tombstone":
      return [requiredField(record, "internetMessageIdHash")];
    case "inbox-thread-erasure-fence":
      return [requiredField(record, "inboxThreadId")];
    case "end-user-inbox-mail":
      return [
        requiredField(record, "endUserKey"),
        requiredField(record, "inboxId"),
        requiredField(record, "resourceType"),
        requiredField(record, "resourceId"),
      ];
    case "conversation-inbox-thread":
    case "inbox-thread-conversation":
      return [requiredField(record, "threadId"), requiredField(record, "messageId")];
    default:
      return undefined;
  }
}

export function conversationErasurePrimaryKeys(
  record: KeyableRecord,
): { readonly pk: string; readonly sk: string } | undefined {
  switch (record.itemType) {
    case "thread-tombstone":
      return threadTombstoneKey(
        requiredField(record, "organizationId"),
        requiredField(record, "threadId"),
      );
    case "end-user-thread":
      return {
        pk: endUserPartition(
          requiredField(record, "organizationId"),
          requiredField(record, "environmentId"),
          requiredField(record, "endUserKey"),
        ),
        sk: key("END-USER-THREAD", requiredField(record, "threadId")),
      };
    case "end-user-erasure-fence":
      return endUserErasureFenceKey(
        requiredField(record, "organizationId"),
        requiredField(record, "environmentId"),
        requiredField(record, "endUserKey"),
      );
    case "conversation-erasure-item":
      return {
        pk: conversationErasureItemPartition(
          requiredField(record, "organizationId"),
          requiredField(record, "operationId"),
        ),
        sk: key("CONVERSATION-ERASURE-ITEM", requiredField(record, "threadId")),
      };
    case "conversation-erasure-mail-item":
      return {
        pk: conversationErasureItemPartition(
          requiredField(record, "organizationId"),
          requiredField(record, "operationId"),
        ),
        sk: key(
          "CONVERSATION-ERASURE-MAIL",
          requiredField(record, "inboxId"),
          ...mailTargetParts(record),
        ),
      };
    case "inbox-message-tombstone":
      return inboxMessageTombstoneKey(
        requiredField(record, "organizationId"),
        requiredField(record, "messageId"),
      );
    case "inbox-message-thread-alias-tombstone":
      return {
        pk: key(
          "ORG",
          requiredField(record, "organizationId"),
          "INBOX",
          requiredField(record, "inboxId"),
        ),
        sk: key(
          "INBOX-MESSAGE-THREAD-ALIAS-TOMBSTONE",
          requiredField(record, "internetMessageIdHash"),
        ),
      };
    case "inbox-thread-erasure-fence":
      return inboxThreadErasureFenceKey(
        requiredField(record, "organizationId"),
        requiredField(record, "inboxThreadId"),
      );
    case "end-user-inbox-mail":
      return {
        pk: endUserPartition(
          requiredField(record, "organizationId"),
          requiredField(record, "environmentId"),
          requiredField(record, "endUserKey"),
        ),
        sk: key(
          "END-USER-INBOX-MAIL",
          requiredField(record, "inboxId"),
          requiredField(record, "resourceType"),
          requiredField(record, "resourceId"),
        ),
      };
    case "conversation-inbox-thread":
      return {
        pk: conversationThreadPartition(
          requiredField(record, "organizationId"),
          requiredField(record, "threadId"),
        ),
        sk: key(
          "CONVERSATION-INBOX-THREAD",
          requiredField(record, "inboxThreadId"),
          requiredField(record, "messageId"),
        ),
      };
    case "inbox-thread-conversation":
      return {
        pk: inboxThreadPartition(
          requiredField(record, "organizationId"),
          requiredField(record, "inboxThreadId"),
        ),
        sk: key(
          "INBOX-THREAD-CONVERSATION",
          requiredField(record, "threadId"),
          requiredField(record, "messageId"),
        ),
      };
    default:
      return undefined;
  }
}
