import type { BrainMutationCaller, BrainRepository } from "@deployments-ai/brains";
import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { key, Keys } from "../keys.ts";
import type { PlatformRecord } from "../records/index.ts";
import { BrainSourceItemClaimRecord } from "../records/brains.ts";
import { BrainSyncJobRecord } from "../records/brain-runtime.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import {
  activeBrainCondition,
  activeOrganizationCondition,
  activeOwnerGrantCondition,
} from "./authorization-conditions.ts";
import {
  activeBrainSourceCondition,
  activeBrainWriteGrantCondition,
  brainMutationCallerConditions,
} from "./knowledge-mutation-conditions.ts";
import {
  brainDocumentFromPlatformRecord,
  brainDocumentPlatformRecord,
  brainDocumentRenditionPlatformRecord,
  brainDocumentVersionFromPlatformRecord,
  brainDocumentVersionPlatformRecord,
  brainGrantPlatformRecord,
  brainSourceFromPlatformRecord,
  brainSourcePlatformRecord,
  brainSourceRevisionClaimFromPlatformRecord,
  brainSourceRevisionClaimPlatformRecord,
  brainUploadTicketPlatformRecord,
  brainUlid,
  type BrainDocumentVersionPlatformRecord,
  type BrainSourcePlatformRecord,
} from "./record-mapping.ts";
import { brainIndexEnqueueOperations } from "./index-enqueue.ts";
import { githubConnectionAuthorization } from "./connector-authorization.ts";
import {
  brainAggregateCursor as cursorKey,
  encodeBrainAggregateCursor as encodeCursor,
  validateBrainResourceListOptions as validateListOptions,
} from "./repository-pagination.ts";
import { createBrainRecordOperations, updateBrainRecordOperations } from "./record-operations.ts";
import { brainAgentWriteConditions } from "./agent-write-authorization.ts";
import {
  brainSourceRevisionClaimNamespace,
  normalizeBrainExternalItemIdentity,
} from "./claim-identities.ts";
import { invariant } from "./repository-invariants.ts";

function revisionEvent(
  version: BrainDocumentVersionPlatformRecord,
  eventId: string,
  actor: BrainMutationCaller,
  projectionGeneration: number,
  operation: "index" | "suppress",
) {
  return makeSemanticEventRecord({
    actor: {
      id: brainUlid(actor.kind === "human" ? actor.principalId : actor.serviceAccountId),
      type: actor.kind === "human" ? "principal" : "service-account",
    },
    aggregateId: version.data.id,
    aggregateType: "brain-document-version",
    aggregateVersion: 1,
    eventId: brainUlid(eventId),
    eventType: `brain-document.${version.data.kind}-captured`,
    occurredAt: version.data.createdAt,
    organizationId: version.data.organizationId,
    payload: {
      brainId: version.data.brainId,
      documentId: version.data.documentId,
      indexJobId: eventId,
      indexJobIdempotencyKey: `${version.data.documentId}:${projectionGeneration}:${operation}`,
      sourceId: version.data.sourceId,
      sourceOrder: version.data.sourceOrder,
      versionId: version.data.id,
    },
  });
}

export function makeBrainKnowledgeRepository(
  database: DynamoDatabaseService,
): Pick<
  BrainRepository,
  | "captureDocumentRevision"
  | "createSource"
  | "findDocumentBySourceIdentity"
  | "findSourceRevisionClaim"
  | "getDocument"
  | "getDocumentVersion"
  | "listDocuments"
  | "listDocumentsBySource"
  | "getSource"
  | "listSources"
