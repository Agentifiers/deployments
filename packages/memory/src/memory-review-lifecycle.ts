import {
  MemoryRecord,
  MemoryReviewItemRecord,
  key,
  withCanonicalRecordKeys,
  type Ulid,
  memoryPersistence,
} from "@deployments-ai/db";
import { transactWithSemanticEvents } from "@deployments-ai/events";
import { inspectMemoryContent, memoryContentHash } from "./governance.ts";
import type { MemoryMutationLifecycle } from "./memory-mutation-lifecycle.ts";
import type { MemoryLifecycleContext } from "./platform-lifecycle.ts";
import { supersessionIdentityMatches } from "./memory-supersession-identity.ts";
import * as Shared from "./platform-shared.ts";
import * as Types from "./platform-types.ts";
import { type CanonicalMemoryRecord } from "./memory-record.ts";

export function makeMemoryReviewLifecycle(
  context: MemoryLifecycleContext & MemoryMutationLifecycle,
) {
  const {
    cursorCodec,
    database,
    generateId,
    now,
    idempotencyReplay,
    completedIdempotency,
    idempotencyOperation,
    eventFor,
    blobCleanupEvent,
    reviewContentCleanupEvent,
    requiredMutableMemory,
    requiredMutableSpace: _requiredMutableSpace,
    preparedIndexJob,
    queuedIndexJob,
    scrubMemoryReviewContent,
  } = context;

  async function listReviewItems(
    scope: Types.MemoryPlatformScope,
    input: {
      readonly limit?: number;
      readonly status?: Types.MemoryReviewItem["data"]["status"];
    } = {},
  ) {
    const reviews = await Shared.queryEnvironmentRecords<Types.MemoryReviewItem>({
      database,
      environmentId: scope.environmentId,
      filter: (review) => Shared.reviewScopeMatches(review, scope),
      itemType: "memory-review-item",
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.status ? { status: input.status } : {}),
      table: "execution",
    });
    return reviews;
  }

  async function listReviewItemsPage(
    scope: Types.MemoryPlatformScope,
    input: {
      readonly cursor?: string;
      readonly limit?: number;
      readonly status?: Types.MemoryReviewItem["data"]["status"];
    } = {},
  ) {
    const page = await Shared.queryEnvironmentRecordPage<Types.MemoryReviewItem>({
      ...(input.cursor ? { cursor: input.cursor } : {}),
      cursorCodec,
      database,
      environmentId: scope.environmentId,
      filter: (review) => Shared.reviewScopeMatches(review, scope),
      itemType: "memory-review-item",
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.status ? { status: input.status } : {}),
      table: "execution",
    });
    const canonical = await Promise.all(
      page.items.map((review) =>
        Shared.loadRecord(
          database,
          "execution",
          { pk: review.pk, sk: review.sk },
          "memory-review-item",
        ),
      ),
    );
    return {
      ...page,
      items: canonical.filter(
        (review): review is Types.MemoryReviewItem =>
          review !== undefined &&
          Shared.reviewScopeMatches(review, scope) &&
          (!input.status || review.data.status === input.status),
      ),
    };
  }

  async function openReviewForMemory(scope: Types.MemoryPlatformScope, memoryId: Ulid) {
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
        ScanIndexForward: false,
      });
      const review = result.items.find(
        (value): value is Types.MemoryReviewItem =>
          value.itemType === "memory-review-item" &&
          value.data.status === "open" &&
          Shared.reviewScopeMatches(value, scope),
      );
      if (review) return review;
      exclusiveStartKey = result.lastEvaluatedKey;
    } while (exclusiveStartKey);
    return undefined;
  }

  async function resolveReviewOnce(
    scope: Types.MemoryPlatformScope,
    input: {
      readonly content?: string;
      readonly decision: "approve" | "archive" | "delete" | "edit" | "reject";
      readonly idempotencyKey?: string;
      readonly reason?: string;
      readonly reviewId: Ulid;
      readonly memoryId: Ulid;
    },
  ) {
    const idempotencyKey = input.idempotencyKey?.trim();
    const resolutionReason = input.reason?.trim()
      ? Shared.requireText(input.reason, "Review reason", 2_000)
      : undefined;
    const editedContent =
      input.decision === "edit"
        ? inspectMemoryContent(Shared.embeddableText(input.content ?? "", "Replacement content"))
        : undefined;
    if (editedContent?.blockedReason) {
      throw new Types.MemoryPlatformError(400, "unsafe_content", editedContent.blockedReason);
    }
    const expectedCommandHash = Shared.commandHash({
      content: input.content?.trim(),
      decision: input.decision,
      memoryId: input.memoryId,
      operation: "memory-review.resolve",
      ...(resolutionReason ? { reason: resolutionReason } : {}),
      reviewId: input.reviewId,
    });
    const replay = await idempotencyReplay(scope, idempotencyKey, expectedCommandHash);
    if (replay?.[0]) {
      const memory = await requiredMutableMemory(scope, input.memoryId);
      const review = await Shared.loadRecord(
        database,
        "execution",
        Shared.memoryReviewKey(scope, input.memoryId, input.reviewId),
        "memory-review-item",
      );
      if (review && Shared.reviewScopeMatches(review, scope)) {
        if (input.decision === "delete") {
          await scrubMemoryReviewContent(scope, memory.data.id, review.data.id).catch(
            () => undefined,
          );
        }
        return { memory, review };
      }
    }
    const previousMemory = await requiredMutableMemory(scope, input.memoryId);
    const previousReview = await Shared.loadRecord(
      database,
      "execution",
      Shared.memoryReviewKey(scope, input.memoryId, input.reviewId),
      "memory-review-item",
    );
    if (!previousReview || !Shared.mutationScopeMatches(previousReview, scope)) {
      throw new Types.MemoryPlatformError(
        404,
        "review_not_found",
        "Memory review item was not found.",
      );
    }
    if (previousMemory.data.status === "deleted") {
      throw new Types.MemoryPlatformError(
        409,
        "review_memory_deleted",
        "Permanently deleted memory cannot be reviewed or edited.",
      );
    }
    if (previousReview.data.status !== "open") {
      if (
        previousReview.data.decision !== input.decision ||
        previousReview.data.resolutionReason !== resolutionReason ||
        (editedContent !== undefined &&
          memoryContentHash(editedContent.content) !== previousMemory.data.contentHash)
      ) {
        throw new Types.MemoryPlatformError(
          409,
          "review_decision_conflict",
          "Memory review was already resolved with a different resolution.",
        );
      }
      await queuedIndexJob({
        memory: previousMemory,
        scope,
        synchronizationGeneration: Shared.memorySynchronizationGeneration(previousMemory),
      });
      return { memory: previousMemory, review: previousReview };
    }
    let body = previousMemory.data.body;
    let contentHash = previousMemory.data.contentHash;
    let sensitivity = previousMemory.data.sensitivity;
    let reviewStatus: CanonicalMemoryRecord["data"]["reviewStatus"] =
      input.decision === "approve"
        ? "approved"
        : input.decision === "archive"
          ? previousMemory.data.reviewStatus
          : "rejected";
    let status: CanonicalMemoryRecord["data"]["status"] =
      input.decision === "delete"
        ? "deleted"
        : input.decision === "archive"
          ? "archived"
          : previousMemory.data.status;
    if (editedContent) {
      body = editedContent.content;
      contentHash = memoryContentHash(body);
      reviewStatus = editedContent.reviewStatus;
      sensitivity = editedContent.sensitivity;
    }
    const {
      body: _deletedBody,
      bodyRef: _deletedBodyRef,
      metadata: _deletedMetadata,
      ...retainedMemoryData
    } = previousMemory.data;
    const { bodyRef: _replacedBodyRef, ...memoryDataWithoutBodyRef } = previousMemory.data;
    const timestampDate = now();
    const timestamp = Shared.iso(timestampDate);
    const memory = Shared.record(
      MemoryRecord,
      withCanonicalRecordKeys({
        data: {
          ...(status === "deleted"
            ? retainedMemoryData
            : input.decision === "edit"
              ? memoryDataWithoutBodyRef
              : previousMemory.data),
          ...(status === "deleted" ? {} : { body }),
          ...(input.decision === "archive" ? { archivedAt: timestamp } : {}),
          contentHash,
          ...(status === "deleted" ? { deletedAt: timestamp } : {}),
          reviewStatus,
          ...(input.decision === "approve" ? { reviewerApprovedContentHash: contentHash } : {}),
          sensitivity,
          status,
          updatedAt: timestamp,
          version: previousMemory.data.version + 1,
        },
        itemType: "memory" as const,
      }),
    ) as CanonicalMemoryRecord;
    if (memory.data.reviewStatus === "approved" && memory.data.supersededByMemoryId) {
      const replacement = await Shared.loadRecord(
        database,
        "control",
        Shared.memoryKey(scope, memory.data.supersededByMemoryId),
        "memory",
      );
      if (
        replacement &&
        Shared.mutationScopeMatches(replacement, scope) &&
        replacement.data.status === "active" &&
        replacement.data.reviewStatus === "approved" &&
        (!replacement.data.retentionExpiresAt || replacement.data.retentionExpiresAt > timestamp) &&
        (!replacement.data.validFrom || replacement.data.validFrom <= timestamp) &&
        (!replacement.data.validUntil || replacement.data.validUntil > timestamp)
      ) {
        throw new Types.MemoryPlatformError(
          409,
          "memory_superseded",
          "Superseded memory cannot be approved while its replacement is active.",
        );
      }
    }
    const successorCurrentlyValid =
      memory.data.status === "active" &&
      (!memory.data.validFrom || memory.data.validFrom <= timestamp) &&
      (!memory.data.validUntil || memory.data.validUntil > timestamp) &&
      (!memory.data.retentionExpiresAt || memory.data.retentionExpiresAt > timestamp);
    if (
      memory.data.reviewStatus === "approved" &&
      memory.data.supersedesMemoryId &&
      !successorCurrentlyValid
    ) {
      throw new Types.MemoryPlatformError(
        409,
        "supersession_successor_inactive",
        "A superseding memory must be active and currently valid before approval.",
      );
    }
    const predecessor =
      memory.data.reviewStatus === "approved" && memory.data.supersedesMemoryId
        ? await requiredMutableMemory(scope, memory.data.supersedesMemoryId)
        : undefined;
    if (predecessor?.data.status === "deleted") {
      throw new Types.MemoryPlatformError(
        409,
        "supersession_predecessor_deleted",
        "Permanently deleted memory cannot be superseded.",
      );
    }
    if (predecessor && !supersessionIdentityMatches(predecessor, memory)) {
      throw new Types.MemoryPlatformError(
        409,
        "invalid_supersession",
        "Superseded memory must have the same scope and thread or agent identity.",
      );
    }
    if (
      predecessor?.data.supersededByMemoryId &&
      predecessor.data.supersededByMemoryId !== memory.data.id
    ) {
      const currentSuccessor = await Shared.loadRecord(
        database,
        "control",
        Shared.memoryKey(scope, predecessor.data.supersededByMemoryId),
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
    const predecessorArchived =
      predecessor?.data.status === "active" && predecessor.data.reviewStatus === "approved";
    const superseded = predecessor
      ? (Shared.record(
          MemoryRecord,
          withCanonicalRecordKeys({
            data: {
              ...predecessor.data,
              ...(predecessorArchived
                ? { archivedAt: timestamp, status: "archived" as const }
                : {}),
              supersededByMemoryId: memory.data.id,
              updatedAt: timestamp,
              version: predecessor.data.version + 1,
            },
            itemType: "memory" as const,
          }),
        ) as CanonicalMemoryRecord)
      : undefined;
    const { proposedContent: _proposedContent, ...retainedReviewData } = previousReview.data;
    const review = Shared.record(
      MemoryReviewItemRecord,
      withCanonicalRecordKeys({
        data: {
          ...retainedReviewData,
          decision: input.decision,
          ...(resolutionReason ? { resolutionReason } : {}),
          resolvedAt: timestamp,
          ...(scope.principalId ? { resolvedByPrincipalId: scope.principalId } : {}),
          status: "resolved" as const,
          updatedAt: timestamp,
          version: previousReview.data.version + 1,
        },
        itemType: "memory-review-item" as const,
      }),
    );
    const operations: Parameters<typeof transactWithSemanticEvents>[1][number][] = [
      { kind: "put", previousRecord: previousMemory, record: memory },
      { kind: "put", previousRecord: previousReview, record: review },
    ];
    if (idempotencyKey) {
      operations.push(
        idempotencyOperation(
          completedIdempotency({
            commandHash: expectedCommandHash,
            idempotencyKey,
            resourceIds: [memory.data.id, review.data.id],
            scope,
            timestamp: timestampDate,
          }),
        ),
      );
    }
    if ((input.decision === "edit" || input.decision === "archive") && reviewStatus === "pending") {
      operations.push({
        kind: "put",
        record: Shared.record(
          MemoryReviewItemRecord,
          withCanonicalRecordKeys({
            data: {
              createdAt: timestamp,
              environmentId: scope.environmentId,
              id: await generateId(),
              kind: "content-governance",
              memoryId: memory.data.id,
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              reason:
                input.decision === "edit"
                  ? "Edited memory requires another governance review before recall."
                  : "Archived memory requires governance review before it can be recalled after restoration.",
              status: "open" as const,
              updatedAt: timestamp,
              version: 0,
              ...(memory.data.workspaceId ? { workspaceId: memory.data.workspaceId } : {}),
            },
            itemType: "memory-review-item" as const,
          }),
        ),
      });
    }
    const event = await eventFor({
      aggregateId: memory.data.id,
      aggregateType: "memory",
      aggregateVersion: memory.data.version + 1,
      eventType: "memory.reviewed",
      payload: { decision: input.decision, reviewStatus, status },
      scope,
    });
    const indexJob = await preparedIndexJob({
      memory,
      ...(input.decision === "archive" ? { operation: "archive" as const } : {}),
      scope,
      synchronizationGeneration: Shared.memorySynchronizationGeneration(memory),
    });
    operations.push(...indexJob.operations);
    const supersededEvent = superseded
      ? await eventFor({
          aggregateId: superseded.data.id,
          aggregateType: "memory",
          aggregateVersion: superseded.data.version + 1,
          eventType: predecessorArchived ? "memory.archived" : "memory.superseded",
          payload: {
            status: superseded.data.status,
            supersededByMemoryId: memory.data.id,
          },
          scope,
        })
      : undefined;
    const supersededIndexJob =
      superseded && predecessorArchived
        ? await preparedIndexJob({
            memory: superseded,
            operation: "archive",
            scope,
            synchronizationGeneration: Shared.memorySynchronizationGeneration(superseded),
          })
        : undefined;
    if (superseded && predecessor) {
      operations.push({
        kind: "put",
        previousRecord: predecessor,
        record: superseded,
      });
      if (supersededIndexJob) operations.push(...supersededIndexJob.jobOperations);
    }
    const cleanupEvent =
      (input.decision === "edit" || input.decision === "delete") && previousMemory.data.bodyRef
        ? await blobCleanupEvent(scope, previousMemory.data.bodyRef)
        : undefined;
    const reviewCleanupEvent =
      input.decision === "delete"
        ? await reviewContentCleanupEvent(scope, previousMemory.data.id)
        : undefined;
    try {
      await transactWithSemanticEvents(database, operations, [
        event,
        ...indexJob.events,
        ...(supersededEvent ? [supersededEvent] : []),
        ...(supersededIndexJob ? supersededIndexJob.events : []),
        ...(cleanupEvent ? [cleanupEvent] : []),
        ...(reviewCleanupEvent ? [reviewCleanupEvent] : []),
      ]);
    } catch (cause) {
      const concurrentReplay = await idempotencyReplay(scope, idempotencyKey, expectedCommandHash);
      if (concurrentReplay?.[0]) {
        const replayedMemory = await requiredMutableMemory(scope, input.memoryId);
        const replayedReview = await Shared.loadRecord(
          database,
          "execution",
          Shared.memoryReviewKey(scope, input.memoryId, input.reviewId),
          "memory-review-item",
        );
        if (replayedReview && Shared.mutationScopeMatches(replayedReview, scope)) {
          if (input.decision === "delete") {
            await scrubMemoryReviewContent(
              scope,
              replayedMemory.data.id,
              replayedReview.data.id,
            ).catch(() => undefined);
          }
          return { memory: replayedMemory, review: replayedReview };
        }
      }
      throw cause;
    }
    if (input.decision === "delete") {
      await scrubMemoryReviewContent(scope, memory.data.id, review.data.id).catch(() => undefined);
    }
    return { memory, review };
  }
  function resolveReview(
    scope: Types.MemoryPlatformScope,
    input: Parameters<typeof resolveReviewOnce>[1],
  ) {
    return Shared.retryDatabaseWriteConflicts(() => resolveReviewOnce(scope, input));
  }
  return {
    listReviewItems,
    listReviewItemsPage,
    openReviewForMemory,
    resolveReview,
  };
}
