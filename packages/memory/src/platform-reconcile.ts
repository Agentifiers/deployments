import {
  getMemoryIndexVerificationPass,
  key,
  memoryIndexStatePosition,
  MemoryRecord,
  memoryPersistence,
  recordMemoryIndexVerificationPass,
  withCanonicalRecordKeys,
  type MemoryIndexVerificationProgress,
  type Ulid,
} from "@deployments-ai/db";
import { transactWithSemanticEvents } from "@deployments-ai/events";
import { indexRetryBackoffElapsed, isTerminalIndexJob } from "./index-retry-policy.ts";
import { type CanonicalMemoryRecord } from "./memory-record.ts";
import * as Shared from "./platform-shared.ts";
import * as Types from "./platform-types.ts";
import type { MemoryPlatformCore } from "./platform-core.ts";
import type { MemoryPlatformSpaces } from "./platform-spaces.ts";
import { memorySearchPlacementResolver } from "./provider.ts";

const VERIFICATION_PAGE_SIZE = 100;
const VERIFICATION_QUERIES_PER_RUN = 5;
/** Lambda's maximum duration, so no call that claimed the end of a pass is still queuing. */
const VERIFICATION_PASS_RESTART_MS = 15 * 60_000;
const VERIFIED_INDEX_STATUSES = ["deleted", "ready", "suppressed"] as const;

