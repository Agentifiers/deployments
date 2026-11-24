import type {
  Brain,
  BrainEdge,
  BrainEntity,
  BrainGraphProjectionPort,
  BrainRepository,
} from "@deployments-ai/brains";
import { MAX_BRAIN_GRAPH_PROJECTION_CANDIDATES } from "@deployments-ai/brains";
import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { deterministicUlid } from "../ids.ts";
import { key, Keys } from "../keys.ts";
import { BrainReviewItemRecord } from "../records/brain-runtime.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import { activeBrainCondition } from "./authorization-conditions.ts";
import { activeBrainSourceCondition } from "./knowledge-mutation-conditions.ts";
import { createBrainRecordOperations } from "./record-operations.ts";
import {
  brainEdgeFromPlatformRecord,
  brainEdgePlatformRecord,
  brainEntityFromPlatformRecord,
  brainEntityPlatformRecord,
  brainPlatformRecord,
  brainSourcePlatformRecord,
  brainUlid,
  type BrainEdgePlatformRecord,
  type BrainEntityPlatformRecord,
} from "./record-mapping.ts";
import { invariant } from "./repository-invariants.ts";
import { encodeBrainIndexCursor as encodeCursor } from "./repository-pagination.ts";

const MAX_GRAPH_ALIASES = MAX_BRAIN_GRAPH_PROJECTION_CANDIDATES;

async function canonicalRecord(
  database: DynamoDatabaseService,
  table: "control" | "execution",
  recordKey: { readonly pk: string; readonly sk: string },
) {
  return await database.getRecord(table, recordKey, true);
}

function graphCursor(value: string | undefined, partition: string) {
  if (!value) return undefined;
  const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  const names = ["gsi1pk", "gsi1sk", "pk", "sk"];
  invariant(
    Object.keys(decoded).length === names.length &&
      names.every((name) => typeof decoded[name] === "string") &&
      decoded.gsi1pk === partition,
    "Invalid Brain graph cursor.",
  );
  return decoded as Record<string, string>;
}

async function entityByAliasRecord(
  database: DynamoDatabaseService,
  organizationId: string,
  brainId: string,
  alias: string,
) {
  const claim = await canonicalRecord(
    database,
    "control",
    Keys.control.uniqueClaim(`organization:${organizationId}:brain:${brainId}:entity-alias`, alias),
  );
  if (claim?.itemType !== "unique-claim" || claim.data.ownerItemType !== "brain-entity") {
    return undefined;
  }
  const entity = await canonicalRecord(database, "control", {
    pk: claim.data.ownerPk,
    sk: claim.data.ownerSk,
  });
  if (
    entity?.itemType === "brain-entity" &&
    entity.data.status === "merged" &&
    entity.data.mergedIntoEntityId
  ) {
    const target = await canonicalRecord(database, "control", {
      pk: key("ORG", organizationId, "BRAIN", brainId),
      sk: key("BRAIN-ENTITY", entity.data.mergedIntoEntityId),
    });
    return target?.itemType === "brain-entity" && target.data.status === "active"
      ? target
      : undefined;
  }
  return entity?.itemType === "brain-entity" &&
    entity.data.organizationId === organizationId &&
    entity.data.brainId === brainId
    ? entity
    : undefined;
}

