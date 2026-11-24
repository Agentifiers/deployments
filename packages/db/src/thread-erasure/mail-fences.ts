import type { TransactionOperation } from "../client-types.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import { inboxMessageTombstoneKey, inboxThreadErasureFenceKey } from "./record-keys.ts";

type MessageRecord = Extract<PlatformRecord, { readonly itemType: "message" }>;
type LinkItemType = "conversation-inbox-thread" | "inbox-thread-conversation";

function targetKey(key: { readonly pk: string; readonly sk: string }) {
  return `${key.pk}\u0000${key.sk}`;
}

function mailLink(message: MessageRecord, itemType: LinkItemType) {
  const { source } = message.data;
  return withCanonicalRecordKeys({
    data: {
      createdAt: message.data.createdAt,
      environmentId: message.data.environmentId,
      inboxId: source!.inboxId,
      inboxMessageId: source!.inboxMessageId,
      inboxThreadId: source!.inboxThreadId,
      messageId: message.data.id,
      organizationId: message.data.organizationId,
      projectId: message.data.projectId,
      threadId: message.data.threadId,
    },
    itemType,
  }) as Extract<PlatformRecord, { readonly itemType: LinkItemType }>;
}

export function withInboxMailLinks(
  operations: readonly TransactionOperation[],
): readonly TransactionOperation[] {
  return operations.flatMap((operation): TransactionOperation[] =>
    operation.kind === "put" &&
    !operation.previousRecord &&
    operation.record.itemType === "message" &&
    operation.record.data.source
      ? [
          operation,
          { kind: "put", record: mailLink(operation.record, "conversation-inbox-thread") },
          { kind: "put", record: mailLink(operation.record, "inbox-thread-conversation") },
        ]
      : [operation],
  );
}

export function withInboxMailErasureFences(
  operations: readonly TransactionOperation[],
): readonly TransactionOperation[] {
  const targeted = new Set(
    operations.map((operation) =>
      targetKey(operation.kind === "condition-check" ? operation.key : operation.record),
    ),
  );
  const tombstones = new Map<string, TransactionOperation>();
  const fenceFloors = new Map<string, { key: { pk: string; sk: string }; createdAt: string }>();
  const fence = (organizationId: string, inboxThreadId: string, createdAt: string) => {
    const key = inboxThreadErasureFenceKey(organizationId, inboxThreadId);
    const identity = targetKey(key);
    const floor = fenceFloors.get(identity);
    if (!floor || createdAt < floor.createdAt) fenceFloors.set(identity, { createdAt, key });
  };
  const tombstone = (organizationId: string, messageId: string) => {
    const key = inboxMessageTombstoneKey(organizationId, messageId);
    tombstones.set(targetKey(key), {
      conditionExpression: "attribute_not_exists(pk)",
      key,
      kind: "condition-check",
      table: "execution",
    });
  };
  for (const operation of operations) {
    if (operation.kind !== "put") continue;
    const { record } = operation;
    if (record.itemType === "inbox-message") {
      if (record.data.threadId) {
        fence(record.data.organizationId, record.data.threadId, record.data.createdAt);
      } else {
        tombstone(record.data.organizationId, record.data.id);
      }
    }
    if (record.itemType === "message" && record.data.source) {
      const { source } = record.data;
      tombstone(record.data.organizationId, source.inboxMessageId);
      fence(record.data.organizationId, source.inboxThreadId, source.inboxMessageCreatedAt);
    }
  }
  const checks: TransactionOperation[] = [
    ...[...tombstones].flatMap(([identity, check]) => (targeted.has(identity) ? [] : [check])),
    ...[...fenceFloors].flatMap(([identity, { createdAt, key }]): TransactionOperation[] =>
      targeted.has(identity)
        ? []
        : [
            {
              conditionExpression:
                "attribute_not_exists(pk) OR #fenceData.#erasedThrough < :mailCreatedAt",
              expressionAttributeNames: { "#erasedThrough": "erasedThrough", "#fenceData": "data" },
              expressionAttributeValues: { ":mailCreatedAt": createdAt },
              key,
              kind: "condition-check",
              table: "execution",
            },
          ],
    ),
  ];
  return checks.length === 0 ? operations : [...operations, ...checks];
}
