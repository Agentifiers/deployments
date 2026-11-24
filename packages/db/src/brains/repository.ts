import type { Brain, BrainGrant, BrainRepository } from "@deployments-ai/brains";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { key } from "../keys.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import {
  brainFromPlatformRecord,
  brainGrantFromPlatformRecord,
  brainGrantPlatformRecord,
  brainMountFromPlatformRecord,
  brainMountPlatformRecord,
  brainPlatformRecord,
  brainUlid,
  type BrainGrantPlatformRecord,
  type BrainPlatformRecord,
} from "./record-mapping.ts";
import {
  activeBrainCondition,
  activeHumanCondition,
  activeMachineGrantCondition,
  activeMemberCondition,
  activeOrganizationCondition,
  activeOwnerGrantCondition,
} from "./authorization-conditions.ts";
import { makeBrainResourceLifecycleRepository } from "./resource-lifecycle.ts";
import { makeBrainKnowledgeRepository } from "./knowledge-repository.ts";
import { makeBrainRenditionRepository } from "./rendition-repository.ts";
import { makeBrainUploadRepository } from "./upload-repository.ts";
import type { BrainUploadQuotas } from "./upload-quotas.ts";
import { makeBrainReviewRepository } from "./review-repository.ts";
import { makeBrainGraphRepository } from "./graph-repository.ts";
import { makeBrainErasureRepository } from "./erasure-repository.ts";
import {
  createBrainRecordOperations as createOperations,
  updateBrainRecordOperations as updateOperations,
} from "./record-operations.ts";
import { invariant } from "./repository-invariants.ts";
import { encodeBrainIndexCursor as encodeCursor } from "./repository-pagination.ts";

const MAX_PAGE_SIZE = 100;

function brainEvent(
  brain: BrainPlatformRecord,
  eventId: string,
  eventType: string,
  payload: Readonly<Record<string, string | number>>,
) {
  return makeSemanticEventRecord({
    actor: { id: brain.data.updatedByPrincipalId, type: "principal" },
    aggregateId: brain.data.id,
    aggregateType: "brain",
    aggregateVersion: brain.data.version + 1,
    eventId: brainUlid(eventId),
    eventType,
    occurredAt: brain.data.updatedAt,
    organizationId: brain.data.organizationId,
    payload,
  });
}

function grantEvent(grant: BrainGrantPlatformRecord, eventId: string) {
  return makeSemanticEventRecord({
    actor: { id: grant.data.grantedByPrincipalId, type: "principal" },
    aggregateId: grant.data.id,
    aggregateType: "brain-grant",
    aggregateVersion: grant.data.version + 1,
    eventId: brainUlid(eventId),
    eventType: grant.data.status === "active" ? "brain-grant.created" : "brain-grant.revoked",
    occurredAt: grant.data.updatedAt,
    organizationId: grant.data.organizationId,
    payload: {
      brainId: grant.data.brainId,
      grantId: grant.data.id,
      status: grant.data.status,
      targetType: grant.data.targetType,
    },
  });
}

function mountEvent(mount: ReturnType<typeof brainMountPlatformRecord>, eventId: string) {
  return makeSemanticEventRecord({
    actor: { id: mount.data.grantedByPrincipalId, type: "principal" },
    aggregateId: mount.data.id,
    aggregateType: "brain-deployment-mount",
    aggregateVersion: mount.data.version + 1,
    eventId: brainUlid(eventId),
    eventType: "brain-deployment-mount.created",
    occurredAt: mount.data.updatedAt,
    organizationId: mount.data.organizationId,
    payload: {
      agentDeploymentId: mount.data.agentDeploymentId,
      brainId: mount.data.brainId,
      mountId: mount.data.id,
      status: mount.data.status,
    },
    projectId: mount.data.projectId,
  });
}

