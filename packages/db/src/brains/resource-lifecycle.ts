import type {
  BrainGrantTarget,
  BrainRepository,
  BrainResourceListOptions,
} from "@deployments-ai/brains";
import type { DynamoDatabaseService } from "../client-types.ts";
import { key, Keys } from "../keys.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import {
  brainGrantFromPlatformRecord,
  brainGrantPlatformRecord,
  brainMountFromPlatformRecord,
  brainMountPlatformRecord,
  brainUlid,
  type BrainGrantPlatformRecord,
  type BrainMountPlatformRecord,
} from "./record-mapping.ts";
import {
  activeHumanCondition,
  activeMemberCondition,
  activeOrganizationCondition,
  activeOwnerGrantCondition,
} from "./authorization-conditions.ts";
import { updateBrainRecordOperations as updateOperations } from "./record-operations.ts";
import { invariant } from "./repository-invariants.ts";
import { encodeBrainAggregateCursor as encodeCursor } from "./repository-pagination.ts";

const MAX_PAGE_SIZE = 100;

function cursorKey(cursor: string | undefined, expectedPartition: string) {
  if (!cursor) return undefined;
  const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  invariant(value && typeof value === "object" && !Array.isArray(value), "Invalid Brain cursor.");
  const record = value as Readonly<Record<string, unknown>>;
  invariant(
    Object.keys(record).length === 2 &&
      typeof record.pk === "string" &&
      typeof record.sk === "string",
    "Invalid Brain cursor.",
  );
  invariant(record.pk === expectedPartition, "Brain cursor tenant mismatch.");
  return record as Record<string, string>;
}

function grantEvent(grant: BrainGrantPlatformRecord, eventId: string, actorPrincipalId: string) {
  return makeSemanticEventRecord({
    actor: { id: brainUlid(actorPrincipalId), type: "principal" },
    aggregateId: grant.data.id,
    aggregateType: "brain-grant",
    aggregateVersion: grant.data.version + 1,
    eventId: brainUlid(eventId),
    eventType: "brain-grant.revoked",
    occurredAt: grant.data.updatedAt,
    organizationId: grant.data.organizationId,
    payload: {
      brainId: grant.data.brainId,
      grantId: grant.data.id,
      status: grant.data.status,
    },
  });
}

function mountEvent(mount: BrainMountPlatformRecord, eventId: string, actorPrincipalId: string) {
  return makeSemanticEventRecord({
    actor: { id: brainUlid(actorPrincipalId), type: "principal" },
    aggregateId: mount.data.id,
    aggregateType: "brain-deployment-mount",
    aggregateVersion: mount.data.version + 1,
    eventId: brainUlid(eventId),
    eventType: "brain-deployment-mount.revoked",
    occurredAt: mount.data.updatedAt,
    organizationId: mount.data.organizationId,
    payload: {
      brainId: mount.data.brainId,
      mountId: mount.data.id,
      status: mount.data.status,
    },
    projectId: mount.data.projectId,
  });
}

function validateListOptions(options: BrainResourceListOptions) {
  invariant(
    Number.isSafeInteger(options.limit) && options.limit > 0 && options.limit <= MAX_PAGE_SIZE,
    `Brain resource list limit must be between 1 and ${MAX_PAGE_SIZE}.`,
  );
}

export function makeBrainResourceLifecycleRepository(
  database: DynamoDatabaseService,
): Pick<
  BrainRepository,
  | "findActiveGrant"
  | "findActiveMount"
  | "getGrant"
  | "getMount"
  | "listGrants"
  | "listMounts"
  | "revokeGrant"
  | "revokeMount"
