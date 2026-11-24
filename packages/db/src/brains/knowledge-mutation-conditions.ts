import type { BrainGrant, BrainMutationCaller } from "@deployments-ai/brains";
import type { TransactionOperation } from "../client-types.ts";
import { key } from "../keys.ts";
import { activeHumanCondition, activeMemberCondition } from "./authorization-conditions.ts";
import type { brainGrantPlatformRecord, BrainSourcePlatformRecord } from "./record-mapping.ts";
import { invariant } from "./repository-invariants.ts";

export function activeBrainSourceCondition(
  source: BrainSourcePlatformRecord,
): TransactionOperation {
  return {
    conditionExpression:
      "#itemType = :itemType AND #data.#status = :active AND #data.#version = :version",
    expressionAttributeNames: {
      "#data": "data",
      "#itemType": "itemType",
      "#status": "status",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":active": "active",
      ":itemType": "brain-source",
      ":version": source.data.version,
    },
    key: { pk: source.pk, sk: source.sk },
    kind: "condition-check",
    table: "control",
  };
}

export function activeBrainGrantCondition(
  record: ReturnType<typeof brainGrantPlatformRecord>,
): TransactionOperation {
  return {
    conditionExpression:
      "#itemType = :itemType AND #data.#status = :active AND #data.#version = :version",
    expressionAttributeNames: {
      "#data": "data",
      "#itemType": "itemType",
      "#status": "status",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":active": "active",
      ":itemType": "brain-grant",
      ":version": record.data.version,
    },
    key: { pk: record.pk, sk: record.sk },
    kind: "condition-check",
    table: "control",
  };
}

export function activeBrainWriteGrantCondition(
  record: ReturnType<typeof brainGrantPlatformRecord>,
): TransactionOperation {
  invariant(
    record.data.permission === "owner" ||
      record.data.permission === "curator" ||
      record.data.permission === "writer" ||
      record.data.permission === "read-write",
    "Brain content mutations require a write-capable grant.",
  );
  const targetType = record.data.targetType;
  const targetField =
    targetType === "principal"
      ? { name: "principalId", value: record.data.principalId! }
      : targetType === "organization-role"
        ? { name: "organizationRole", value: record.data.organizationRole! }
        : targetType === "service-account"
          ? { name: "serviceAccountId", value: record.data.serviceAccountId! }
          : { name: "agentDefinitionId", value: record.data.agentDefinitionId! };
  const machineTarget = targetType === "service-account" || targetType === "agent-definition";
  return {
    conditionExpression:
      "#itemType = :itemType AND #data.#status = :active AND #data.#version = :version AND #data.#organizationId = :organizationId AND #data.#brainId = :brainId AND #data.#brainKind = :brainKind AND #data.#permission = :permission AND #data.#targetType = :targetType AND #data.#targetField = :targetField AND " +
      (record.data.ownershipGeneration === undefined
        ? "attribute_not_exists(#data.#ownershipGeneration)"
        : "#data.#ownershipGeneration = :ownershipGeneration") +
      (machineTarget
        ? " AND #data.#targetProjectId = :targetProjectId AND #data.#targetEnvironmentId = :targetEnvironmentId"
        : " AND attribute_not_exists(#data.#targetProjectId) AND attribute_not_exists(#data.#targetEnvironmentId)"),
    expressionAttributeNames: {
      "#brainId": "brainId",
      "#brainKind": "brainKind",
      "#data": "data",
      "#itemType": "itemType",
      "#organizationId": "organizationId",
      "#ownershipGeneration": "ownershipGeneration",
      "#permission": "permission",
      "#status": "status",
      "#targetEnvironmentId": "targetEnvironmentId",
      "#targetField": targetField.name,
      "#targetProjectId": "targetProjectId",
      "#targetType": "targetType",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":active": "active",
      ":brainId": record.data.brainId,
      ":brainKind": record.data.brainKind,
      ":itemType": "brain-grant",
      ":organizationId": record.data.organizationId,
      ...(record.data.ownershipGeneration === undefined
        ? {}
        : { ":ownershipGeneration": record.data.ownershipGeneration }),
      ":permission": record.data.permission,
      ...(machineTarget
        ? {
            ":targetEnvironmentId": record.data.targetEnvironmentId!,
            ":targetProjectId": record.data.targetProjectId!,
          }
        : {}),
      ":targetField": targetField.value,
      ":targetType": targetType,
      ":version": record.data.version,
    },
    key: { pk: record.pk, sk: record.sk },
    kind: "condition-check",
    table: "control",
  };
}