function graphSnapshotConditions(
  snapshot: Parameters<BrainGraphProjectionPort["publishProjection"]>[0]["snapshot"],
): TransactionOperation[] {
  const source = brainSourcePlatformRecord(snapshot.source);
  return [
    activeBrainCondition(brainPlatformRecord(snapshot.brain)),
    activeBrainSourceCondition(source),
    {
      conditionExpression:
        "#itemType = :itemType AND #data.#version = :version AND #data.#lifecycle = :active AND #data.#currentContentVersionId = :contentVersion AND #data.#projectionGeneration = :generation",
      expressionAttributeNames: {
        "#currentContentVersionId": "currentContentVersionId",
        "#data": "data",
        "#itemType": "itemType",
        "#lifecycle": "lifecycle",
        "#projectionGeneration": "projectionGeneration",
        "#version": "version",
      },
      expressionAttributeValues: {
        ":active": "active",
        ":contentVersion": snapshot.version.id,
        ":generation": snapshot.document.projectionGeneration,
        ":itemType": "brain-document",
        ":version": snapshot.document.version,
      },
      key: {
        pk: key("ORG", snapshot.document.organizationId, "BRAIN", snapshot.document.brainId),
        sk: key("BRAIN-DOCUMENT", snapshot.document.id),
      },
      kind: "condition-check",
      table: "control",
    },
    {
      conditionExpression:
        "#itemType = :itemType AND #data.#kind = :content AND #data.#contentHash = :contentHash",
      expressionAttributeNames: {
        "#contentHash": "contentHash",
        "#data": "data",
        "#itemType": "itemType",
        "#kind": "kind",
      },
      expressionAttributeValues: {
        ":content": "content",
        ":contentHash": snapshot.version.contentHash,
        ":itemType": "brain-document-version",
      },
      key: {
        pk: key("ORG", snapshot.version.organizationId, "DOCUMENT", snapshot.version.documentId),
        sk: key("BRAIN-DOCUMENT-VERSION", snapshot.version.id),
      },
      kind: "condition-check",
      table: "control",
    },
    {
      conditionExpression:
        "#itemType = :itemType AND #data.#contentHash = :contentHash AND #data.#documentVersionId = :versionId",
      expressionAttributeNames: {
        "#contentHash": "contentHash",
        "#data": "data",
        "#documentVersionId": "documentVersionId",
        "#itemType": "itemType",
      },
      expressionAttributeValues: {
        ":contentHash": snapshot.rendition.contentHash,
        ":itemType": "brain-document-rendition",
        ":versionId": snapshot.version.id,
      },
      key: {
        pk: key(
          "ORG",
          snapshot.rendition.organizationId,
          "DOCUMENT-VERSION",
          snapshot.rendition.documentVersionId,
        ),
        sk: key("BRAIN-DOCUMENT-RENDITION", snapshot.rendition.id),
      },
      kind: "condition-check",
      table: "control",
    },
  ];
}

function newEntity(input: {
  readonly aliases: readonly string[];
  readonly brain: Brain;
  readonly canonicalName: string;
  readonly id: string;
  readonly kind: BrainEntity["kind"];
  readonly now: string;
}): BrainEntity {
  return {
    brainId: input.brain.id,
    canonicalName: input.canonicalName,
    createdAt: input.now,
    externalIdentifiers: {},
    id: input.id,
    kind: input.kind,
    normalizedAliases: input.aliases,
    organizationId: input.brain.organizationId,
    reviewStatus: "unreviewed",
    status: "active",
    updatedAt: input.now,
    version: 0,
  };
}