> {
  const partition = (organizationId: string, brainId: string) =>
    key("ORG", organizationId, "BRAIN", brainId);

  async function getRecord(organizationId: string, brainId: string, sortKey: string) {
    return await database.getRecord(
      "control",
      { pk: partition(organizationId, brainId), sk: sortKey },
      true,
    );
  }

  function grantTargetValue(target: BrainGrantTarget) {
    switch (target.type) {
      case "agent-definition":
        return `agent-definition:${target.agentDefinitionId}`;
      case "organization-role":
        return `organization-role:${target.organizationRole}`;
      case "principal":
        return `principal:${target.principalId}`;
      case "service-account":
        return `service-account:${target.serviceAccountId}`;
    }
  }

  async function listRecords(
    organizationId: string,
    brainId: string,
    prefix: string,
    options: BrainResourceListOptions,
  ) {
    validateListOptions(options);
    const pk = partition(organizationId, brainId);
    return database.queryRecords("control", {
      ConsistentRead: true,
      ...(options.cursor ? { ExclusiveStartKey: cursorKey(options.cursor, pk) } : {}),
      ExpressionAttributeValues: { ":pk": pk, ":prefix": `${prefix}#` },
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      Limit: options.limit,
    });
  }

  return {
    async findActiveGrant(organizationId, brainId, target) {
      const claim = await database.getRecord(
        "control",
        Keys.control.uniqueClaim(
          `organization:${organizationId}:brain:${brainId}:grant`,
          grantTargetValue(target),
        ),
        true,
      );
      if (claim?.itemType !== "unique-claim" || claim.data.ownerItemType !== "brain-grant") {
        return undefined;
      }
      const record = await database.getRecord(
        "control",
        { pk: claim.data.ownerPk, sk: claim.data.ownerSk },
        true,
      );
      return record?.itemType === "brain-grant" &&
        record.data.organizationId === organizationId &&
        record.data.brainId === brainId &&
        record.data.status === "active"
        ? brainGrantFromPlatformRecord(record)
        : undefined;
    },

    async getGrant(organizationId, brainId, grantId) {
      const record = await getRecord(organizationId, brainId, key("BRAIN-GRANT", grantId));
      return record?.itemType === "brain-grant" && record.data.brainId === brainId
        ? brainGrantFromPlatformRecord(record)
        : undefined;
    },

    async listGrants(organizationId, brainId, options) {
      const result = await listRecords(organizationId, brainId, "BRAIN-GRANT", options);
      const records = result.items.filter(
        (record): record is BrainGrantPlatformRecord =>
          record.itemType === "brain-grant" &&
          record.data.organizationId === organizationId &&
          record.data.brainId === brainId,
      );
      invariant(records.length === result.items.length, "Brain grant aggregate is inconsistent.");
      return {
        items: records.map(brainGrantFromPlatformRecord),
        ...(result.lastEvaluatedKey ? { nextCursor: encodeCursor(result.lastEvaluatedKey)! } : {}),
      };
    },

    async getMount(organizationId, brainId, mountId) {
      const record = await getRecord(
        organizationId,
        brainId,
        key("BRAIN-DEPLOYMENT-MOUNT", mountId),
      );
      return record?.itemType === "brain-deployment-mount" && record.data.brainId === brainId
        ? brainMountFromPlatformRecord(record)
        : undefined;
    },

    async findActiveMount(organizationId, brainId, agentDeploymentId) {
      const claim = await database.getRecord(
        "control",
        Keys.control.uniqueClaim(
          `organization:${organizationId}:agent-deployment:${agentDeploymentId}:brain-mount`,
          brainId,
        ),
        true,
      );
      if (
        claim?.itemType !== "unique-claim" ||
        claim.data.ownerItemType !== "brain-deployment-mount"
      ) {
        return undefined;
      }
      const record = await database.getRecord(
        "control",
        { pk: claim.data.ownerPk, sk: claim.data.ownerSk },
        true,
      );
      return record?.itemType === "brain-deployment-mount" &&
        record.data.organizationId === organizationId &&
        record.data.brainId === brainId &&
        record.data.agentDeploymentId === agentDeploymentId &&
        record.data.status === "active"
        ? brainMountFromPlatformRecord(record)
        : undefined;
    },

    async listMounts(organizationId, brainId, options) {
      const result = await listRecords(organizationId, brainId, "BRAIN-DEPLOYMENT-MOUNT", options);
      const records = result.items.filter(
        (record): record is BrainMountPlatformRecord =>
          record.itemType === "brain-deployment-mount" &&
          record.data.organizationId === organizationId &&
          record.data.brainId === brainId,
      );
      invariant(records.length === result.items.length, "Brain mount aggregate is inconsistent.");
      return {
        items: records.map(brainMountFromPlatformRecord),
        ...(result.lastEvaluatedKey ? { nextCursor: encodeCursor(result.lastEvaluatedKey)! } : {}),
      };
    },

    async revokeGrant({
      actorPrincipalId,
      authorizingGrant,
      eventId,
      grant,
      replacementOwnerGrant,
      revokedAt,
    }) {
      invariant(grant.status === "active", "Only active Brain grants can be revoked.");
      invariant(
        authorizingGrant.status === "active" &&
          authorizingGrant.permission === "owner" &&
          authorizingGrant.organizationId === grant.organizationId &&
          authorizingGrant.brainId === grant.brainId,
        "Brain grant revocation requires a live owner grant.",
      );
      invariant(
        authorizingGrant.target.type === "principal",
        "A Brain owner grant must target a principal.",
      );
      if (grant.brainKind === "member-private" && grant.permission === "owner") {
        throw new TypeError("Member-private ownership must be transferred, not revoked.");
      }
      if (grant.permission === "owner") {
        invariant(
          replacementOwnerGrant &&
            replacementOwnerGrant.id !== grant.id &&
            replacementOwnerGrant.status === "active" &&
            replacementOwnerGrant.permission === "owner" &&
            replacementOwnerGrant.organizationId === grant.organizationId &&
            replacementOwnerGrant.brainId === grant.brainId &&
            replacementOwnerGrant.target.type === "principal",
          "Company Brain owner revocation requires another eligible human owner.",
        );
      }
      const previous = brainGrantPlatformRecord(grant);
      const next = brainGrantPlatformRecord({
        ...grant,
        revokedAt,
        status: "revoked",
        updatedAt: revokedAt,
        version: grant.version + 1,
      });
      await transactWithSemanticEvents(
        database,
        [
          activeOrganizationCondition(grant.organizationId),
          activeHumanCondition(authorizingGrant.target.principalId),
          activeMemberCondition(grant.organizationId, authorizingGrant.target.principalId),
          activeOwnerGrantCondition(brainGrantPlatformRecord(authorizingGrant)),
          ...(replacementOwnerGrant
            ? [activeOwnerGrantCondition(brainGrantPlatformRecord(replacementOwnerGrant))]
            : []),
          ...updateOperations(previous, next, revokedAt),
        ],
        [grantEvent(next, eventId, actorPrincipalId)],
        eventId,
      );
      return brainGrantFromPlatformRecord(next);
    },

    async revokeMount({ actorPrincipalId, authorizingGrant, eventId, mount, revokedAt }) {
      invariant(mount.status === "active", "Only active Brain mounts can be revoked.");
      invariant(
        authorizingGrant.status === "active" &&
          authorizingGrant.permission === "owner" &&
          authorizingGrant.organizationId === mount.organizationId &&
          authorizingGrant.brainId === mount.brainId,
        "Brain mount revocation requires a live owner grant.",
      );
      invariant(
        authorizingGrant.target.type === "principal",
        "A Brain owner grant must target a principal.",
      );
      const previous = brainMountPlatformRecord(mount);
      const next = brainMountPlatformRecord({
        ...mount,
        revokedAt,
        status: "revoked",
        updatedAt: revokedAt,
        version: mount.version + 1,
      });
      await transactWithSemanticEvents(
        database,
        [
          activeOrganizationCondition(mount.organizationId),
          activeHumanCondition(authorizingGrant.target.principalId),
          activeMemberCondition(mount.organizationId, authorizingGrant.target.principalId),
          activeOwnerGrantCondition(brainGrantPlatformRecord(authorizingGrant)),
          ...updateOperations(previous, next, revokedAt),
        ],
        [mountEvent(next, eventId, actorPrincipalId)],
        eventId,
      );
      return brainMountFromPlatformRecord(next);
    },
  };
}
