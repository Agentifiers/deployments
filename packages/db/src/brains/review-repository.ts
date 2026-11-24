import type { BrainRepository, BrainReviewItem } from "@deployments-ai/brains";
import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { key } from "../keys.ts";
import { BrainReviewItemRecord } from "../records/brain-runtime.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import {
  activeBrainCondition,
  activeHumanCondition,
  activeMemberCondition,
  activeOrganizationCondition,
} from "./authorization-conditions.ts";
import {
  brainGrantPlatformRecord,
  brainEntityFromPlatformRecord,
  brainEntityPlatformRecord,
  brainPlatformRecord,
  brainUlid,
} from "./record-mapping.ts";
import { activeBrainGrantCondition } from "./knowledge-mutation-conditions.ts";
import { updateBrainRecordOperations } from "./record-operations.ts";
import { encodeBrainIndexCursor as encodeCursor } from "./repository-pagination.ts";

function item(record: typeof BrainReviewItemRecord.Type): BrainReviewItem {
  const data = record.data;
  return {
    brainId: data.brainId,
    createdAt: data.createdAt,
    ...(data.decision ? { decision: data.decision } : {}),
    ...(data.documentId ? { documentId: data.documentId } : {}),
    ...(data.entityId ? { entityId: data.entityId } : {}),
    id: data.id,
    kind: data.kind,
    organizationId: data.organizationId,
    proposal: data.proposal,
    reason: data.reason,
    ...(data.resolvedAt ? { resolvedAt: data.resolvedAt } : {}),
    ...(data.resolvedByPrincipalId ? { resolvedByPrincipalId: data.resolvedByPrincipalId } : {}),
    status: data.status,
    updatedAt: data.updatedAt,
    version: data.version,
  };
}

async function entityMergeOperations(
  database: DynamoDatabaseService,
  reviewItem: BrainReviewItem,
): Promise<readonly TransactionOperation[]> {
  if (reviewItem.kind !== "entity-merge" || reviewItem.decision !== "merge") return [];
  const candidateEntityIds = Array.isArray(reviewItem.proposal.candidateEntityIds)
    ? reviewItem.proposal.candidateEntityIds.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const targetEntityId = reviewItem.proposal.resolutionTargetEntityId;
  if (
    typeof targetEntityId !== "string" ||
    candidateEntityIds.length < 2 ||
    candidateEntityIds.length > 20 ||
    !candidateEntityIds.includes(targetEntityId)
  ) {
    throw new TypeError("Brain entity merge resolution has an invalid candidate target.");
  }
  const records = await Promise.all(
    candidateEntityIds.map(
      async (entityId) =>
        await database.getRecord(
          "control",
          {
            pk: key("ORG", reviewItem.organizationId, "BRAIN", reviewItem.brainId),
            sk: key("BRAIN-ENTITY", entityId),
          },
          true,
        ),
    ),
  );
  if (
    records.some(
      (record) =>
        record?.itemType !== "brain-entity" ||
        record.data.organizationId !== reviewItem.organizationId ||
        record.data.brainId !== reviewItem.brainId ||
        record.data.status !== "active",
    )
  ) {
    throw new TypeError("Brain entity merge candidates changed before resolution.");
  }
  return records.flatMap((record) => {
    if (record?.itemType !== "brain-entity") return [];
    const entity = brainEntityFromPlatformRecord(record);
    const next = brainEntityPlatformRecord(
      entity.id === targetEntityId
        ? {
            ...entity,
            reviewStatus: "approved",
            updatedAt: reviewItem.resolvedAt!,
            version: entity.version + 1,
          }
        : {
            ...entity,
            mergedIntoEntityId: targetEntityId,
            status: "merged",
            updatedAt: reviewItem.resolvedAt!,
            version: entity.version + 1,
          },
    );
    return updateBrainRecordOperations(record, next, reviewItem.resolvedAt!);
  });
}