export function makeBrainGraphRepository(
  database: DynamoDatabaseService,
  now: () => string = () => new Date().toISOString(),
): Pick<BrainRepository, "findEntityByAlias" | "getEntity" | "listEntityEdges"> &
  BrainGraphProjectionPort {
  return {
    async getEntity(organizationId, brainId, entityId) {
      const value = await canonicalRecord(database, "control", {
        pk: key("ORG", organizationId, "BRAIN", brainId),
        sk: key("BRAIN-ENTITY", entityId),
      });
      return value?.itemType === "brain-entity" && value.data.brainId === brainId
        ? brainEntityFromPlatformRecord(value)
        : undefined;
    },

    async findEntityByAlias(organizationId, brainId, normalizedAlias) {
      const value = await entityByAliasRecord(database, organizationId, brainId, normalizedAlias);
      return value ? brainEntityFromPlatformRecord(value) : undefined;
    },

    async listEntityEdges(organizationId, brainId, entityId, direction, options) {
      invariant(
        Number.isSafeInteger(options.limit) && options.limit > 0 && options.limit <= 100,
        "Brain graph limit must be between 1 and 100.",
      );
      const partition = key(
        "ORG",
        organizationId,
        "BRAIN",
        brainId,
        "GRAPH",
        "entity",
        entityId,
        direction === "outgoing" ? "OUTGOING" : "INCOMING",
      );
      const indexName = direction === "outgoing" ? "gsi1" : "gsi2";
      const result = await database.queryRecords("control", {
        ...(options.cursor ? { ExclusiveStartKey: graphCursor(options.cursor, partition) } : {}),
        ExpressionAttributeValues: { ":partition": partition },
        IndexName: indexName,
        KeyConditionExpression: `${indexName}pk = :partition`,
        Limit: options.limit,
      });
      const edges: BrainEdge[] = [];
      for (const candidate of result.items) {
        if (candidate.itemType !== "brain-edge" || candidate.data.brainId !== brainId) continue;
        const current = await canonicalRecord(database, "control", {
          pk: candidate.pk,
          sk: candidate.sk,
        });
        if (current?.itemType !== "brain-edge" || current.data.lifecycle !== "active") continue;
        const documentId =
          current.data.from.kind === "document" ? current.data.from.id : current.data.to.id;
        const document = await canonicalRecord(database, "control", {
          pk: key("ORG", organizationId, "BRAIN", brainId),
          sk: key("BRAIN-DOCUMENT", documentId),
        });
        if (
          document?.itemType !== "brain-document" ||
          document.data.lifecycle !== "active" ||
          document.data.reviewStatus === "rejected" ||
          document.data.currentContentVersionId !== current.data.documentVersionId
        ) {
          continue;
        }
        edges.push(brainEdgeFromPlatformRecord(current));
      }
      return {
        items: edges,
        ...(result.lastEvaluatedKey ? { nextCursor: encodeCursor(result.lastEvaluatedKey)! } : {}),
      };
    },

    async publishProjection({ attemptId, candidates, snapshot }) {
      invariant(
        candidates.length <= MAX_BRAIN_GRAPH_PROJECTION_CANDIDATES,
        "Brain graph projection is too large.",
      );
      const normalizedCandidates = candidates.map((candidate) => ({
        aliases: [...new Set(candidate.normalizedAliases.map((alias) => alias.trim()))]
          .filter(Boolean)
          .sort(),
        candidate,
      }));
      invariant(
        normalizedCandidates.every(({ aliases }) => aliases.length > 0),
        "Brain entity candidates require an alias.",
      );
      invariant(
        normalizedCandidates.reduce((total, { aliases }) => total + aliases.length, 0) <=
          MAX_GRAPH_ALIASES,
        "Brain graph projection has too many aliases.",
      );
      const timestamp = now();
      const entityRecords: BrainEntityPlatformRecord[] = [];
      const edgeRecords: BrainEdgePlatformRecord[] = [];
      const reviewRecords: Extract<PlatformRecord, { readonly itemType: "brain-review-item" }>[] =
        [];
      const entityIds: string[] = [];
      const edgeIds: string[] = [];
      const reviewItemIds: string[] = [];

      for (const { aliases, candidate } of normalizedCandidates) {
        const resolved = (
          await Promise.all(
            aliases.map((alias) =>
              entityByAliasRecord(
                database,
                snapshot.brain.organizationId,
                snapshot.brain.id,
                alias,
              ),
            ),
          )
        ).filter((value): value is BrainEntityPlatformRecord => value !== undefined);
        const distinct = [...new Map(resolved.map((record) => [record.data.id, record])).values()];
        if (distinct.length > 1) {
          const reviewId = deterministicUlid(
            `brain-review\u0000${snapshot.brain.id}\u0000${snapshot.version.id}\u0000${aliases.join("\u0000")}`,
          );
          const existing = await canonicalRecord(database, "execution", {
            pk: key("ORG", snapshot.brain.organizationId, "BRAIN", snapshot.brain.id),
            sk: key("BRAIN-REVIEW-ITEM", reviewId),
          });
          if (!existing) {
            reviewRecords.push(
              Schema.decodeUnknownSync(BrainReviewItemRecord)(
                withCanonicalRecordKeys({
                  data: {
                    brainId: brainUlid(snapshot.brain.id),
                    createdAt: timestamp,
                    documentId: brainUlid(snapshot.document.id),
                    id: reviewId,
                    kind: "entity-merge" as const,
                    organizationId: brainUlid(snapshot.brain.organizationId),
                    proposal: {
                      aliases,
                      candidateEntityIds: distinct.map((record) => record.data.id),
                    },
                    reason: "Extracted aliases resolve to multiple canonical entities.",
                    status: "open" as const,
                    updatedAt: timestamp,
                    version: 0,
                  },
                  itemType: "brain-review-item" as const,
                }),
              ),
            );
          }
          reviewItemIds.push(reviewId);
          continue;
        }

        let entity = distinct[0];
        if (!entity) {
          const entityId = deterministicUlid(
            `brain-entity\u0000${snapshot.brain.organizationId}\u0000${snapshot.brain.id}\u0000${aliases.join("\u0000")}`,
          );
          const existing = await canonicalRecord(database, "control", {
            pk: key("ORG", snapshot.brain.organizationId, "BRAIN", snapshot.brain.id),
            sk: key("BRAIN-ENTITY", entityId),
          });
          if (existing?.itemType === "brain-entity") {
            entity = existing;
          } else {
            entity = brainEntityPlatformRecord(
              newEntity({
                aliases,
                brain: snapshot.brain,
                canonicalName: candidate.canonicalName,
                id: entityId,
                kind: candidate.kind,
                now: timestamp,
              }),
            );
            entityRecords.push(entity);
          }
        }
        entityIds.push(entity.data.id);
        const edgeId = deterministicUlid(
          `brain-edge\u0000${snapshot.version.id}\u0000mentions\u0000${entity.data.id}`,
        );
        const existingEdge = await canonicalRecord(database, "control", {
          pk: key("ORG", snapshot.brain.organizationId, "BRAIN", snapshot.brain.id),
          sk: key("BRAIN-EDGE", edgeId),
        });
        if (!existingEdge) {
          const edge: BrainEdge = {
            brainId: snapshot.brain.id,
            confidence: 1,
            createdAt: timestamp,
            documentVersionId: snapshot.version.id,
            evidence: { extractionAttemptId: attemptId },
            extractionMethod: "deterministic",
            from: { id: snapshot.document.id, kind: "document" },
            id: edgeId,
            lifecycle: "active",
            organizationId: snapshot.brain.organizationId,
            relation: "mentions",
            renditionId: snapshot.rendition.id,
            reviewStatus: "unreviewed",
            to: { id: entity.data.id, kind: "entity" },
            updatedAt: timestamp,
            version: 0,
          };
          edgeRecords.push(brainEdgePlatformRecord(edge));
        }
        edgeIds.push(edgeId);
      }

      const writes: TransactionOperation[] = [
        ...entityRecords.flatMap((record) => createBrainRecordOperations(record, timestamp)),
        ...edgeRecords.map((record) => ({ kind: "put" as const, record })),
        ...reviewRecords.map((record) => ({ kind: "put" as const, record })),
      ];
      if (writes.length > 0) {
        const operations = [...graphSnapshotConditions(snapshot), ...writes];
        invariant(operations.length + 1 <= 100, "Brain graph transaction exceeds DynamoDB limits.");
        const eventId = deterministicUlid(`brain-graph-event\u0000${attemptId}`);
        await transactWithSemanticEvents(
          database,
          operations,
          [
            makeSemanticEventRecord({
              actor: { type: "system" },
              aggregateId: brainUlid(snapshot.version.id),
              aggregateType: "brain-document-version",
              aggregateVersion: 2,
              eventId,
              eventType: "brain-document.graph-projected",
              occurredAt: timestamp,
              organizationId: brainUlid(snapshot.brain.organizationId),
              payload: {
                brainId: snapshot.brain.id,
                documentVersionId: snapshot.version.id,
                edgeCount: edgeIds.length,
                entityCount: entityIds.length,
                reviewItemCount: reviewItemIds.length,
              },
            }),
          ],
          eventId,
        );
      }
      return { edgeIds, entityIds, reviewItemIds };
    },
  };
}