> {
  async function getBrain(organizationId: string, brainId: string) {
    const record = await database.getRecord(
      "control",
      { pk: key("ORG", organizationId), sk: key("BRAIN", brainId) },
      true,
    );
    return record?.itemType === "brain" && record.data.organizationId === organizationId
      ? record
      : undefined;
  }

  async function claimedRecord(
    namespace: string,
    value: string,
    expectedType: PlatformRecord["itemType"],
  ) {
    const claim = await database.getRecord(
      "control",
      Keys.control.uniqueClaim(namespace, value),
      true,
    );
    if (claim?.itemType !== "unique-claim" || claim.data.ownerItemType !== expectedType) {
      return undefined;
    }
    return await database.getRecord(
      "control",
      { pk: claim.data.ownerPk, sk: claim.data.ownerSk },
      true,
    );
  }

  return {
    async createSource({ actor, authorizingGrant, eventId, initialSyncJobId, source }) {
      invariant(
        source.version === 0 && source.status === "active",
        "New Brain sources must be active version zero.",
      );
      invariant(actor.kind === "human", "Only a human Brain owner may administer sources.");
      invariant(
        authorizingGrant.target.type === "principal" &&
          authorizingGrant.target.principalId === actor.principalId,
        "Brain source creation requires the caller's owner grant.",
      );
      const brain = await getBrain(source.organizationId, source.brainId);
      invariant(brain, "Brain does not exist in the requested organization.");
      const connector =
        source.kind === "github"
          ? await githubConnectionAuthorization(database, source)
          : undefined;
      const record = brainSourcePlatformRecord(source);
      invariant(
        (source.kind === "github") === Boolean(initialSyncJobId),
        "Managed Brain sources require exactly one initial sync job identity.",
      );
      const syncJob =
        source.kind === "github" && initialSyncJobId && connector?.connection.data.credentialRef
          ? Schema.decodeUnknownSync(BrainSyncJobRecord)(
              withCanonicalRecordKeys({
                data: {
                  attempt: 0,
                  authorizingGrantId: brainUlid(authorizingGrant.id),
                  brainId: brainUlid(source.brainId),
                  connectionCredentialGeneration:
                    "generation" in connector.connection.data.credentialRef
                      ? connector.connection.data.credentialRef.generation
                      : 0,
                  connectionId: brainUlid(source.connectionId!),
                  createdAt: source.createdAt,
                  id: brainUlid(initialSyncJobId),
                  idempotencyKey: `${source.id}:initial`,
                  nextDueAt: source.createdAt,
                  organizationId: brainUlid(source.organizationId),
                  priority: 100,
                  requestedByPrincipalId: brainUlid(actor.principalId),
                  sourceId: brainUlid(source.id),
                  status: "queued" as const,
                  updatedAt: source.createdAt,
                  version: 0,
                },
                itemType: "brain-sync-job" as const,
              }),
            )
          : undefined;
      await transactWithSemanticEvents(
        database,
        [
          activeOrganizationCondition(source.organizationId),
          ...brainMutationCallerConditions(
            actor,
            authorizingGrant,
            source.organizationId,
            source.createdAt,
          ),
          activeBrainCondition(brain),
          activeOwnerGrantCondition(brainGrantPlatformRecord(authorizingGrant)),
          ...(connector ? [connector.condition] : []),
          ...createBrainRecordOperations(record, source.createdAt),
          ...(syncJob ? [{ kind: "put" as const, record: syncJob }] : []),
        ],
        [
          makeSemanticEventRecord({
            actor: { id: brainUlid(actor.principalId), type: "principal" },
            aggregateId: record.data.id,
            aggregateType: "brain-source",
            aggregateVersion: 1,
            eventId: brainUlid(eventId),
            eventType: "brain-source.created",
            occurredAt: source.createdAt,
            organizationId: record.data.organizationId,
            payload: {
              brainId: source.brainId,
              kind: source.kind,
              sourceId: source.id,
              ...(syncJob
                ? {
                    syncJobId: syncJob.data.id,
                    syncJobIdempotencyKey: syncJob.data.idempotencyKey,
                  }
                : {}),
            },
          }),
        ],
        eventId,
      );
      return brainSourceFromPlatformRecord(record);
    },

    async getSource(organizationId, brainId, sourceId) {
      const record = await database.getRecord(
        "control",
        {
          pk: key("ORG", organizationId, "BRAIN", brainId),
          sk: key("BRAIN-SOURCE", sourceId),
        },
        true,
      );
      return record?.itemType === "brain-source" && record.data.brainId === brainId
        ? brainSourceFromPlatformRecord(record)
        : undefined;
    },

    async listSources(organizationId, brainId, options) {
      validateListOptions(options);
      const pk = key("ORG", organizationId, "BRAIN", brainId);
      const result = await database.queryRecords("control", {
        ConsistentRead: true,
        ...(options.cursor ? { ExclusiveStartKey: cursorKey(options.cursor, pk) } : {}),
        ExpressionAttributeValues: { ":pk": pk, ":prefix": "BRAIN-SOURCE#" },
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        Limit: options.limit,
      });
      const records = result.items.filter(
        (record): record is BrainSourcePlatformRecord =>
          record.itemType === "brain-source" && record.data.brainId === brainId,
      );
      invariant(records.length === result.items.length, "Brain source aggregate is inconsistent.");
      return {
        items: records.map(brainSourceFromPlatformRecord),
        ...(result.lastEvaluatedKey ? { nextCursor: encodeCursor(result.lastEvaluatedKey)! } : {}),
      };
    },

    async getDocument(organizationId, brainId, documentId) {
      const record = await database.getRecord(
        "control",
        {
          pk: key("ORG", organizationId, "BRAIN", brainId),
          sk: key("BRAIN-DOCUMENT", documentId),
        },
        true,
      );
      return record?.itemType === "brain-document" && record.data.brainId === brainId
        ? brainDocumentFromPlatformRecord(record)
        : undefined;
    },

    async listDocumentsBySource(organizationId, brainId, sourceId, options) {
      validateListOptions(options);
      const pk = key("ORG", organizationId, "BRAIN", brainId);
      const result = await database.queryRecords("control", {
        ConsistentRead: true,
        ...(options.cursor ? { ExclusiveStartKey: cursorKey(options.cursor, pk) } : {}),
        ExpressionAttributeValues: { ":pk": pk, ":prefix": "BRAIN-DOCUMENT#" },
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        Limit: options.limit,
      });
      return {
        items: result.items.flatMap((record) =>
          record.itemType === "brain-document" && record.data.sourceId === sourceId
            ? [brainDocumentFromPlatformRecord(record)]
            : [],
        ),
        ...(result.lastEvaluatedKey ? { nextCursor: encodeCursor(result.lastEvaluatedKey)! } : {}),
      };
    },

    async listDocuments(organizationId, brainId, options) {
      validateListOptions(options);
      const pk = key("ORG", organizationId, "BRAIN", brainId);
      const result = await database.queryRecords("control", {
        ConsistentRead: true,
        ...(options.cursor ? { ExclusiveStartKey: cursorKey(options.cursor, pk) } : {}),
        ExpressionAttributeValues: { ":pk": pk, ":prefix": "BRAIN-DOCUMENT#" },
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        Limit: options.limit,
      });
      const items = result.items.filter(
        (record): record is Extract<PlatformRecord, { readonly itemType: "brain-document" }> =>
          record.itemType === "brain-document" && record.data.brainId === brainId,
      );
      invariant(items.length === result.items.length, "Brain document aggregate is inconsistent.");
      return {
        items: items.map(brainDocumentFromPlatformRecord),
        ...(result.lastEvaluatedKey ? { nextCursor: encodeCursor(result.lastEvaluatedKey)! } : {}),
      };
    },

    async findDocumentBySourceIdentity(organizationId, brainId, sourceId, externalItemIdentity) {
      const record = await claimedRecord(
        `organization:${organizationId}:brain-source:${sourceId}:document`,
        normalizeBrainExternalItemIdentity(externalItemIdentity),
        "brain-document",
      );
      return record?.itemType === "brain-document" && record.data.brainId === brainId
        ? brainDocumentFromPlatformRecord(record)
        : undefined;
    },

    async getDocumentVersion(organizationId, documentId, versionId) {
      const record = await database.getRecord(
        "control",
        {
          pk: key("ORG", organizationId, "DOCUMENT", documentId),
          sk: key("BRAIN-DOCUMENT-VERSION", versionId),
        },
        true,
      );
      return record?.itemType === "brain-document-version" && record.data.documentId === documentId
        ? brainDocumentVersionFromPlatformRecord(record)
        : undefined;
    },

    async findSourceRevisionClaim(organizationId, sourceId, externalItemIdentity, revisionKey) {
      const record = await claimedRecord(
        brainSourceRevisionClaimNamespace(organizationId, sourceId, externalItemIdentity),
        revisionKey,
        "brain-source-revision-claim",
      );
      return record?.itemType === "brain-source-revision-claim"
        ? brainSourceRevisionClaimFromPlatformRecord(record)
        : undefined;
    },

    async captureDocumentRevision({
      actor,
      agentAuthorization,
      authorizingGrant,
      document,
      eventId,
      indexEvidence,
      previous,
      revisionClaim,
      rendition,
      source,
      uploadTicket,
      version,
    }) {
      invariant(
        document.organizationId === source.organizationId &&
          document.brainId === source.brainId &&
          document.sourceId === source.id &&
          version.organizationId === source.organizationId &&
          version.brainId === source.brainId &&
          version.sourceId === source.id &&
          version.documentId === document.id &&
          revisionClaim.documentId === document.id &&
          revisionClaim.versionId === version.id,
        "Brain document revision aggregate mismatch.",
      );
      invariant(source.status === "active", "Brain source is not active.");
      invariant(
        !rendition ||
          (version.kind === "content" &&
            version.originalRenditionId === rendition.id &&
            rendition.documentVersionId === version.id),
        "Brain content version must pin its immutable original rendition.",
      );
      invariant(
        !indexEvidence ||
          (version.kind === "restore" &&
            version.restoredContentVersionId === indexEvidence.version.id &&
            indexEvidence.version.kind === "content" &&
            indexEvidence.version.documentId === document.id &&
            indexEvidence.version.originalRenditionId === indexEvidence.rendition.id &&
            indexEvidence.rendition.documentVersionId === indexEvidence.version.id),
        "Brain restoration index evidence must match the retained content version.",
      );
      const brain = await getBrain(source.organizationId, source.brainId);
      invariant(brain, "Brain does not exist in the requested organization.");
      const connector =
        source.kind === "github"
          ? await githubConnectionAuthorization(database, source)
          : undefined;
      const sourceRecord = brainSourcePlatformRecord(source);
      const documentRecord = brainDocumentPlatformRecord(document);
      const versionRecord = brainDocumentVersionPlatformRecord(version);
      const revisionRecord = brainSourceRevisionClaimPlatformRecord(revisionClaim);
      const renditionRecord = rendition
        ? brainDocumentRenditionPlatformRecord(rendition)
        : undefined;
      const callerGrantRecord = brainGrantPlatformRecord(
        agentAuthorization?.callerGrant ?? authorizingGrant,
      );
      invariant(
        !agentAuthorization ||
          (authorizingGrant.id === agentAuthorization.agentDefinitionGrant.id &&
            authorizingGrant.version === agentAuthorization.agentDefinitionGrant.version),
        "Agent Brain authorization must use its agent-definition grant.",
      );
      const operations: TransactionOperation[] = [
        activeOrganizationCondition(source.organizationId),
        ...brainMutationCallerConditions(
          actor,
          agentAuthorization?.callerGrant ?? authorizingGrant,
          source.organizationId,
          version.createdAt,
        ),
        activeBrainCondition(brain),
        activeBrainSourceCondition(sourceRecord),
        activeBrainWriteGrantCondition(callerGrantRecord),
        ...brainAgentWriteConditions(source.organizationId, agentAuthorization),
        ...(connector ? [connector.condition] : []),
      ];
      if (!previous) {
        invariant(document.version === 0, "New Brain documents require version zero.");
        const itemClaim = Schema.decodeUnknownSync(BrainSourceItemClaimRecord)(
          withCanonicalRecordKeys({
            data: {
              brainId: brainUlid(document.brainId),
              createdAt: document.createdAt,
              documentId: brainUlid(document.id),
              externalItemIdentity: document.externalItemIdentity,
              id: brainUlid(document.id),
              organizationId: brainUlid(document.organizationId),
              sourceId: brainUlid(document.sourceId),
            },
            itemType: "brain-source-item-claim" as const,
          }),
        );
        operations.push(
          ...createBrainRecordOperations(documentRecord, document.createdAt),
          ...createBrainRecordOperations(itemClaim, document.createdAt),
        );
      } else if (document.version === previous.version + 1) {
        operations.push(
          ...updateBrainRecordOperations(
            brainDocumentPlatformRecord(previous),
            documentRecord,
            document.updatedAt,
          ),
        );
      } else {
        invariant(
          document.version === previous.version &&
            document.currentContentVersionId === previous.currentContentVersionId &&
            document.currentVersionId === previous.currentVersionId &&
            document.currentSourceOrder === previous.currentSourceOrder &&
            document.projectionGeneration === previous.projectionGeneration,
          "Historical Brain revisions cannot change the current document pointer.",
        );
        operations.push({
          conditionExpression: `#itemType = :itemType AND #data.#version = :version AND #data.#currentVersionId = :currentVersionId AND ${previous.currentContentVersionId ? "#data.#currentContentVersionId = :currentContentVersionId" : "attribute_not_exists(#data.#currentContentVersionId)"} AND #data.#currentSourceOrder = :currentSourceOrder AND #data.#projectionGeneration = :projectionGeneration`,
          expressionAttributeNames: {
            "#currentContentVersionId": "currentContentVersionId",
            "#currentSourceOrder": "currentSourceOrder",
            "#currentVersionId": "currentVersionId",
            "#data": "data",
            "#itemType": "itemType",
            "#projectionGeneration": "projectionGeneration",
            "#version": "version",
          },
          expressionAttributeValues: {
            ":currentSourceOrder": previous.currentSourceOrder,
            ...(previous.currentContentVersionId
              ? { ":currentContentVersionId": previous.currentContentVersionId }
              : {}),
            ":currentVersionId": previous.currentVersionId,
            ":itemType": "brain-document",
            ":projectionGeneration": previous.projectionGeneration,
            ":version": previous.version,
          },
          key: { pk: documentRecord.pk, sk: documentRecord.sk },
          kind: "condition-check",
          table: "control",
        });
      }
      operations.push(
        ...createBrainRecordOperations(versionRecord, version.createdAt),
        ...(renditionRecord
          ? createBrainRecordOperations(renditionRecord, rendition!.createdAt)
          : []),
        ...createBrainRecordOperations(revisionRecord, revisionClaim.createdAt),
      );
      if (uploadTicket) {
        const { next, previous: previousTicket } = uploadTicket;
        invariant(
          version.kind === "content" &&
            renditionRecord !== undefined &&
            rendition?.kind === "original" &&
            rendition.documentVersionId === version.id &&
            rendition.bodyRef.key === version.bodyRef?.key &&
            rendition.bodyRef.versionId === version.bodyRef?.versionId &&
            previousTicket.status === "completed" &&
            next.status === "consumed" &&
            next.version === previousTicket.version + 1 &&
            next.revisionClaimId === revisionClaim.id &&
            next.documentId === document.id &&
            next.documentVersionId === version.id &&
            next.bodyRef?.key === version.bodyRef?.key &&
            next.bodyRef?.versionId === version.bodyRef?.versionId &&
            previousTicket.organizationId === document.organizationId &&
            previousTicket.brainId === document.brainId &&
            previousTicket.sourceId === document.sourceId,
          "Brain content revision requires an exactly bound completed upload ticket.",
        );
        operations.push(
          ...updateBrainRecordOperations(
            brainUploadTicketPlatformRecord(previousTicket),
            brainUploadTicketPlatformRecord(next),
            next.updatedAt,
          ),
        );
      } else {
        invariant(
          version.kind !== "content" && renditionRecord === undefined,
          "Brain content revisions require a completed upload ticket.",
        );
      }
      operations.push(
        ...(await brainIndexEnqueueOperations(database, {
          document,
          eventId,
          ...(indexEvidence ? { indexEvidence } : {}),
          ...(rendition ? { rendition } : {}),
          version,
        })),
      );
      await transactWithSemanticEvents(
        database,
        operations,
        [
          revisionEvent(
            versionRecord,
            eventId,
            actor,
            document.projectionGeneration,
            document.lifecycle === "active" ? "index" : "suppress",
          ),
        ],
        eventId,
      );
      return {
        document: brainDocumentFromPlatformRecord(documentRecord),
        ...(renditionRecord ? { rendition } : {}),
        version: brainDocumentVersionFromPlatformRecord(versionRecord),
      };
    },
  };
}
