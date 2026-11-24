import { governanceRecordTimestamp, type PlatformRecord } from "@deployments-ai/db";
import { makeRetentionInventory } from "./governance-retention-inventory.ts";
import type { GovernanceServiceContext } from "./service.ts";
import {
  allTenantRecords,
  completeRetentionCleanups,
  DAY_MILLISECONDS,
  isActive,
  RETENTION_FENCE_LEASE_MILLISECONDS,
  retentionClass,
  stageExpiredRecords,
} from "./service.ts";
import {
  GovernanceError,
  RETENTION_CLASSES,
  type RetentionClass,
  type TenantRecord,
} from "./types.ts";

function retentionResult(deleted: readonly TenantRecord[]) {
  return {
    deletedByClass: Object.fromEntries(
      RETENTION_CLASSES.map((category) => [
        category,
        deleted.filter((item) => retentionClass(item.record) === category).length,
      ]),
    ) as Record<RetentionClass, number>,
    recordsDeleted: deleted.length,
  };
}

export function makeGovernanceRetentionRunner(context: GovernanceServiceContext) {
  const {
    getOperation: _getOperation,
    getRetentionPolicy,
    now,
    options,
    writeObject: _writeObject,
  } = context;
  return async (organizationId: string) => {
    const retentionStartedAt = now();
    const retentionFence = (await options.store.organizationExists(organizationId))
      ? {
          createdAt: retentionStartedAt.toISOString(),
          leaseExpiresAt: new Date(
            retentionStartedAt.getTime() + RETENTION_FENCE_LEASE_MILLISECONDS,
          ).toISOString(),
          operationId: await options.generateId(),
          organizationId,
        }
      : undefined;
    let retentionFenceHeld = false;
    if (retentionFence) {
      try {
        await options.store.beginErasure(retentionFence);
      } catch (cause) {
        if (cause instanceof GovernanceError && cause.code === "tenant_erasure_in_progress") {
          return retentionResult([]);
        }
        throw cause;
      }
      retentionFenceHeld = true;
    }
    try {
      const policy = await getRetentionPolicy(organizationId);
      const currentTime = retentionStartedAt.getTime();
      const inventory = makeRetentionInventory(policy, currentTime);
      const records = await allTenantRecords(options, organizationId, inventory.selection);
      const openTraceRunIds = new Set(
        records.flatMap(({ record }) =>
          record.itemType === "trace" && record.data.status === "open" ? record.data.runIds : [],
        ),
      );
      const unresolvedPublicationRunIds = new Set(
        records.flatMap(({ record }) =>
          record.itemType === "message-publication" &&
          (record.data.status === "reserved" || record.data.status === "committed")
            ? [record.data.runId]
            : [],
        ),
      );
      const unresolvedPublicationThreadIds = new Set(
        records.flatMap(({ record }) =>
          record.itemType === "message-publication" &&
          (record.data.status === "reserved" || record.data.status === "committed")
            ? [record.data.threadId]
            : [],
        ),
      );
      const activeRuns = records
        .map(({ record }) => record)
        .filter(
          (record): record is Extract<PlatformRecord, { readonly itemType: "run" }> =>
            record.itemType === "run" &&
            (isActive(record) ||
              openTraceRunIds.has(record.data.id) ||
              unresolvedPublicationRunIds.has(record.data.id)),
        );
      const activeRunIds = new Set<string>([
        ...openTraceRunIds,
        ...activeRuns.map((record) => record.data.id),
      ]);
      const activeWorkflowExecutionIds = records
        .map(({ record }) => record)
        .filter(
          (
            record,
          ): record is Extract<PlatformRecord, { readonly itemType: "workflow-execution" }> =>
            record.itemType === "workflow-execution" && isActive(record),
        )
        .map((record) => record.data.id);
      const activeExecutionIds = new Set<string>([...activeRunIds, ...activeWorkflowExecutionIds]);
      const activeThreadIds = new Set<string>([
        ...unresolvedPublicationThreadIds,
        ...activeRuns.map((record) => record.data.threadId),
      ]);
      const activeInboxMessages = records
        .map(({ record }) => record)
        .filter(
          (record): record is Extract<PlatformRecord, { readonly itemType: "inbox-message" }> =>
            record.itemType === "inbox-message" && isActive(record),
        );
      const activeInboxDrafts = records
        .map(({ record }) => record)
        .filter(
          (record): record is Extract<PlatformRecord, { readonly itemType: "inbox-draft" }> =>
            record.itemType === "inbox-draft" && isActive(record),
        );
      const activeDraftReplyMessageIds = new Set<string>(
        activeInboxDrafts.flatMap((record) =>
          record.data.replyToMessageId ? [record.data.replyToMessageId] : [],
        ),
      );
      const activeDraftReplyMessages = records
        .map(({ record }) => record)
        .filter(
          (record): record is Extract<PlatformRecord, { readonly itemType: "inbox-message" }> =>
            record.itemType === "inbox-message" && activeDraftReplyMessageIds.has(record.data.id),
        );
      const activeInboxMessageIds = new Set<string>([
        ...activeInboxMessages.map((record) => record.data.id),
        ...activeDraftReplyMessageIds,
      ]);
      const activeInboxThreadIds = new Set<string>(
        [...activeInboxMessages, ...activeDraftReplyMessages].flatMap((record) =>
          record.data.threadId ? [record.data.threadId] : [],
        ),
      );
      const belongsToActiveRun = (record: PlatformRecord) => {
        const data = record.data as Readonly<Record<string, unknown>>;
        return (
          (typeof data.id === "string" && activeExecutionIds.has(data.id)) ||
          (typeof data.runId === "string" && activeExecutionIds.has(data.runId)) ||
          (typeof data.parentRunId === "string" && activeRunIds.has(data.parentRunId)) ||
          (typeof data.childRunId === "string" && activeRunIds.has(data.childRunId)) ||
          (typeof data.threadId === "string" && activeThreadIds.has(data.threadId)) ||
          (record.itemType === "semantic-event" &&
            data.aggregateType === "thread" &&
            typeof data.aggregateId === "string" &&
            activeThreadIds.has(data.aggregateId)) ||
          (record.itemType === "thread" &&
            typeof data.id === "string" &&
            activeThreadIds.has(data.id))
        );
      };
      const belongsToActiveInboxWork = (record: PlatformRecord) => {
        const data = record.data as Readonly<Record<string, unknown>>;
        return (
          (record.itemType === "inbox-message" &&
            typeof data.id === "string" &&
            activeInboxMessageIds.has(data.id)) ||
          (typeof data.inboxMessageId === "string" &&
            activeInboxMessageIds.has(data.inboxMessageId)) ||
          (record.itemType === "inbox-thread" &&
            typeof data.id === "string" &&
            activeInboxThreadIds.has(data.id))
        );
      };
      const retentionExpired = records.filter(({ record }) => {
        const category = retentionClass(record);
        const timestamp = governanceRecordTimestamp(record);
        if (
          !category ||
          !timestamp ||
          isActive(record) ||
          belongsToActiveRun(record) ||
          belongsToActiveInboxWork(record)
        ) {
          return false;
        }
        if (
          record.itemType === "immutable-audit-export" &&
          typeof record.data.retainedUntil === "string"
        ) {
          return Date.parse(record.data.retainedUntil) <= currentTime;
        }
        if (record.itemType === "governance-operation" && record.data.kind === "audit-export") {
          if (typeof record.data.auditRetainedUntil === "string") {
            return Date.parse(record.data.auditRetainedUntil) <= currentTime;
          }
          const retainedUntil = (
            record.data.summary as Readonly<Record<string, unknown>> | undefined
          )?.retainedUntil;
          if (typeof retainedUntil === "string") {
            return Date.parse(retainedUntil) <= currentTime;
          }
        }
        if (record.itemType === "artifact" && typeof record.data.retentionExpiresAt === "string") {
          return Date.parse(record.data.retentionExpiresAt) <= currentTime;
        }
        return Date.parse(timestamp) + policy[category] * DAY_MILLISECONDS <= currentTime;
      });
      const isEmailParent = (record: PlatformRecord) =>
        record.itemType === "inbox-message" ||
        record.itemType === "inbox-draft" ||
        record.itemType === "inbox-thread";
      const isEmailParentType = (itemType: string) =>
        itemType === "inbox-message" || itemType === "inbox-draft" || itemType === "inbox-thread";
      type SnapshotItem = (typeof records)[number];
      const messageCompanions = new Map<string, SnapshotItem[]>();
      const draftCompanions = new Map<string, SnapshotItem[]>();
      const threadCompanions = new Map<string, SnapshotItem[]>();
      const addCompanion = (index: Map<string, SnapshotItem[]>, id: string, item: SnapshotItem) => {
        const existing = index.get(id);
        if (existing) existing.push(item);
        else index.set(id, [item]);
      };
      for (const item of records) {
        switch (item.record.itemType) {
          case "inbox-message-created-index":
          case "inbox-message-thread-index":
            addCompanion(messageCompanions, item.record.data.id, item);
            break;
          case "inbox-draft-created-index":
            addCompanion(draftCompanions, item.record.data.id, item);
            break;
          case "inbox-thread-created-index":
            addCompanion(threadCompanions, item.record.data.id, item);
            break;
          case "inbox-resource-locator":
            addCompanion(
              item.record.data.resourceType === "message" ? messageCompanions : draftCompanions,
              item.record.data.id,
              item,
            );
            break;
          case "inbox-message-thread-alias":
            addCompanion(threadCompanions, item.record.data.threadId, item);
            break;
        }
      }
      const companionsFor = (itemType: string, resourceId: string) => {
        switch (itemType) {
          case "inbox-message":
            return messageCompanions.get(resourceId) ?? [];
          case "inbox-draft":
            return draftCompanions.get(resourceId) ?? [];
          case "inbox-thread":
            return threadCompanions.get(resourceId) ?? [];
          default:
            return [];
        }
      };
      const existingCleanups = records.flatMap((item) =>
        item.record.itemType === "retention-cleanup" ? [item.record.data] : [],
      );
      const deferredCleanupIds = new Set<string>();
      const staged = await stageExpiredRecords(
        options,
        organizationId,
        retentionExpired.filter(({ record }) => !isEmailParent(record)),
        retentionStartedAt.toISOString(),
        retentionFence?.operationId,
      );
      for (const parent of retentionExpired.filter(({ record }) => isEmailParent(record))) {
        const stagedParent = await stageExpiredRecords(
          options,
          organizationId,
          [parent],
          retentionStartedAt.toISOString(),
          retentionFence?.operationId,
        );
        if (stagedParent.length === 0) continue;
        staged.push(...stagedParent);
        const parentCleanup = stagedParent[0]!.cleanup;
        const resourceId = (parent.record.data as Readonly<Record<string, unknown>>).id;
        if (typeof resourceId !== "string") {
          deferredCleanupIds.add(parentCleanup.id);
          continue;
        }
        const companions = companionsFor(parent.record.itemType, resourceId);
        const stagedCompanions = await stageExpiredRecords(
          options,
          organizationId,
          companions,
          retentionStartedAt.toISOString(),
          retentionFence?.operationId,
        );
        staged.push(...stagedCompanions);
        if (stagedCompanions.length !== companions.length) {
          deferredCleanupIds.add(parentCleanup.id);
        }
      }
      for (const cleanup of existingCleanups) {
        if (!isEmailParentType(cleanup.sourceItemType) || !cleanup.sourceResourceId) continue;
        const companions = companionsFor(cleanup.sourceItemType, cleanup.sourceResourceId);
        const stagedCompanions = await stageExpiredRecords(
          options,
          organizationId,
          companions,
          retentionStartedAt.toISOString(),
          retentionFence?.operationId,
        );
        staged.push(...stagedCompanions);
        if (stagedCompanions.length !== companions.length) {
          deferredCleanupIds.add(cleanup.id);
        }
      }
      const stagedKeys = new Set(
        staged.map(({ item }) => `${item.table}\u0000${item.record.pk}\u0000${item.record.sk}`),
      );
      const pendingCleanups = [...existingCleanups, ...staged.map(({ cleanup }) => cleanup)].filter(
        (cleanup) => !deferredCleanupIds.has(cleanup.id),
      );
      // Records the selective inventory skipped can still reference an object a cleanup deletes;
      // strongly re-read exactly those before deleting any object.
      const objectHolders = inventory.liveObjectHolders(pendingCleanups, stagedKeys);
      const liveRecords = [
        ...records,
        ...(objectHolders ? await allTenantRecords(options, organizationId, objectHolders) : []),
      ].filter(
        (item) => !stagedKeys.has(`${item.table}\u0000${item.record.pk}\u0000${item.record.sk}`),
      );
      await completeRetentionCleanups(
        options,
        organizationId,
        pendingCleanups,
        liveRecords,
        retentionStartedAt.toISOString(),
      );
      if (retentionFence) {
        await options.store.releaseErasureFence(retentionFence);
        retentionFenceHeld = false;
      }
      return retentionResult(staged.map(({ item }) => item));
    } finally {
      if (retentionFenceHeld && retentionFence) {
        await options.store.releaseErasureFence(retentionFence);
      }
    }
  };
}
