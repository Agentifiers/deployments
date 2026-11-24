import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import type { GovernanceOperation } from "../governance/contracts.ts";
import type { Ulid } from "../ids.ts";
import type { EndUserKey } from "../records/conversation-erasure.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import type { ConversationErasureItem, ConversationErasureMailItem } from "./contracts.ts";
import { commitInBatches, only, queryPartition, readByIdentity, type RecordOf } from "./queries.ts";
import {
  conversationErasureItemPartition,
  conversationThreadPartition,
  endUserPartition,
  inboxMessageTombstoneKey,
  inboxThreadErasureFenceKey,
  inboxThreadPartition,
} from "./record-keys.ts";
import { parseUlid } from "./operations.ts";
import type { ErasureRequestContext } from "./requests.ts";

export interface TenantScope {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
}

export interface InboxThreadTarget extends TenantScope {
  readonly inboxId: Ulid;
  readonly inboxThreadId: Ulid;
}

export type FencedInboxThread = InboxThreadTarget & { readonly __brand: "FencedInboxThread" };

interface InboxDraftTarget extends TenantScope {
  readonly draftId: Ulid;
  readonly inboxId: Ulid;
}

export interface ConversationThreadTarget extends TenantScope {
  readonly id: Ulid;
}

export type MailOperation = Pick<GovernanceOperation, "createdAt" | "id" | "organizationId">;

export function scopeOf(data: TenantScope): TenantScope {
  return {
    environmentId: data.environmentId,
    organizationId: data.organizationId,
    projectId: data.projectId,
  };
}

function mailItemIdentity(inboxId: string, target: ConversationErasureMailItem["data"]["target"]) {
  return `${inboxId}#${target.kind === "thread" ? target.inboxThreadId : target.draftId}`;
}

export async function linkedInboxThreads(
  database: DynamoDatabaseService,
  organizationId: string,
  threadId: string,
): Promise<readonly InboxThreadTarget[]> {
  const links = only(
    await queryPartition(
      database,
      "execution",
      conversationThreadPartition(organizationId, threadId),
      "CONVERSATION-INBOX-THREAD#",
    ),
    "conversation-inbox-thread",
  );
  const threads = new Map<string, InboxThreadTarget>();
  for (const { data } of links) {
    threads.set(data.inboxThreadId, {
      ...scopeOf(data),
      inboxId: data.inboxId,
      inboxThreadId: data.inboxThreadId,
    });
  }
  return [...threads.values()];
}

export async function inboxThreadFencePuts(
  database: DynamoDatabaseService,
  operation: MailOperation,
  threads: readonly InboxThreadTarget[],
  now: string,
): Promise<TransactionOperation[]> {
  const puts: TransactionOperation[] = [];
  for (const thread of threads) {
    const current = await database.getRecord(
      "execution",
      inboxThreadErasureFenceKey(thread.organizationId, thread.inboxThreadId),
    );
    const fence = current?.itemType === "inbox-thread-erasure-fence" ? current : undefined;
    if (fence && fence.data.erasedThrough >= operation.createdAt) continue;
    const record = withCanonicalRecordKeys({
      data: {
        ...scopeOf(thread),
        createdAt: fence?.data.createdAt ?? now,
        erasedThrough: operation.createdAt,
        inboxId: thread.inboxId,
        inboxThreadId: thread.inboxThreadId,
        operationId: parseUlid(operation.id),
        updatedAt: now,
        version: fence ? fence.data.version + 1 : 1,
      },
      itemType: "inbox-thread-erasure-fence" as const,
    }) as RecordOf<"inbox-thread-erasure-fence">;
    puts.push(fence ? { kind: "put", previousRecord: fence, record } : { kind: "put", record });
  }
  return puts;
}

export async function fenceInboxThreads(
  database: DynamoDatabaseService,
  operation: MailOperation,
  threads: readonly InboxThreadTarget[],
  now: string,
): Promise<readonly FencedInboxThread[]> {
  await commitInBatches(database, await inboxThreadFencePuts(database, operation, threads, now));
  return threads as readonly FencedInboxThread[];
}

export async function listMailItems(
  database: DynamoDatabaseService,
  operation: Pick<GovernanceOperation, "id" | "organizationId">,
): Promise<readonly ConversationErasureMailItem[]> {
  return only(
    await queryPartition(
      database,
      "control",
      conversationErasureItemPartition(operation.organizationId, operation.id),
      "CONVERSATION-ERASURE-MAIL#",
    ),
    "conversation-erasure-mail-item",
  );
}