export function makeMemoryPlatformReconcile(
  runtime: Shared.MemoryPlatformRuntime & MemoryPlatformCore & MemoryPlatformSpaces,
) {
  const {
    cursorCodec,
    database,
    generateId,
    now,
    repository,
    eventFor,
    blobCleanupEvent,
    reviewContentCleanupEvent,
    effectivePolicy,
    preparedIndexJob,
    queuedIndexJob,
    dependencies,
  } = runtime;

  /**
   * The newest index job for the memory's current version on `targetId`. Generations are
   * fixed-width epoch microseconds, so the last key under the version prefix is the newest job.
   */
  async function currentVersionIndexJob(
    scope: Types.MemoryPlatformScope,
    memory: CanonicalMemoryRecord,
    targetId: Ulid,
  ) {
    const versionPrefix = Shared.memoryJobKey(
      scope,
      memory.data.id,
      `${targetId}:${memory.data.id}:${memory.data.version}:`,
      targetId,
    );
    const page = await memoryPersistence.find(database, "execution", {
      ConsistentRead: true,
      ExpressionAttributeValues: { ":pk": versionPrefix.pk, ":prefix": versionPrefix.sk },
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      Limit: 1,
      ScanIndexForward: false,
    });
    const latest = page.items[0];
    return latest?.itemType === "memory-index-job" ? latest : undefined;
  }

  const resolvePlacement =
    dependencies.searchRoutingResolver ?? memorySearchPlacementResolver(dependencies);

  /**
   * Reconciles one page of memories. A sweep repairs canonical drift only: tombstones,
   * retention, expiry, and index state that is missing or behind the memory's version or status.
   * It never re-indexes a memory only because its index state is old; `verifyIndexStates` does.
   */
  async function reconcileOnce(
    scope: Types.MemoryPlatformScope,
    input: { readonly cursor?: string } = {},
  ) {
    const page = await Shared.queryEnvironmentRecordPage<CanonicalMemoryRecord>({
      ...(input.cursor ? { cursor: input.cursor } : {}),
      cursorCodec,
      database,
      environmentId: scope.environmentId,
      filter: (memory) => Shared.reconciliationScopeMatches(memory, scope),
      itemType: "memory",
      limit: 100,
      table: "control",
    });
    let queued = 0;
    const currentTime = now();
    const placement = await resolvePlacement(scope.organizationId);
    const generation = Shared.synchronizationGeneration(currentTime, 999);
    const policies = new Map<string, Shared.ReconciledPolicyFields>();
    const spaces = new Map<Ulid, Types.MemorySpace | undefined>();
    for (const originalMemory of page.items) {
      let memory = originalMemory;
      if (
        memory.data.status === "deleted" &&
        (memory.data.body !== undefined ||
          memory.data.bodyRef !== undefined ||
          memory.data.metadata !== undefined)
      ) {
        const {
          body: _deletedBody,
          bodyRef: deletedBodyRef,
          metadata: _deletedMetadata,
          ...retainedData
        } = memory.data;
        const tombstone = Shared.record(
          MemoryRecord,
          withCanonicalRecordKeys({
            data: {
              ...retainedData,
              updatedAt: Shared.iso(currentTime),
              version: memory.data.version + 1,
            },
            itemType: "memory" as const,
          }),
        ) as CanonicalMemoryRecord;
        const indexJob = await preparedIndexJob({
          memory: tombstone,
          operation: "delete",
          scope,
          synchronizationGeneration: generation,
        });
        const repairEvent = await eventFor({
          aggregateId: await generateId(),
          aggregateType: "memory-tombstone-repair",
          aggregateVersion: 1,
          eventType: "memory.tombstone-repaired",
          payload: {
            memoryId: tombstone.data.id,
            status: tombstone.data.status,
          },
          scope,
        });
        const cleanupEvent = deletedBodyRef
          ? await blobCleanupEvent(scope, deletedBodyRef)
          : undefined;
        const reviewCleanupEvent = await reviewContentCleanupEvent(scope, tombstone.data.id);
        await transactWithSemanticEvents(
          database,
          [{ kind: "put", previousRecord: memory, record: tombstone }, ...indexJob.operations],
          [
            repairEvent,
            ...indexJob.events,
            ...(cleanupEvent ? [cleanupEvent] : []),
            reviewCleanupEvent,
          ],
        );
        queued += 1;
        continue;
      }
      const workspaceKey = memory.data.workspaceId ?? "environment";
      let reconciledPolicy = policies.get(workspaceKey);
      if (!reconciledPolicy) {
        reconciledPolicy = Shared.reconciledPolicyFields(
          await effectivePolicy(Shared.memoryOwnedScope(scope, memory.data.workspaceId)),
        );
        policies.set(workspaceKey, reconciledPolicy);
      }
      let space = spaces.get(memory.data.memorySpaceId);
      if (!spaces.has(memory.data.memorySpaceId)) {
        const candidate = await Shared.loadRecord(
          database,
          "control",
          Shared.memorySpaceKey(scope, memory.data.memorySpaceId),
          "memory-space",
        );
        space =
          candidate &&
          Shared.reconciliationScopeMatches(
            candidate,
            Shared.memoryOwnedScope(scope, memory.data.workspaceId),
          )
            ? candidate
            : undefined;
        spaces.set(memory.data.memorySpaceId, space);
      }
      const retentionExpiresAt = Shared.addDays(
        new Date(memory.data.createdAt),
        reconciledPolicy.retentionDays ?? space?.data.retentionDays,
      );
      if (retentionExpiresAt !== memory.data.retentionExpiresAt) {
        const { retentionExpiresAt: _previousRetention, ...memoryData } = memory.data;
        const updated = Shared.record(
          MemoryRecord,
          withCanonicalRecordKeys({
            data: {
              ...memoryData,
              ...(retentionExpiresAt ? { retentionExpiresAt } : {}),
              updatedAt: Shared.iso(currentTime),
              version: memory.data.version + 1,
            },
            itemType: "memory" as const,
          }),
        ) as CanonicalMemoryRecord;
        const indexJob = await preparedIndexJob({
          memory: updated,
          operation: "update",
          scope,
          synchronizationGeneration: generation,
        });
        const retentionEvent = await eventFor({
          aggregateId: updated.data.id,
          aggregateType: "memory",
          aggregateVersion: updated.data.version + 1,
          eventType: "memory.retention-updated",
          payload: {
            retentionEnabled: retentionExpiresAt !== undefined,
            ...(retentionExpiresAt ? { retentionExpiresAt } : {}),
          },
          scope,
        });
        await transactWithSemanticEvents(
          database,
          [{ kind: "put", previousRecord: memory, record: updated }, ...indexJob.operations],
          [retentionEvent, ...indexJob.events],
        );
        memory = updated;
        queued += 1;
      }
      const synchronizationProviders = [
        ...placement.writes,
        ...(placement.candidate ? [placement.candidate] : []),
      ];
      const states = await Promise.all(
        synchronizationProviders.map((provider) =>
          Shared.effectValue(
            repository.getIndexState(scope, memory.data.id, provider.target.targetId),
          ),
        ),
      );
      const allowedSensitivities = Shared.sensitivityModeValues(reconciledPolicy.sensitivityMode);
      const expired =
        memory.data.retentionExpiresAt !== undefined &&
        memory.data.retentionExpiresAt <= currentTime.toISOString();
      if (expired && memory.data.status !== "deleted") {
        const {
          body: _expiredBody,
          bodyRef: expiredBodyRef,
          metadata: _expiredMetadata,
          ...retainedData
        } = memory.data;
        const tombstone = Shared.record(
          MemoryRecord,
          withCanonicalRecordKeys({
            data: {
              ...retainedData,
              deletedAt: Shared.iso(currentTime),
              status: "deleted" as const,
              updatedAt: Shared.iso(currentTime),
              version: memory.data.version + 1,
            },
            itemType: "memory" as const,
          }),
        ) as CanonicalMemoryRecord;
        const indexJob = await preparedIndexJob({
          memory: tombstone,
          operation: "delete",
          scope,
          synchronizationGeneration: generation,
        });
        const expirationEvent = await eventFor({
          aggregateId: tombstone.data.id,
          aggregateType: "memory",
          aggregateVersion: tombstone.data.version + 1,
          eventType: "memory.expired",
          payload: {
            retentionExpiresAt: tombstone.data.retentionExpiresAt!,
            status: tombstone.data.status,
          },
          scope,
        });
        const cleanupEvent = expiredBodyRef
          ? await blobCleanupEvent(scope, expiredBodyRef)
          : undefined;
        const reviewCleanupEvent = await reviewContentCleanupEvent(scope, tombstone.data.id);
        await transactWithSemanticEvents(
          database,
          [{ kind: "put", previousRecord: memory, record: tombstone }, ...indexJob.operations],
          [
            expirationEvent,
            ...indexJob.events,
            ...(cleanupEvent ? [cleanupEvent] : []),
            reviewCleanupEvent,
          ],
        );
        queued += 1;
        continue;
      }
      const expectedStatus =
        memory.data.status === "deleted"
          ? "deleted"
          : space?.data.status === "active" &&
              memory.data.status === "active" &&
              memory.data.reviewStatus === "approved" &&
              allowedSensitivities.includes(memory.data.sensitivity) &&
              !expired
            ? "ready"
            : "suppressed";
      const synchronizationTargets = states.flatMap((state, index) => {
        const terminalSuppression =
          state?.data.status === "suppressed" &&
          state.data.synchronizedVersion === memory.data.version &&
          [
            "embedding-content-too-large",
            "memory-content-hash-mismatch",
            "unsafe-index-content",
          ].includes(state.data.lastError ?? "");
        const reconciledStatus = terminalSuppression ? "suppressed" : expectedStatus;
        return !state ||
          state.data.synchronizedVersion !== memory.data.version ||
          state.data.status !== reconciledStatus
          ? [synchronizationProviders[index]!.target.targetId]
          : [];
      });
      for (const targetId of synchronizationTargets) {
        // Each sweep mints a new generation; without this check a memory whose indexing keeps
        // failing would gain a fresh job, retry budget, and lifecycle events every run. A job
        // still queued, running, or retrying, or one that failed terminally (retries exhausted or
        // rejected target configuration), owns the version until it succeeds or the memory changes.
        const latest = await currentVersionIndexJob(scope, memory, targetId);
        if (
          latest &&
          latest.data.status !== "succeeded" &&
          latest.data.skipReason !== "target-draining"
        ) {
          continue;
        }
        await queuedIndexJob({ memory, scope, synchronizationGeneration: generation, targetId });
        queued += 1;
      }
    }
    if (page.nextCursor) {
      const continuationId = await generateId();
      const continuationEvent = await eventFor({
        aggregateId: continuationId,
        aggregateType: "memory-reconciliation",
        aggregateVersion: 1,
        eventType: "memory.reconcile.continuation",
        payload: {
          cursor: page.nextCursor,
          ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
        },
        scope,
      });
      await transactWithSemanticEvents(database, [], [continuationEvent]);
    }
    return {
      inspected: page.items.length,
      queued,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
  function reconcile(scope: Types.MemoryPlatformScope, input: { readonly cursor?: string } = {}) {
    return Shared.retryDatabaseWriteConflicts(() => reconcileOnce(scope, input));
  }

  /**
   * Re-indexes memories whose settled index state is older than the provider verification
   * interval, at most `limit` per call. Each call resumes the scope's walk over every target's
   * index states, oldest first, where the previous call stopped. A pass covers the states older
   * than the interval when it starts. A call reads at most `VERIFICATION_QUERIES_PER_RUN` pages per
   * target, so other environments' states in a target slow the walk but never stall it. A memory
   * whose current-version job can still run counts toward the limit without a new job. A job that
   * failed terminally holds no slot: its memory gets a fresh job when its turn comes once the
   * backoff that job's next retry would have waited has passed.
   *
   * A call claims its slice by advancing the stored position before it queues anything, and
   * queues nothing when a concurrent call advanced it first. A call that reaches the end of a pass
   * leaves the position there; the first call `VERIFICATION_PASS_RESTART_MS` later starts the next
   * pass, by which time every earlier call has queued its slice or died. A slice whose call died
   * keeps its old index states, so the next pass covers it again.
   */
  async function verifyIndexStates(
    scope: Types.MemoryPlatformScope,
    input: { readonly limit: number },
  ) {
    const currentTime = now();
    const placement = await resolvePlacement(scope.organizationId);
    const targetIds = [
      ...placement.writes,
      ...(placement.candidate ? [placement.candidate] : []),
    ].map((provider) => provider.target.targetId);
    const limit = Math.max(1, Math.floor(input.limit / targetIds.length));
    const newPass: MemoryIndexVerificationProgress = {
      cutoff: Shared.iso(new Date(currentTime.getTime() - Shared.RECONCILIATION_RESYNC_MS)),
      indexStatus: VERIFIED_INDEX_STATUSES[0],
    };
    const generation = Shared.synchronizationGeneration(currentTime, 999);
    let queued = 0;
    for (const targetId of targetIds) {
      const previous = await getMemoryIndexVerificationPass(database, scope, targetId);
      let progress: MemoryIndexVerificationProgress = previous?.data ?? newPass;
      const start = progress;
      const due: CanonicalMemoryRecord[] = [];
      let counted = 0;
      walk: for (
        let query = 0;
        query < VERIFICATION_QUERIES_PER_RUN && counted < limit;
        query += 1
      ) {
        const page = await memoryPersistence.find(database, "control", {
          ExpressionAttributeValues: {
            ":from": `${key("MEMORY-INDEX-STATE", progress.indexStatus)}#`,
            ":pk": key("MEMORY-SEARCH-TARGET", targetId),
            ":to": key("MEMORY-INDEX-STATE", progress.indexStatus, progress.cutoff),
          },
          ...(progress.resumeAfter ? { ExclusiveStartKey: progress.resumeAfter } : {}),
          IndexName: "gsi2",
          KeyConditionExpression: "gsi2pk = :pk AND gsi2sk BETWEEN :from AND :to",
          Limit: VERIFICATION_PAGE_SIZE,
          ScanIndexForward: true,
        });
        for (const state of page.items) {
          if (counted === limit) break walk;
          progress = { ...progress, resumeAfter: memoryIndexStatePosition(state) };
          if (
            state.itemType !== "memory-index-state" ||
            state.data.environmentId !== scope.environmentId
          ) {
            continue;
          }
          const memory = await Shared.loadRecord(
            database,
            "control",
            Shared.memoryKey(scope, state.data.memoryId),
            "memory",
          );
          if (
            !memory ||
            !Shared.reconciliationScopeMatches(memory, scope) ||
            memory.data.version !== state.data.synchronizedVersion
          ) {
            continue;
          }
          const latest = await currentVersionIndexJob(scope, memory, targetId);
          const runnable = latest !== undefined && !isTerminalIndexJob(latest);
          if (
            !runnable &&
            latest?.data.status === "failed" &&
            !indexRetryBackoffElapsed(latest, currentTime)
          ) {
            continue;
          }
          counted += 1;
          if (!runnable) due.push(memory);
        }
        if (page.lastEvaluatedKey) continue;
        const nextStatus =
          VERIFIED_INDEX_STATUSES[VERIFIED_INDEX_STATUSES.indexOf(progress.indexStatus) + 1];
        if (nextStatus) {
          progress = { cutoff: progress.cutoff, indexStatus: nextStatus };
          continue;
        }
        if (progress !== start) break;
        if (
          previous &&
          Date.parse(previous.data.updatedAt) + VERIFICATION_PASS_RESTART_MS > currentTime.getTime()
        ) {
          break;
        }
        progress = newPass;
      }
      if (progress === start) continue;
      const claimed = await recordMemoryIndexVerificationPass(database, {
        now: currentTime.toISOString(),
        previous,
        progress,
        scope,
        targetId,
      });
      if (!claimed) continue;
      for (const memory of due) {
        await queuedIndexJob({ memory, scope, synchronizationGeneration: generation, targetId });
        queued += 1;
      }
    }
    return { queued };
  }

  return {
    reconcile,
    verifyIndexStates,
  };
}
