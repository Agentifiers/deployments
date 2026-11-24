import {
  MemoryRecord,
  MemoryReviewItemRecord,
  MAX_THREADLESS_STABLE_TENANT_MUTATIONS_PER_TRANSACTION,
  key,
  withCanonicalRecordKeys,
  type TransactionOperation,
  type Ulid,
  memoryPersistence,
} from "@deployments-ai/db";
import { transactWithSemanticEvents } from "@deployments-ai/events";
import type { MemoryLifecycleContext } from "./platform-lifecycle.ts";
import { supersessionIdentityMatches } from "./memory-supersession-identity.ts";
import * as Shared from "./platform-shared.ts";
import * as Types from "./platform-types.ts";
import { type CanonicalMemoryRecord } from "./memory-record.ts";

export function makeMemoryMutationLifecycle(context: MemoryLifecycleContext) {
  const {
    cursorCodec: _cursorCodec,
    database,
    generateId: _generateId,
    now,
    idempotencyReplay,
    completedIdempotency,
    idempotencyOperation,
    eventFor,
    blobCleanupEvent,
    reviewContentCleanupEvent,
    requiredMutableMemory,
    requiredMutableSpace,
    preparedIndexJob,
    queuedIndexJob,
  } = context;

  async function scrubMemoryReviewContent(
    scope: Types.MemoryPlatformScope,
    memoryId: Ulid,
    excludedReviewId?: Ulid,
  ) {
    const reviews: Types.MemoryReviewItem[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await memoryPersistence.find(database, "execution", {
        ExpressionAttributeValues: {
          ":pk": key("ORG", scope.organizationId, "MEMORY", memoryId),
          ":prefix": `${key("MEMORY-REVIEW-ITEM")}#`,
        },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        ConsistentRead: true,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        Limit: Shared.MAX_LIMIT,
      });
      reviews.push(
        ...result.items.filter(
          (value): value is Types.MemoryReviewItem =>
            value.itemType === "memory-review-item" &&
            value.data.id !== excludedReviewId &&
            (value.data.proposedContent !== undefined || value.data.status === "open") &&
            Shared.reviewScopeMatches(value, scope),
        ),
      );
      exclusiveStartKey = result.lastEvaluatedKey;
    } while (exclusiveStartKey);
    const timestamp = Shared.iso(now());
    for (
      let index = 0;
      index < reviews.length;
      index += MAX_THREADLESS_STABLE_TENANT_MUTATIONS_PER_TRANSACTION
    ) {
      await memoryPersistence.commit(
        database,
        reviews
          .slice(index, index + MAX_THREADLESS_STABLE_TENANT_MUTATIONS_PER_TRANSACTION)
          .map((previous) => {
            const { proposedContent: _proposedContent, ...reviewData } = previous.data;
            const resolveDeletedReview = previous.data.status === "open";
            return {
              kind: "put" as const,
              previousRecord: previous,
              record: Shared.record(
                MemoryReviewItemRecord,
                withCanonicalRecordKeys({
                  data: {
                    ...reviewData,
                    ...(resolveDeletedReview
                      ? {
                          decision: "delete" as const,
                          resolutionReason: "Memory was permanently deleted.",
                          resolvedAt: timestamp,
                          ...(scope.principalId
                            ? { resolvedByPrincipalId: scope.principalId }
                            : {}),
                          status: "resolved" as const,
                        }
                      : {}),
                    updatedAt: timestamp,
                    version: previous.data.version + 1,
                  },
                  itemType: "memory-review-item" as const,
                }),
              ),
            };
          }),
      );
    }
  }

  async function mutateMemoryOnce(
    scope: Types.MemoryPlatformScope,
    memoryId: Ulid,
    mutation: "archive" | "delete" | "restore",
    input: { readonly idempotencyKey?: string; readonly reason?: string } = {},
  ) {
    const idempotencyKey = input.idempotencyKey?.trim();
    const reason = input.reason?.trim()
      ? Shared.requireText(input.reason, "Deletion reason", 2_000)
      : undefined;
    const expectedCommandHash = Shared.commandHash({
      memoryId,
      mutation,
      operation: "memory.lifecycle",
      ...(mutation === "delete" && reason ? { reason } : {}),
    });
    const replay = await idempotencyReplay(scope, idempotencyKey, expectedCommandHash);
    if (replay?.[0]) {
      const replayed = await requiredMutableMemory(scope, replay[0]);
      if (mutation === "delete") {
        await scrubMemoryReviewContent(scope, replayed.data.id).catch(() => undefined);
      }
      return replayed;
    }
    const previous = await requiredMutableMemory(scope, memoryId);
    const status =
      mutation === "restore" ? "active" : mutation === "archive" ? "archived" : "deleted";
    if (previous.data.status === status) {
      if (mutation === "delete") {
        await scrubMemoryReviewContent(scope, previous.data.id).catch(() => undefined);
      }
      if (idempotencyKey) {
        const timestampDate = now();
        try {
          await transactWithSemanticEvents(
            database,
            [
              {
                conditionExpression: "#data.#version = :version AND #itemType = :itemType",
                expressionAttributeNames: {
                  "#data": "data",
                  "#itemType": "itemType",
                  "#version": "version",
                },
                expressionAttributeValues: {
                  ":itemType": "memory",
                  ":version": previous.data.version,
                },
                key: { pk: previous.pk, sk: previous.sk },
                kind: "condition-check",
                table: "control",
              },
              idempotencyOperation(
                completedIdempotency({
                  commandHash: expectedCommandHash,
                  idempotencyKey,
                  resourceIds: [previous.data.id],
                  scope,
                  timestamp: timestampDate,
                }),
              ),
            ],
            [],
          );
        } catch (cause) {
          const concurrentReplay = await idempotencyReplay(
            scope,
            idempotencyKey,
            expectedCommandHash,
          );
          if (concurrentReplay?.[0]) return requiredMutableMemory(scope, concurrentReplay[0]);
          throw cause;
        }
      }
      await queuedIndexJob({
        memory: previous,
        operation: mutation,
        scope,
        synchronizationGeneration: Shared.memorySynchronizationGeneration(previous),
      });
      return idempotencyKey ? requiredMutableMemory(scope, memoryId) : previous;
    }
    if (previous.data.status === "deleted" && mutation !== "delete") {
      throw new Types.MemoryPlatformError(
        409,
        "memory_deleted",
        "Deleted memory cannot be restored.",
      );
    }
    if (mutation === "archive" && previous.data.status !== "active") {
      throw new Types.MemoryPlatformError(
        409,
        "invalid_lifecycle",
        "Only active memory can be archived.",
      );
    }
    if (mutation === "restore" && previous.data.status !== "archived") {
      throw new Types.MemoryPlatformError(
        409,
        "invalid_lifecycle",
        "Only archived memory can be restored.",
      );
    }
    if (mutation === "restore") {
      const space = await requiredMutableSpace(scope, previous.data.memorySpaceId);
      if (space.data.status === "archived") {
        throw new Types.MemoryPlatformError(
          409,
          "memory_space_archived",
          "Memory space is archived.",
        );
      }
      if (previous.data.supersededByMemoryId) {
        const replacement = await Shared.loadRecord(
          database,
          "control",
          Shared.memoryKey(scope, previous.data.supersededByMemoryId),
          "memory",
        );
        const currentTimestamp = now().toISOString();
        if (
          replacement &&
          Shared.mutationScopeMatches(replacement, scope) &&
          replacement.data.status === "active" &&
          replacement.data.reviewStatus === "approved" &&
          (!replacement.data.retentionExpiresAt ||
            replacement.data.retentionExpiresAt > currentTimestamp) &&
          (!replacement.data.validFrom || replacement.data.validFrom <= currentTimestamp) &&
          (!replacement.data.validUntil || replacement.data.validUntil > currentTimestamp)
        ) {
          throw new Types.MemoryPlatformError(
            409,
            "memory_superseded",
            "Superseded memory cannot be restored while its replacement is active.",
          );
        }
      }
    }
    if (mutation === "delete" && previous.data.status !== "archived") {
      throw new Types.MemoryPlatformError(
        409,
        "invalid_lifecycle",
        "Archive memory before permanently deleting it.",
      );
    }
    const timestampDate = now();
    const timestamp = Shared.iso(timestampDate);
    const {
      body: _deletedBody,
      bodyRef: _deletedBodyRef,
      metadata: _deletedMetadata,
      ...retainedData
    } = previous.data;
    const {
      archivedAt: _restoredArchivedAt,
      supersededByMemoryId: _restoredSupersededByMemoryId,
      ...restoredData
    } = previous.data;
    const next = Shared.record(
      MemoryRecord,
      withCanonicalRecordKeys({
        data: {
          ...(mutation === "delete"
            ? retainedData
            : mutation === "restore"
              ? restoredData
              : previous.data),
          ...(mutation === "archive" ? { archivedAt: timestamp } : {}),
          ...(mutation === "delete" ? { deletedAt: timestamp } : {}),
          status,
          updatedAt: timestamp,
          version: previous.data.version + 1,
        },
        itemType: "memory" as const,
      }),
    ) as CanonicalMemoryRecord;
    const event = await eventFor({
      aggregateId: next.data.id,
      aggregateType: "memory",
      aggregateVersion: next.data.version + 1,
      eventType: `memory.${mutation === "restore" ? "restored" : status}`,
      payload: {
        status,
        ...(mutation === "delete" && reason ? { reason } : {}),
      },
      scope,
    });
    const indexJob = await preparedIndexJob({
      memory: next,
      operation: mutation,
      scope,
      synchronizationGeneration: Shared.memorySynchronizationGeneration(next),
    });
    let restoredPredecessor: CanonicalMemoryRecord | undefined;
    let restoredPredecessorCondition: CanonicalMemoryRecord | undefined;
    let restoredPredecessorPrevious: CanonicalMemoryRecord | undefined;
    if (
      mutation === "restore" &&
      next.data.reviewStatus === "approved" &&
      next.data.supersedesMemoryId
    ) {
      const predecessor = await requiredMutableMemory(scope, next.data.supersedesMemoryId);
      if (!supersessionIdentityMatches(predecessor, next)) {
        throw new Types.MemoryPlatformError(
          409,
          "invalid_supersession",
          "Superseded memory must have the same scope and thread or agent identity.",
        );
      }
      if (predecessor.data.status === "deleted") {
        throw new Types.MemoryPlatformError(
          409,
          "supersession_predecessor_deleted",
          "Permanently deleted memory cannot be superseded.",
        );
      }
      const currentSuccessorId = predecessor.data.supersededByMemoryId;
      if (currentSuccessorId && currentSuccessorId !== next.data.id) {
        const currentSuccessor = await Shared.loadRecord(
          database,
          "control",
          Shared.memoryKey(scope, currentSuccessorId),
          "memory",
        );
        if (
          currentSuccessor &&
          Shared.mutationScopeMatches(currentSuccessor, scope) &&
          currentSuccessor.data.status === "active" &&
          currentSuccessor.data.reviewStatus === "approved" &&
          (!currentSuccessor.data.retentionExpiresAt ||
            currentSuccessor.data.retentionExpiresAt > timestamp) &&
          (!currentSuccessor.data.validFrom || currentSuccessor.data.validFrom <= timestamp) &&
          (!currentSuccessor.data.validUntil || currentSuccessor.data.validUntil > timestamp)
        ) {
          throw new Types.MemoryPlatformError(
            409,
            "memory_superseded",
            "A different approved replacement is already active for the superseded memory.",
          );
        }
      }
      const successorCurrentlyValid =
        (!next.data.validFrom || next.data.validFrom <= timestamp) &&
        (!next.data.validUntil || next.data.validUntil > timestamp) &&
        (!next.data.retentionExpiresAt || next.data.retentionExpiresAt > timestamp);
      if (!successorCurrentlyValid) {
        throw new Types.MemoryPlatformError(
          409,
          "supersession_successor_inactive",
          "A superseding memory must be active and currently valid before restoration.",
        );
      }
      if (
        predecessor.data.status !== "archived" ||
        predecessor.data.supersededByMemoryId !== next.data.id
      ) {
        restoredPredecessorPrevious = predecessor;
        restoredPredecessor = Shared.record(
          MemoryRecord,
          withCanonicalRecordKeys({
            data: {
              ...predecessor.data,
              archivedAt: predecessor.data.archivedAt ?? timestamp,
              status: "archived" as const,
              supersededByMemoryId: next.data.id,
              updatedAt: timestamp,
              version: predecessor.data.version + 1,
            },
            itemType: "memory" as const,
          }),
        ) as CanonicalMemoryRecord;
      } else {
        restoredPredecessorCondition = predecessor;
      }
    }
    const restoredPredecessorEvent = restoredPredecessor
      ? await eventFor({
          aggregateId: restoredPredecessor.data.id,
          aggregateType: "memory",
          aggregateVersion: restoredPredecessor.data.version + 1,
          eventType: "memory.archived",
          payload: { status: "archived", supersededByMemoryId: next.data.id },
          scope,
        })
      : undefined;
    const restoredPredecessorIndexJob = restoredPredecessor
      ? await preparedIndexJob({
          memory: restoredPredecessor,
          operation: "archive",
          scope,
          synchronizationGeneration: Shared.memorySynchronizationGeneration(restoredPredecessor),
        })
      : undefined;
    const operations: TransactionOperation[] = [
      { kind: "put", previousRecord: previous, record: next },
      ...indexJob.operations,
    ];
    if (restoredPredecessor && restoredPredecessorPrevious && restoredPredecessorIndexJob) {
      operations.push(
        {
          kind: "put",
          previousRecord: restoredPredecessorPrevious,
          record: restoredPredecessor,
        },
        ...restoredPredecessorIndexJob.jobOperations,
      );
    } else if (restoredPredecessorCondition) {
      operations.push({
        conditionExpression: "#itemType = :itemType AND #data.#version = :version",
        expressionAttributeNames: {
          "#data": "data",
          "#itemType": "itemType",
          "#version": "version",
        },
        expressionAttributeValues: {
          ":itemType": "memory",
          ":version": restoredPredecessorCondition.data.version,
        },
        key: {
          pk: restoredPredecessorCondition.pk,
          sk: restoredPredecessorCondition.sk,
        },
        kind: "condition-check",
        table: "control",
      });
    }
    const cleanupEvent =
      mutation === "delete" && previous.data.bodyRef
        ? await blobCleanupEvent(scope, previous.data.bodyRef)
        : undefined;
    const reviewCleanupEvent =
      mutation === "delete" ? await reviewContentCleanupEvent(scope, previous.data.id) : undefined;
    if (idempotencyKey) {
      operations.push(
        idempotencyOperation(
          completedIdempotency({
            commandHash: expectedCommandHash,
            idempotencyKey,
            resourceIds: [next.data.id],
            scope,
            timestamp: timestampDate,
          }),
        ),
      );
    }
    try {
      await transactWithSemanticEvents(database, operations, [
        event,
        ...indexJob.events,
        ...(restoredPredecessorEvent ? [restoredPredecessorEvent] : []),
        ...(restoredPredecessorIndexJob ? restoredPredecessorIndexJob.events : []),
        ...(cleanupEvent ? [cleanupEvent] : []),
        ...(reviewCleanupEvent ? [reviewCleanupEvent] : []),
      ]);
    } catch (cause) {
      const concurrentReplay = await idempotencyReplay(scope, idempotencyKey, expectedCommandHash);
      if (concurrentReplay?.[0]) return requiredMutableMemory(scope, concurrentReplay[0]);
      throw cause;
    }
    if (mutation === "delete") {
      await scrubMemoryReviewContent(scope, next.data.id).catch(() => undefined);
    }
    return next;
  }
  function mutateMemory(
    scope: Types.MemoryPlatformScope,
    memoryId: Ulid,
    mutation: "archive" | "delete" | "restore",
    input: { readonly idempotencyKey?: string; readonly reason?: string } = {},
  ) {
    return Shared.retryDatabaseWriteConflicts(() =>
      mutateMemoryOnce(scope, memoryId, mutation, input),
    );
  }
  return { scrubMemoryReviewContent, mutateMemory };
}

export type MemoryMutationLifecycle = ReturnType<typeof makeMemoryMutationLifecycle>;