export async function planMail(
  context: ErasureRequestContext,
  operation: MailOperation,
  threads: readonly InboxThreadTarget[],
  drafts: readonly InboxDraftTarget[],
) {
  const { database } = context;
  const now = context.now().toISOString();
  const planned = new Set(
    (await listMailItems(database, operation)).map((item) =>
      mailItemIdentity(item.data.inboxId, item.data.target),
    ),
  );
  const item = (
    target: TenantScope & { readonly inboxId: Ulid },
    mailTarget: ConversationErasureMailItem["data"]["target"],
  ): TransactionOperation[] =>
    planned.has(mailItemIdentity(target.inboxId, mailTarget))
      ? []
      : [
          {
            kind: "put",
            record: withCanonicalRecordKeys({
              data: {
                ...scopeOf(target),
                createdAt: now,
                inboxId: target.inboxId,
                messagesErased: 0,
                operationId: parseUlid(operation.id),
                pendingCleanupIds: [],
                stage: "planned" as const,
                target: mailTarget,
                updatedAt: now,
                version: 1,
              },
              itemType: "conversation-erasure-mail-item" as const,
            }) as ConversationErasureMailItem,
          },
        ];
  const fenced = await fenceInboxThreads(database, operation, threads, now);
  await commitInBatches(database, [
    ...fenced.flatMap((thread) =>
      item(thread, { inboxThreadId: thread.inboxThreadId, kind: "thread" }),
    ),
    ...drafts.flatMap((draft) => item(draft, { draftId: draft.draftId, kind: "draft" })),
  ]);
}

export async function planConversationMail(
  context: ErasureRequestContext,
  operation: MailOperation,
  item: ConversationErasureItem,
) {
  const threads = await linkedInboxThreads(
    context.database,
    item.data.organizationId,
    item.data.threadId,
  );
  await planMail(context, operation, threads, []);
}

export async function planEndUserMail(
  context: ErasureRequestContext,
  operation: MailOperation,
  subject: { readonly endUserKey: EndUserKey; readonly environmentId: string },
): Promise<readonly ConversationThreadTarget[]> {
  const { database } = context;
  const { organizationId } = operation;
  const rows = only(
    await queryPartition(
      database,
      "control",
      endUserPartition(organizationId, subject.environmentId, subject.endUserKey),
      "END-USER-INBOX-MAIL#",
    ),
    "end-user-inbox-mail",
  ).filter((row) => row.data.createdAt <= operation.createdAt);
  const threads = new Map<string, InboxThreadTarget>();
  const drafts: InboxDraftTarget[] = [];
  const stale: TransactionOperation[] = [];
  for (const row of rows) {
    const resource = await readByIdentity(
      database,
      "execution",
      row.data.resourceType === "message" ? "inbox-message" : "inbox-draft",
      { id: row.data.resourceId, inboxId: row.data.inboxId, organizationId },
    );
    if (!resource) {
      const erased =
        row.data.resourceType === "message" &&
        (await database.getRecord(
          "execution",
          inboxMessageTombstoneKey(organizationId, row.data.resourceId),
        ));
      if (erased) stale.push({ kind: "delete", record: row });
      continue;
    }
    if (!resource.data.participantKeys.includes(subject.endUserKey)) {
      stale.push({ kind: "delete", record: row });
      continue;
    }
    if (resource.itemType === "inbox-draft") {
      drafts.push({
        ...scopeOf(resource.data),
        draftId: resource.data.id,
        inboxId: row.data.inboxId,
      });
    } else if (resource.data.threadId) {
      threads.set(resource.data.threadId, {
        ...scopeOf(resource.data),
        inboxId: row.data.inboxId,
        inboxThreadId: resource.data.threadId,
      });
    }
  }
  await commitInBatches(database, stale);
  await planMail(context, operation, [...threads.values()], drafts);
  const conversations = new Map<string, ConversationThreadTarget>();
  for (const item of await listMailItems(database, operation)) {
    const { target } = item.data;
    if (target.kind !== "thread") continue;
    const links = only(
      await queryPartition(
        database,
        "execution",
        inboxThreadPartition(organizationId, target.inboxThreadId),
        "INBOX-THREAD-CONVERSATION#",
      ),
      "inbox-thread-conversation",
    );
    for (const { data } of links) {
      if (data.createdAt > operation.createdAt || data.environmentId !== subject.environmentId) {
        continue;
      }
      conversations.set(data.threadId, { ...scopeOf(data), id: data.threadId });
    }
  }
  return [...conversations.values()];
}