export function brainMutationCallerConditions(
  actor: BrainMutationCaller,
  authorizingGrant: BrainGrant,
  organizationId: string,
  timestamp: string,
): readonly TransactionOperation[] {
  invariant(
    authorizingGrant.organizationId === organizationId &&
      (authorizingGrant.permission === "owner" ||
        authorizingGrant.permission === "curator" ||
        authorizingGrant.permission === "writer" ||
        authorizingGrant.permission === "read-write"),
    "Brain mutation caller requires a tenant-scoped write grant.",
  );
  if (actor.kind === "human") {
    invariant(
      (authorizingGrant.target.type === "principal" &&
        authorizingGrant.target.principalId === actor.principalId) ||
        authorizingGrant.target.type === "organization-role",
      "Brain mutation grant does not authorize the human caller.",
    );
    const membership = activeMemberCondition(organizationId, actor.principalId);
    const authorizedMembership =
      authorizingGrant.target.type === "organization-role"
        ? {
            ...membership,
            conditionExpression: `${membership.conditionExpression} AND #data.#role = :role`,
            expressionAttributeNames: {
              ...membership.expressionAttributeNames,
              "#role": "role",
            },
            expressionAttributeValues: {
              ...membership.expressionAttributeValues,
              ":role": authorizingGrant.target.organizationRole,
            },
          }
        : membership;
    return [activeHumanCondition(actor.principalId), authorizedMembership];
  }
  invariant(
    authorizingGrant.target.type === "service-account" &&
      authorizingGrant.target.serviceAccountId === actor.serviceAccountId &&
      authorizingGrant.target.projectId === actor.projectId &&
      authorizingGrant.target.environmentId === actor.environmentId,
    "Brain mutation grant does not authorize the service caller.",
  );
  return [
    {
      conditionExpression:
        "#itemType = :itemType AND #data.#status = :active AND #data.#organizationId = :organizationId AND #data.#projectId = :projectId AND #data.#environmentId = :environmentId AND (contains(#data.#scopes, :writeScope) OR contains(#data.#scopes, :brainWildcard) OR contains(#data.#scopes, :platformAdmin) OR contains(#data.#scopes, :platformWildcard))",
      expressionAttributeNames: {
        "#data": "data",
        "#environmentId": "environmentId",
        "#itemType": "itemType",
        "#organizationId": "organizationId",
        "#projectId": "projectId",
        "#scopes": "scopes",
        "#status": "status",
      },
      expressionAttributeValues: {
        ":active": "active",
        ":brainWildcard": "brains:*",
        ":environmentId": actor.environmentId,
        ":itemType": "service-account",
        ":organizationId": organizationId,
        ":platformAdmin": "platform:admin",
        ":platformWildcard": "platform:*",
        ":projectId": actor.projectId,
        ":writeScope": "brains:write",
      },
      key: {
        pk: key("ORG", organizationId, "ENV", actor.environmentId),
        sk: key("SERVICE-ACCOUNT", actor.serviceAccountId),
      },
      kind: "condition-check",
      table: "control",
    },
    {
      conditionExpression:
        "#itemType = :itemType AND #data.#status = :active AND #data.#serviceAccountId = :serviceAccountId AND #data.#organizationId = :organizationId AND #data.#projectId = :projectId AND #data.#environmentId = :environmentId AND (attribute_not_exists(#data.#expiresAt) OR #data.#expiresAt > :now) AND (contains(#data.#scopes, :writeScope) OR contains(#data.#scopes, :brainWildcard) OR contains(#data.#scopes, :platformAdmin) OR contains(#data.#scopes, :platformWildcard))",
      expressionAttributeNames: {
        "#data": "data",
        "#expiresAt": "expiresAt",
        "#environmentId": "environmentId",
        "#itemType": "itemType",
        "#organizationId": "organizationId",
        "#projectId": "projectId",
        "#scopes": "scopes",
        "#serviceAccountId": "serviceAccountId",
        "#status": "status",
      },
      expressionAttributeValues: {
        ":active": "active",
        ":brainWildcard": "brains:*",
        ":environmentId": actor.environmentId,
        ":itemType": "api-credential",
        ":now": timestamp,
        ":organizationId": organizationId,
        ":platformAdmin": "platform:admin",
        ":platformWildcard": "platform:*",
        ":projectId": actor.projectId,
        ":serviceAccountId": actor.serviceAccountId,
        ":writeScope": "brains:write",
      },
      key: {
        pk: key("ORG", organizationId, "ENV", actor.environmentId),
        sk: key("API-CREDENTIAL", actor.apiCredentialId),
      },
      kind: "condition-check",
      table: "control",
    },
  ];
}