function cursor(value: string | undefined, partition: string) {
  if (!value) return undefined;
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  const names = ["gsi1pk", "gsi1sk", "pk", "sk"];
  if (
    !parsed ||
    Object.keys(parsed).length !== names.length ||
    names.some((name) => typeof parsed[name] !== "string") ||
    parsed.gsi1pk !== partition
  ) {
    throw new TypeError("Invalid Brain review cursor.");
  }
  return parsed as Record<string, string>;
}

export function makeBrainReviewRepository(
  database: DynamoDatabaseService,
): Pick<BrainRepository, "getReviewItem" | "listReviewItems" | "resolveReviewItem"> {
  return {
    async getReviewItem(organizationId, brainId, reviewItemId) {
      const value = await database.getRecord(
        "execution",
        {
          pk: key("ORG", organizationId, "BRAIN", brainId),
          sk: key("BRAIN-REVIEW-ITEM", reviewItemId),
        },
        true,
      );
      return value?.itemType === "brain-review-item" && value.data.brainId === brainId
        ? item(value)
        : undefined;
    },
    async listReviewItems(organizationId, brainId, options) {
      if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
        throw new TypeError("Brain review limit must be between 1 and 100.");
      }
      const partition = key("ORG", organizationId, "BRAIN", brainId, "REVIEWS");
      const prefix = key("BRAIN-REVIEW-ITEM", options.status ?? "open");
      const result = await database.queryRecords("execution", {
        ...(options.cursor ? { ExclusiveStartKey: cursor(options.cursor, partition) } : {}),
        ExpressionAttributeValues: { ":gsi1pk": partition, ":prefix": prefix },
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :gsi1pk AND begins_with(gsi1sk, :prefix)",
        Limit: options.limit,
      });
      return {
        items: result.items.flatMap((record) =>
          record.itemType === "brain-review-item" && record.data.brainId === brainId
            ? [item(record)]
            : [],
        ),
        ...(result.lastEvaluatedKey ? { nextCursor: encodeCursor(result.lastEvaluatedKey)! } : {}),
      };
    },
    async resolveReviewItem({ actorPrincipalId, authorizingGrant, brain, eventId, reviewItem }) {
      if (reviewItem.status !== "resolved" || !reviewItem.decision || !reviewItem.resolvedAt) {
        throw new TypeError("Brain review resolution requires a complete resolved item.");
      }
      const previousValue = await database.getRecord(
        "execution",
        {
          pk: key("ORG", brain.organizationId, "BRAIN", brain.id),
          sk: key("BRAIN-REVIEW-ITEM", reviewItem.id),
        },
        true,
      );
      if (
        previousValue?.itemType !== "brain-review-item" ||
        previousValue.data.status !== "open" ||
        reviewItem.version !== previousValue.data.version + 1
      ) {
        throw new TypeError("Brain review item is unavailable or already resolved.");
      }
      const next = Schema.decodeUnknownSync(BrainReviewItemRecord)(
        withCanonicalRecordKeys({
          data: { ...reviewItem },
          itemType: "brain-review-item" as const,
        }),
      );
      const mergeOperations = await entityMergeOperations(database, reviewItem);
      await transactWithSemanticEvents(
        database,
        [
          activeOrganizationCondition(brain.organizationId),
          activeHumanCondition(actorPrincipalId),
          activeMemberCondition(brain.organizationId, actorPrincipalId),
          activeBrainCondition(brainPlatformRecord(brain)),
          activeBrainGrantCondition(brainGrantPlatformRecord(authorizingGrant)),
          ...mergeOperations,
          { kind: "put", previousRecord: previousValue, record: next },
        ],
        [
          makeSemanticEventRecord({
            actor: { id: brainUlid(actorPrincipalId), type: "principal" },
            aggregateId: brainUlid(reviewItem.id),
            aggregateType: "brain-review-item",
            aggregateVersion: reviewItem.version,
            eventId: brainUlid(eventId),
            eventType: "brain-review-item.resolved",
            occurredAt: reviewItem.resolvedAt,
            organizationId: brainUlid(brain.organizationId),
            payload: {
              brainId: brain.id,
              decision: reviewItem.decision,
              reviewItemId: reviewItem.id,
            },
          }),
        ],
        eventId,
      );
      return item(next);
    },
  };
}
