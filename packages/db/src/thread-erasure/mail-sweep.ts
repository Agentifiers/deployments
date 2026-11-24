import { boundedAgentEmailThreadParticipants } from "../agent-email/record-mapping-support.ts";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import type { RetentionCleanup, TenantRecord } from "../governance/contracts.ts";
import type { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import type { EndUserKey } from "../records/conversation-erasure.ts";
import {
  tableForItemType,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "../records/index.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import type { ConversationErasureMailItem } from "./contracts.ts";
import {
  fenceInboxThreads,
  planMail,
  scopeOf,
  type FencedInboxThread,
  type MailOperation,
  type TenantScope,
} from "./mail-planning.ts";
import { only, queryPartition, readByIdentity, type RecordOf } from "./queries.ts";
import { conversationThreadPartition, internetMessageIdHash } from "./record-keys.ts";
import { parseUlid } from "./operations.ts";
import type { ErasureRequestContext } from "./requests.ts";

const MAX_SETTLE_ATTEMPTS = 4;

export interface FencedInboxMessage {
  readonly index: RecordOf<"inbox-message-thread-index">;
  readonly thread: FencedInboxThread;
}

function tenantRecords(records: readonly PlatformRecord[]): TenantRecord[] {
  return records.map((record) => ({ record, table: tableForItemType(record.itemType) }));
}

export async function replaceMailItem(
  database: DynamoDatabaseService,
  item: ConversationErasureMailItem,
  changes: Partial<
    Pick<ConversationErasureMailItem["data"], "messagesErased" | "pendingCleanupIds" | "stage">
  >,
  now: string,
): Promise<ConversationErasureMailItem> {
  const next = withCanonicalRecordKeys({
    ...item,
    data: { ...item.data, ...changes, updatedAt: now, version: item.data.version + 1 },
  }) as ConversationErasureMailItem;
  await database.transactWrite([{ kind: "put", previousRecord: item, record: next }]);
  return next;
}

export async function sweepInboxThread(
  context: ErasureRequestContext,
  operation: MailOperation,
  item: ConversationErasureMailItem,
): Promise<readonly FencedInboxMessage[]> {
  const { database } = context;
  const { inboxId, organizationId, target } = item.data;
  if (target.kind !== "thread") throw new Error("Only an inbox thread mail item can be swept.");
  const indexes = only(
    await queryPartition(
      database,
      "execution",
      conversationThreadPartition(organizationId, target.inboxThreadId),
      "INBOX-MESSAGE-THREAD-INDEX#",
    ),
    "inbox-message-thread-index",
  ).filter(
    (index) => index.data.inboxId === inboxId && index.data.createdAt <= operation.createdAt,
  );
  if (indexes.length === 0) return [];
  const messageIds = new Set<string>(indexes.map((index) => index.data.id));
  const drafts = only(
    await queryPartition(
      database,
      "execution",
      key("ORG", organizationId, "INBOX", inboxId),
      "INBOX-DRAFT#",
    ),
    "inbox-draft",
  ).filter(
    ({ data }) =>
      (data.replyToMessageId !== undefined && messageIds.has(data.replyToMessageId)) ||
      (data.sentMessageId !== undefined && messageIds.has(data.sentMessageId)),
  );
  await planMail(
    context,
    operation,
    [],
    drafts.map(({ data }) => ({ ...scopeOf(data), draftId: data.id, inboxId })),
  );
  const fenced = await fenceInboxThreads(
    database,
    operation,
    [{ ...scopeOf(item.data), inboxId, inboxThreadId: target.inboxThreadId }],
    context.now().toISOString(),
  );
  return fenced.flatMap((thread) => indexes.map((index) => ({ index, thread })));
}

async function mailCompanions(
  database: DynamoDatabaseService,
  scope: TenantScope,
  resource: {
    readonly createdAt: string;
    readonly id: Ulid;
    readonly inboxId: Ulid;
    readonly resourceType: "draft" | "message";
  },
  participantKeys: readonly EndUserKey[],
): Promise<PlatformRecord[]> {
  const { createdAt, id, inboxId, resourceType } = resource;
  const identity = { ...scope, createdAt, id, inboxId };
  const records: (PlatformRecord | undefined)[] = [
    await readByIdentity(
      database,
      "execution",
      resourceType === "message" ? "inbox-message-created-index" : "inbox-draft-created-index",
      identity,
    ),
    await readByIdentity(database, "execution", "inbox-resource-locator", {
      ...identity,
      resourceType,
    }),
  ];
  for (const endUserKey of participantKeys) {
    records.push(
      await readByIdentity(database, "control", "end-user-inbox-mail", {
        ...scope,
        endUserKey,
        inboxId,
        resourceId: id,
        resourceType,
      }),
    );
  }
  records.push(
    ...only(
      await queryPartition(
        database,
        "execution",
        key("ORG", scope.organizationId, "RESOURCE", id),
        "INBOX-CONTENT-CLEANUP#",
      ),
      "inbox-content-cleanup",
    ),
    ...only(
      await queryPartition(
        database,
        "events",
        key("ORG", scope.organizationId, "AGGREGATE", "agent_email", id),
        "SEMANTIC-EVENT#",
      ),
      "semantic-event",
    ),
  );
  return records.filter((record): record is PlatformRecord => record !== undefined);
}

async function createOnce(database: DynamoDatabaseService, record: PlatformRecord) {
  const { pk, sk } = record;
  if (await database.getRecord("execution", { pk, sk })) return;
  try {
    await database.transactWrite([{ kind: "put", record }]);
  } catch (cause) {
    if (!isDatabaseWriteConflict(cause) || !(await database.getRecord("execution", { pk, sk })))
      throw cause;
  }
}

export async function prepareInboxMessageErasure(
  context: ErasureRequestContext,
  operation: MailOperation,
  { index }: FencedInboxMessage,
): Promise<readonly TenantRecord[]> {
  const { database } = context;
  const { createdAt, id, inboxId } = index.data;
  const scope = scopeOf(index.data);
  await createOnce(
    database,
    withCanonicalRecordKeys({
      data: {
        ...scope,
        erasedAt: context.now().toISOString(),
        inboxId,
        messageId: id,
        operationId: parseUlid(operation.id),
      },
      itemType: "inbox-message-tombstone" as const,
    }) as RecordOf<"inbox-message-tombstone">,
  );
  const message = await readByIdentity(database, "execution", "inbox-message", {
    id,
    inboxId,
    organizationId: scope.organizationId,
  });
  const records = await mailCompanions(
    database,
    scope,
    { createdAt, id, inboxId, resourceType: "message" },
    message?.data.participantKeys ?? [],
  );
  const internetMessageId = message?.data.internetMessageId?.trim();
  if (message?.data.threadId && internetMessageId) {
    const alias = await readByIdentity(database, "execution", "inbox-message-thread-alias", {
      ...scope,
      inboxId,
      internetMessageId,
    });
    if (alias?.data.messageId === id) {
      await createOnce(
        database,
        withCanonicalRecordKeys({
          data: {
            ...scope,
            inboxId,
            inboxThreadId: alias.data.threadId,
            internetMessageIdHash: internetMessageIdHash(internetMessageId),
          },
          itemType: "inbox-message-thread-alias-tombstone" as const,
        }) as RecordOf<"inbox-message-thread-alias-tombstone">,
      );
      records.push(alias);
    }
  }
  records.push(
    ...only(
      await queryPartition(
        database,
        "execution",
        key("ORG", scope.organizationId, "INBOX-MESSAGE", id),
        "INBOX-ATTACHMENT#",
      ),
      "inbox-attachment",
    ),
  );
  if (message) records.push(message);
  return tenantRecords(records);
}

export async function prepareInboxDraftErasure(
  context: ErasureRequestContext,
  item: ConversationErasureMailItem,
): Promise<readonly TenantRecord[]> {
  const { database } = context;
  const { inboxId, organizationId, target } = item.data;
  if (target.kind !== "draft") throw new Error("Only a draft mail item names a draft.");
  const draft = await readByIdentity(database, "execution", "inbox-draft", {
    id: target.draftId,
    inboxId,
    organizationId,
  });
  if (!draft) return [];
  const records = await mailCompanions(
    database,
    scopeOf(draft.data),
    { createdAt: draft.data.createdAt, id: draft.data.id, inboxId, resourceType: "draft" },
    draft.data.participantKeys,
  );
  return tenantRecords([...records, draft]);
}

export async function finishInboxMessage(
  database: DynamoDatabaseService,
  item: ConversationErasureMailItem,
  { index }: FencedInboxMessage,
  now: string,
): Promise<ConversationErasureMailItem> {
  const next = withCanonicalRecordKeys({
    ...item,
    data: {
      ...item.data,
      messagesErased: item.data.messagesErased + 1,
      updatedAt: now,
      version: item.data.version + 1,
    },
  }) as ConversationErasureMailItem;
  await database.transactWrite([
    { kind: "delete", record: index },
    { kind: "put", previousRecord: item, record: next },
  ]);
  return next;
}

export async function settleInboxThread(
  context: ErasureRequestContext,
  item: ConversationErasureMailItem,
): Promise<ConversationErasureMailItem> {
  const { database } = context;
  const { inboxId, organizationId, target } = item.data;
  if (target.kind !== "thread") throw new Error("Only an inbox thread mail item can be settled.");
  for (let attempt = 1; ; attempt += 1) {
    const now = context.now().toISOString();
    const erased = withCanonicalRecordKeys({
      ...item,
      data: {
        ...item.data,
        stage: "erased" as const,
        updatedAt: now,
        version: item.data.version + 1,
      },
    }) as ConversationErasureMailItem;
    const operations: TransactionOperation[] = [
      { kind: "put", previousRecord: item, record: erased },
    ];
    const thread = await readByIdentity(database, "execution", "inbox-thread", {
      id: target.inboxThreadId,
      inboxId,
      organizationId,
    });
    if (thread) {
      operations.push(...(await inboxThreadRebuild(database, thread, now)));
    }
    try {
      await database.transactWrite(operations);
      return erased;
    } catch (cause) {
      if (!isDatabaseWriteConflict(cause) || attempt >= MAX_SETTLE_ATTEMPTS) throw cause;
    }
  }
}

async function inboxThreadRebuild(
  database: DynamoDatabaseService,
  thread: RecordOf<"inbox-thread">,
  now: string,
): Promise<TransactionOperation[]> {
  const { id, inboxId, organizationId } = thread.data;
  const survivors: RecordOf<"inbox-message">[] = [];
  const indexes = only(
    await queryPartition(
      database,
      "execution",
      conversationThreadPartition(organizationId, id),
      "INBOX-MESSAGE-THREAD-INDEX#",
    ),
    "inbox-message-thread-index",
  ).filter((index) => index.data.inboxId === inboxId);
  for (const index of indexes) {
    const message = await readByIdentity(database, "execution", "inbox-message", {
      id: index.data.id,
      inboxId,
      organizationId,
    });
    if (message) survivors.push(message);
  }
  survivors.sort((left, right) => left.data.createdAt.localeCompare(right.data.createdAt));
  const createdIndex = (createdAt: string) =>
    withCanonicalRecordKeys({
      data: { ...scopeOf(thread.data), createdAt, id, inboxId },
      itemType: "inbox-thread-created-index" as const,
    }) as RecordOf<"inbox-thread-created-index">;
  const current = await readByIdentity(
    database,
    "execution",
    "inbox-thread-created-index",
    createdIndex(thread.data.createdAt).data,
  );
  const first = survivors[0];
  const last = survivors.at(-1);
  if (!first || !last) {
    return [
      { kind: "delete", record: thread },
      ...(current ? [{ kind: "delete" as const, record: current }] : []),
    ];
  }
  const rebuilt = withCanonicalRecordKeys({
    ...thread,
    data: {
      ...thread.data,
      createdAt: first.data.createdAt,
      lastMessageAt: last.data.createdAt,
      messageCount: survivors.length,
      participants: boundedAgentEmailThreadParticipants(
        survivors.flatMap(({ data }) => [
          data.fromAddress,
          ...data.toAddresses,
          ...data.ccAddresses,
        ]),
      ),
      subject: last.data.subject,
      updatedAt: now,
      version: thread.data.version + 1,
    },
  }) as RecordOf<"inbox-thread">;
  const moved = rebuilt.data.createdAt !== thread.data.createdAt;
  return [
    { kind: "put", previousRecord: thread, record: rebuilt },
    ...(moved && current ? [{ kind: "delete" as const, record: current }] : []),
    ...(moved || !current
      ? [{ kind: "put" as const, record: createdIndex(rebuilt.data.createdAt) }]
      : []),
  ];
}

export async function readRetentionCleanups(
  database: DynamoDatabaseService,
  organizationId: string,
  ids: readonly string[],
): Promise<readonly RetentionCleanup[]> {
  const cleanups: RetentionCleanup[] = [];
  for (const id of ids) {
    const record = await database.getRecord("control", {
      pk: key("ORG", organizationId),
      sk: key("RETENTION-CLEANUP", id),
    });
    if (record?.itemType === "retention-cleanup") cleanups.push(record.data);
  }
  return cleanups;
}