function validateOwnerGrant(brain: Brain, grant: BrainGrant) {
  invariant(grant.organizationId === brain.organizationId, "Brain owner grant tenant mismatch.");
  invariant(
    grant.brainId === brain.id && grant.brainKind === brain.kind,
    "Brain owner grant mismatch.",
  );
  invariant(
    grant.status === "active" && grant.permission === "owner",
    "Brain owner grant must be active owner.",
  );
  invariant(grant.target.type === "principal", "Brain owner grant must target a human principal.");
  if (brain.kind === "member-private") {
    invariant(
      grant.target.principalId === brain.ownerPrincipalId,
      "Member-private owner grant mismatch.",
    );
    invariant(
      grant.ownershipGeneration === brain.ownershipGeneration,
      "Member-private owner generation mismatch.",
    );
  }
}

function cursorKey(cursor: string | undefined, expectedPartition: string) {
  if (!cursor) return undefined;
  const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  invariant(value && typeof value === "object" && !Array.isArray(value), "Invalid Brain cursor.");
  const keyValue = value as Readonly<Record<string, unknown>>;
  const names = ["gsi1pk", "gsi1sk", "pk", "sk"];
  invariant(
    Object.keys(keyValue).length === names.length &&
      names.every((name) => typeof keyValue[name] === "string"),
    "Invalid Brain cursor.",
  );
  invariant(keyValue.gsi1pk === expectedPartition, "Brain cursor tenant mismatch.");
  return keyValue as Record<string, string>;
}

