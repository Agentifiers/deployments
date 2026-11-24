import type {
  ConversationErasureItem,
  ConversationErasureMailItem,
  ConversationErasureStore,
  GovernanceOperation,
  TenantRecord,
} from "@deployments-ai/db";
import { makeRetentionInventory } from "./governance-retention-inventory.ts";
import {
  allTenantRecords,
  blobReferences,
  completeRetentionCleanups,
  deleteRecordsAndBlobs,
  retentionCleanupId,
  stageExpiredRecords,
} from "./governance-service-support.ts";
import { GovernanceError, type GovernanceServiceOptions } from "./types.ts";

export interface MailErasureContext {
  readonly leaseDeadline: string;
  readonly now: () => Date;
  readonly operation: GovernanceOperation;
  readonly options: GovernanceServiceOptions;
  readonly store: ConversationErasureStore;
}

async function completeCleanups(
  context: MailErasureContext,
  item: ConversationErasureMailItem,
): Promise<ConversationErasureMailItem> {
  const { now, operation, options, store } = context;
  const { organizationId } = operation;
  const ids = item.data.pendingCleanupIds;
  if (ids.length === 0) return item;
  const cleanups = await store.readRetentionCleanups(organizationId, ids);
  if (cleanups.length > 0) {
    const observedAt = now().toISOString();
    const inventory = makeRetentionInventory("cleanup-only", Date.parse(observedAt));
    await allTenantRecords(options, organizationId, inventory.selection);
    const holders = inventory.liveObjectHolders(cleanups, new Set());
    const liveRecords = holders ? await allTenantRecords(options, organizationId, holders) : [];
    await completeRetentionCleanups(options, organizationId, cleanups, liveRecords, observedAt);
    if ((await store.readRetentionCleanups(organizationId, ids)).length > 0) {
      throw new GovernanceError(
        "conversation_mail_pending",
        "Objects of erased mail are still pending.",
      );
    }
  }
  return store.replaceMailItem(item, { pendingCleanupIds: [] });
}

async function eraseRecords(
  context: MailErasureContext,
  item: ConversationErasureMailItem,
  records: readonly TenantRecord[],
): Promise<ConversationErasureMailItem> {
  const { leaseDeadline, now, operation, options, store } = context;
  const { organizationId } = operation;
  const holders = records.filter(
    ({ record }) => blobReferences(options, organizationId, record, true).length > 0,
  );
  await deleteRecordsAndBlobs(
    options,
    organizationId,
    records.filter((record) => !holders.includes(record)),
    leaseDeadline,
  );
  if (holders.length === 0) return item;
  const tracked = await store.replaceMailItem(item, {
    pendingCleanupIds: [
      ...new Set([...item.data.pendingCleanupIds, ...holders.map(retentionCleanupId)]),
    ].sort(),
  });
  const staged = await stageExpiredRecords(options, organizationId, holders, now().toISOString());
  if (staged.length !== holders.length) {
    throw new GovernanceError(
      "conversation_mail_pending",
      "Mail of an erasure changed while it was being staged.",
    );
  }
  return tracked;
}

async function eraseMailItem(context: MailErasureContext, initial: ConversationErasureMailItem) {
  const { operation, store } = context;
  let item = await completeCleanups(context, initial);
  if (item.data.target.kind === "draft") {
    item = await eraseRecords(context, item, await store.prepareInboxDraftErasure(item));
    item = await completeCleanups(context, item);
    await store.replaceMailItem(item, { stage: "erased" });
    return;
  }
  for (const message of await store.sweepInboxThread(operation, item)) {
    const records = await store.prepareInboxMessageErasure(operation, message);
    item = await eraseRecords(context, item, records);
    item = await store.finishInboxMessage(item, message);
  }
  item = await completeCleanups(context, item);
  await store.settleInboxThread(item);
}

export async function eraseConversationMail(
  context: MailErasureContext,
  items: readonly ConversationErasureItem[],
): Promise<{ readonly emailMessagesErased: number; readonly emailThreadsErased: number }> {
  const { operation, store } = context;
  for (const item of items) {
    if (!item.data.mailPlannedAt) await store.planConversationMail(operation, item);
  }
  let mailItems = await store.listMailItems(operation);
  for (
    let pending = mailItems.filter((item) => item.data.stage === "planned");
    pending.length > 0;
    pending = mailItems.filter((item) => item.data.stage === "planned")
  ) {
    for (const item of pending) await eraseMailItem(context, item);
    mailItems = await store.listMailItems(operation);
  }
  const threads = mailItems.filter((item) => item.data.target.kind === "thread");
  return {
    emailMessagesErased: threads.reduce((total, item) => total + item.data.messagesErased, 0),
    emailThreadsErased: threads.length,
  };
}
