import type { TransactionOperation } from "../client-types.ts";
import { key } from "../keys.ts";
import { organizationGateCheck } from "../organization-gate/requirements.ts";
import type { BrainGrantPlatformRecord, BrainPlatformRecord } from "./record-mapping.ts";

export function activeOrganizationCondition(organizationId: string): TransactionOperation {
  return organizationGateCheck(organizationId, { kind: "organization-active" });
}

export function activeHumanCondition(principalId: string): TransactionOperation {
  return {
    conditionExpression:
      "#itemType = :itemType AND #data.#status = :active AND #data.#kind = :human",
    expressionAttributeNames: {
      "#data": "data",
      "#itemType": "itemType",
      "#kind": "kind",
      "#status": "status",
    },
    expressionAttributeValues: {
      ":active": "active",
      ":human": "human",
      ":itemType": "principal",
    },
    key: {
      pk: key("PRINCIPAL", principalId),
      sk: key("PRINCIPAL", principalId),
    },
    kind: "condition-check",
    table: "control",
  };
}

export function activeMemberCondition(
  organizationId: string,
  principalId: string,
  elevated = false,
): TransactionOperation {
  return {
    conditionExpression: elevated
      ? "#itemType = :itemType AND #data.#status = :active AND #data.#role IN (:admin, :owner)"
      : "#itemType = :itemType AND #data.#status = :active",
    expressionAttributeNames: {
      "#data": "data",
      "#itemType": "itemType",
      ...(elevated ? { "#role": "role" } : {}),
      "#status": "status",
    },
    expressionAttributeValues: {
      ":active": "active",
      ...(elevated ? { ":admin": "admin", ":owner": "owner" } : {}),
      ":itemType": "organization-member",
    },
    key: {
      pk: key("ORG", organizationId),
      sk: key("ORGANIZATION-MEMBER", principalId),
    },
    kind: "condition-check",
    table: "control",
  };
}

export function activeOwnerGrantCondition(grant: BrainGrantPlatformRecord): TransactionOperation {
  return {
    conditionExpression:
      "#itemType = :itemType AND #data.#status = :active AND #data.#permission = :owner AND #data.#version = :version",
    expressionAttributeNames: {
      "#data": "data",
      "#itemType": "itemType",
      "#permission": "permission",
      "#status": "status",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":active": "active",
      ":itemType": "brain-grant",
      ":owner": "owner",
      ":version": grant.data.version,
    },
    key: { pk: grant.pk, sk: grant.sk },
    kind: "condition-check",
    table: "control",
  };
}

export function activeMachineGrantCondition(grant: BrainGrantPlatformRecord): TransactionOperation {
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
      ":version": grant.data.version,
    },
    key: { pk: grant.pk, sk: grant.sk },
    kind: "condition-check",
    table: "control",
  };
}

export function activeBrainCondition(brain: BrainPlatformRecord): TransactionOperation {
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
      ":itemType": "brain",
      ":version": brain.data.version,
    },
    key: { pk: brain.pk, sk: brain.sk },
    kind: "condition-check",
    table: "control",
  };
}