export function makeBrainDynamoRepository(
  database: DynamoDatabaseService,
  uploadQuotas?: BrainUploadQuotas,
): BrainRepository {
  async function getPlatformBrain(organizationId: string, brainId: string) {
    const result = await database.getRecord(
      "control",
      { pk: key("ORG", organizationId), sk: key("BRAIN", brainId) },
      true,
    );
    const record = result;
    return record?.itemType === "brain" && record.data.organizationId === organizationId
      ? record
      : undefined;
  }

  const resourceLifecycle = makeBrainResourceLifecycleRepository(database);
  const knowledge = makeBrainKnowledgeRepository(database);
  const renditions = makeBrainRenditionRepository(database);
  const uploads = makeBrainUploadRepository(database, uploadQuotas);
  const reviews = makeBrainReviewRepository(database);
  const graph = makeBrainGraphRepository(database);
  const erasure = makeBrainErasureRepository(database);

  return {
    ...knowledge,
    ...renditions,
    ...uploads,
    ...reviews,
    ...graph,
    ...erasure,
    ...resourceLifecycle,
    async listIndexHealth(organizationId, brainId, options) {
      invariant(
        Number.isSafeInteger(options.limit) && options.limit > 0 && options.limit <= MAX_PAGE_SIZE,
        `Brain index-health limit must be between 1 and ${MAX_PAGE_SIZE}.`,
      );
      const partition = key("ORG", organizationId, "BRAIN", brainId, "INDEX-STATES");
      const result = await database.queryRecords("control", {
        ...(options.cursor ? { ExclusiveStartKey: cursorKey(options.cursor, partition) } : {}),
        ExpressionAttributeValues: { ":gsi1pk": partition },
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :gsi1pk",
        Limit: options.limit,
      });
      const items = result.items.flatMap((record) =>
        record.itemType === "brain-index-state" && record.data.brainId === brainId
          ? [
              {
                components: record.data.components.map((component) => ({
                  ...(component.error ? { error: component.error } : {}),
                  kind: component.kind,
                  status: component.status,
                  updatedAt: component.updatedAt,
                })),
                documentId: record.data.documentId,
                documentVersionId: record.data.documentVersionId,
                ...(record.data.lastError ? { lastError: record.data.lastError } : {}),
                projectionGeneration: record.data.projectionGeneration,
                status: record.data.status,
                ...(record.data.synchronizedAt
                  ? { synchronizedAt: record.data.synchronizedAt }
                  : {}),
                updatedAt: record.data.updatedAt,
              },
            ]
          : [],
      );
      return {
        items,
        ...(result.lastEvaluatedKey ? { nextCursor: encodeCursor(result.lastEvaluatedKey)! } : {}),
      };
    },
    async createWithOwner({ brain, eventId, ownerGrant }) {
      invariant(
        brain.version === 0 && ownerGrant.version === 0,
        "Brain creation requires version zero.",
      );
      invariant(brain.status === "active", "New brains must be active.");
      invariant(
        ownerGrant.target.type === "principal" &&
          ownerGrant.target.principalId === brain.createdByPrincipalId,
        "The creating principal must receive the initial owner grant.",
      );
      validateOwnerGrant(brain, ownerGrant);
      const record = brainPlatformRecord(brain);
      const grantRecord = brainGrantPlatformRecord(ownerGrant);
      const operations = [
        activeOrganizationCondition(brain.organizationId),
        activeHumanCondition(brain.createdByPrincipalId),
        activeMemberCondition(
          brain.organizationId,
          brain.createdByPrincipalId,
          brain.kind === "company",
        ),
        ...createOperations(record, brain.createdAt),
        ...createOperations(grantRecord, ownerGrant.createdAt),
      ];
      await transactWithSemanticEvents(
        database,
        operations,
        [
          brainEvent(record, eventId, "brain.created", {
            brainId: brain.id,
            kind: brain.kind,
          }),
        ],
        eventId,
      );
      return brainFromPlatformRecord(record);
    },

    async get(organizationId, brainId) {
      const record = await getPlatformBrain(organizationId, brainId);
      return record ? brainFromPlatformRecord(record) : undefined;
    },

    async listByOrganization(organizationId, options) {
      invariant(
        Number.isSafeInteger(options.limit) && options.limit > 0 && options.limit <= MAX_PAGE_SIZE,
        `Brain list limit must be between 1 and ${MAX_PAGE_SIZE}.`,
      );
      const partition = key("ORG", organizationId);
      const prefix = key("BRAIN", ...(options.status ? [options.status] : []));
      const result = await database.queryRecords("control", {
        ...(options.cursor ? { ExclusiveStartKey: cursorKey(options.cursor, partition) } : {}),
        ExpressionAttributeValues: {
          ":pk": partition,
          ":prefix": `${prefix}#`,
        },
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :prefix)",
        Limit: options.limit,
        ScanIndexForward: false,
      });
      const items = result.items.filter(
        (record): record is BrainPlatformRecord =>
          record.itemType === "brain" && record.data.organizationId === organizationId,
      );
      invariant(items.length === result.items.length, "Brain organization index is inconsistent.");
      return {
        items: items.map(brainFromPlatformRecord),
        ...(result.lastEvaluatedKey ? { nextCursor: encodeCursor(result.lastEvaluatedKey)! } : {}),
      };
    },

    async putGrant({ authorizingGrant, eventId, grant }) {
      invariant(
        grant.version === 0 && grant.status === "active",
        "New Brain grants must be active version zero.",
      );
      const brain = await getPlatformBrain(grant.organizationId, grant.brainId);
      invariant(brain, "Brain does not exist in the requested organization.");
      validateOwnerGrant(brainFromPlatformRecord(brain), authorizingGrant);
      invariant(grant.brainKind === brain.data.kind, "Brain grant kind mismatch.");
      if (brain.data.kind === "member-private") {
        invariant(
          grant.ownershipGeneration === brain.data.ownershipGeneration,
          "Brain grant ownership generation mismatch.",
        );
        invariant(
          grant.target.type !== "principal" ||
            grant.target.principalId === brain.data.ownerPrincipalId,
          "Member-private brains cannot grant another human principal.",
        );
      }
      const authorizing = brainGrantPlatformRecord(authorizingGrant);
      invariant(
        authorizingGrant.target.type === "principal",
        "A Brain owner grant must target a principal.",
      );
      const record = brainGrantPlatformRecord(grant);
      const targetConditions: TransactionOperation[] = [];
      if (grant.target.type === "principal") {
        targetConditions.push(
          activeHumanCondition(grant.target.principalId),
          activeMemberCondition(grant.organizationId, grant.target.principalId, false),
        );
      } else if (
        grant.target.type === "service-account" ||
        grant.target.type === "agent-definition"
      ) {
        const itemType = grant.target.type;
        const id =
          grant.target.type === "service-account"
            ? grant.target.serviceAccountId
            : grant.target.agentDefinitionId;
        targetConditions.push({
          conditionExpression:
            "#itemType = :itemType AND #data.#status = :active AND #data.#organizationId = :organizationId AND #data.#projectId = :projectId AND #data.#environmentId = :environmentId",
          expressionAttributeNames: {
            "#data": "data",
            "#environmentId": "environmentId",
            "#itemType": "itemType",
            "#organizationId": "organizationId",
            "#projectId": "projectId",
            "#status": "status",
          },
          expressionAttributeValues: {
            ":active": "active",
            ":environmentId": grant.target.environmentId,
            ":itemType": itemType,
            ":organizationId": grant.organizationId,
            ":projectId": grant.target.projectId,
          },
          key: {
            pk: key("ORG", grant.organizationId, "ENV", grant.target.environmentId),
            sk: key(itemType.toUpperCase(), id),
          },
          kind: "condition-check",
          table: "control",
        });
      }
      await transactWithSemanticEvents(
        database,
        [
          activeOrganizationCondition(grant.organizationId),
          activeHumanCondition(authorizingGrant.target.principalId),
          activeMemberCondition(grant.organizationId, authorizingGrant.target.principalId),
          activeBrainCondition(brain),
          activeOwnerGrantCondition(authorizing),
          ...targetConditions,
          ...createOperations(record, grant.createdAt),
        ],
        [grantEvent(record, eventId)],
        eventId,
      );
      return brainGrantFromPlatformRecord(record);
    },

    async putMount({ agentDefinitionGrant, authorizingGrant, eventId, mount }) {
      invariant(
        mount.version === 0 && mount.status === "active",
        "New Brain mounts must be active version zero.",
      );
      const brain = await getPlatformBrain(mount.organizationId, mount.brainId);
      invariant(brain, "Brain does not exist in the requested organization.");
      validateOwnerGrant(brainFromPlatformRecord(brain), authorizingGrant);
      invariant(
        agentDefinitionGrant.target.type === "agent-definition" &&
          agentDefinitionGrant.target.agentDefinitionId === mount.agentDefinitionId &&
          agentDefinitionGrant.target.projectId === mount.projectId &&
          agentDefinitionGrant.target.environmentId === mount.environmentId,
        "Brain mount does not match its agent definition grant.",
      );
      invariant(
        agentDefinitionGrant.permission === "read-write" || mount.permission === "read",
        "A Brain mount cannot widen its agent grant.",
      );
      const authorizing = brainGrantPlatformRecord(authorizingGrant);
      invariant(
        authorizingGrant.target.type === "principal",
        "A Brain owner grant must target a principal.",
      );
      const agentGrant = brainGrantPlatformRecord(agentDefinitionGrant);
      const record = brainMountPlatformRecord(mount);
      await transactWithSemanticEvents(
        database,
        [
          activeOrganizationCondition(mount.organizationId),
          activeHumanCondition(authorizingGrant.target.principalId),
          activeMemberCondition(mount.organizationId, authorizingGrant.target.principalId),
          activeBrainCondition(brain),
          activeOwnerGrantCondition(authorizing),
          activeMachineGrantCondition(agentGrant),
          {
            conditionExpression:
              "#itemType = :itemType AND #data.#currentState <> :stopped AND #data.#organizationId = :organizationId AND #data.#projectId = :projectId AND #data.#environmentId = :environmentId AND #data.#agentDefinitionId = :agentDefinitionId",
            expressionAttributeNames: {
              "#agentDefinitionId": "agentDefinitionId",
              "#currentState": "currentState",
              "#data": "data",
              "#environmentId": "environmentId",
              "#itemType": "itemType",
              "#organizationId": "organizationId",
              "#projectId": "projectId",
            },
            expressionAttributeValues: {
              ":agentDefinitionId": mount.agentDefinitionId,
              ":environmentId": mount.environmentId,
              ":itemType": "agent-deployment",
              ":organizationId": mount.organizationId,
              ":projectId": mount.projectId,
              ":stopped": "stopped",
            },
            key: {
              pk: key("ORG", mount.organizationId, "ENV", mount.environmentId),
              sk: key("AGENT-DEPLOYMENT", mount.agentDeploymentId),
            },
            kind: "condition-check",
            table: "control",
          },
          ...createOperations(record, mount.createdAt),
        ],
        [mountEvent(record, eventId)],
        eventId,
      );
      return brainMountFromPlatformRecord(record);
    },

    async transferMemberPrivateOwnership({
      brain: nextBrain,
      eventId,
      nextOwnerGrant,
      previousOwnerGrant,
    }) {
      const previous = await getPlatformBrain(nextBrain.organizationId, nextBrain.id);
      invariant(previous, "Brain does not exist in the requested organization.");
      invariant(
        previous.data.kind === "member-private",
        "Only member-private Brain ownership transfers.",
      );
      invariant(
        nextBrain.version === previous.data.version + 1,
        "Brain ownership transfer version mismatch.",
      );
      invariant(
        nextBrain.ownershipGeneration === previous.data.ownershipGeneration + 1,
        "Brain ownership transfer must increment the ownership generation exactly once.",
      );
      validateOwnerGrant(brainFromPlatformRecord(previous), previousOwnerGrant);
      validateOwnerGrant(nextBrain, nextOwnerGrant);
      invariant(previousOwnerGrant.version + 1 > 0, "Previous owner grant version is invalid.");
      const previousGrant = brainGrantPlatformRecord(previousOwnerGrant);
      invariant(
        previousOwnerGrant.target.type === "principal",
        "The previous Brain owner grant must target a principal.",
      );
      const revokedGrant = brainGrantPlatformRecord({
        ...previousOwnerGrant,
        revokedAt: nextBrain.updatedAt,
        status: "revoked",
        updatedAt: nextBrain.updatedAt,
        version: previousOwnerGrant.version + 1,
      });
      const nextGrant = brainGrantPlatformRecord(nextOwnerGrant);
      const next = brainPlatformRecord(nextBrain);
      await transactWithSemanticEvents(
        database,
        [
          activeOrganizationCondition(nextBrain.organizationId),
          activeHumanCondition(previousOwnerGrant.target.principalId),
          activeMemberCondition(nextBrain.organizationId, previousOwnerGrant.target.principalId),
          activeHumanCondition(nextBrain.ownerPrincipalId!),
          activeMemberCondition(nextBrain.organizationId, nextBrain.ownerPrincipalId!, false),
          activeOwnerGrantCondition(previousGrant),
          ...updateOperations(previous, next, nextBrain.updatedAt),
          ...updateOperations(previousGrant, revokedGrant, nextBrain.updatedAt),
          ...createOperations(nextGrant, nextOwnerGrant.createdAt),
        ],
        [
          brainEvent(next, eventId, "brain.ownership-transferred", {
            brainId: nextBrain.id,
            ownershipGeneration: nextBrain.ownershipGeneration,
          }),
        ],
        eventId,
      );
      return brainFromPlatformRecord(next);
    },

    async update({ authorizingGrant, brain: nextBrain, eventId, previous }) {
      invariant(
        nextBrain.version === previous.version + 1,
        "Brain update must increment version exactly once.",
      );
      invariant(
        nextBrain.id === previous.id &&
          nextBrain.organizationId === previous.organizationId &&
          nextBrain.kind === previous.kind &&
          nextBrain.ownerPrincipalId === previous.ownerPrincipalId &&
          nextBrain.ownershipGeneration === previous.ownershipGeneration,
        "Ordinary Brain updates cannot change immutable identity or ownership.",
      );
      validateOwnerGrant(previous, authorizingGrant);
      const previousRecord = brainPlatformRecord(previous);
      const nextRecord = brainPlatformRecord(nextBrain);
      const authorizing = brainGrantPlatformRecord(authorizingGrant);
      invariant(
        authorizingGrant.target.type === "principal",
        "A Brain owner grant must target a principal.",
      );
      await transactWithSemanticEvents(
        database,
        [
          activeOrganizationCondition(nextBrain.organizationId),
          activeHumanCondition(authorizingGrant.target.principalId),
          activeMemberCondition(nextBrain.organizationId, authorizingGrant.target.principalId),
          activeOwnerGrantCondition(authorizing),
          ...updateOperations(previousRecord, nextRecord, nextBrain.updatedAt),
        ],
        [
          brainEvent(nextRecord, eventId, "brain.updated", {
            brainId: nextBrain.id,
            status: nextBrain.status,
          }),
        ],
        eventId,
      );
      return brainFromPlatformRecord(nextRecord);
    },
  };
}
