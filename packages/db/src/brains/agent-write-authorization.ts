import type { BrainAgentWriteAuthorization } from "@deployments-ai/brains";
import type { TransactionOperation } from "../client-types.ts";
import { key } from "../keys.ts";
import { brainGrantPlatformRecord, brainMountPlatformRecord } from "./record-mapping.ts";
import { activeBrainWriteGrantCondition } from "./knowledge-mutation-conditions.ts";
import { invariant } from "./repository-invariants.ts";

export function brainAgentWriteConditions(
  organizationId: string,
  authorization: BrainAgentWriteAuthorization | undefined,
): readonly TransactionOperation[] {
  if (!authorization) return [];
  const mount = brainMountPlatformRecord(authorization.mount);
  const grant = authorization.agentDefinitionGrant;
  invariant(
    grant.organizationId === organizationId &&
      grant.id !== authorization.callerGrant.id &&
      grant.target.type === "agent-definition" &&
      grant.target.agentDefinitionId === authorization.agentDefinitionId &&
      grant.target.projectId === authorization.mount.projectId &&
      grant.target.environmentId === authorization.mount.environmentId &&
      grant.brainId === authorization.mount.brainId &&
      grant.brainKind === authorization.mount.brainKind &&
      grant.permission === "read-write",
    "Agent Brain writes require the matching live agent-definition grant.",
  );
  return [
    activeBrainWriteGrantCondition(brainGrantPlatformRecord(grant)),
    {
      conditionExpression:
        "#itemType = :itemType AND #data.#status = :active AND #data.#permission = :permission AND #data.#version = :version AND #data.#agentDefinitionId = :agentDefinitionId AND #data.#agentDeploymentId = :deploymentId",
      expressionAttributeNames: {
        "#agentDefinitionId": "agentDefinitionId",
        "#agentDeploymentId": "agentDeploymentId",
        "#data": "data",
        "#itemType": "itemType",
        "#permission": "permission",
        "#status": "status",
        "#version": "version",
      },
      expressionAttributeValues: {
        ":active": "active",
        ":agentDefinitionId": authorization.agentDefinitionId,
        ":deploymentId": authorization.agentDeploymentId,
        ":itemType": "brain-deployment-mount",
        ":permission": "read-write",
        ":version": authorization.mount.version,
      },
      key: { pk: mount.pk, sk: mount.sk },
      kind: "condition-check",
      table: "control",
    },
    {
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
        ":itemType": "agent-definition",
        ":version": authorization.agentDefinitionVersion,
      },
      key: {
        pk: key("ORG", organizationId, "ENV", authorization.mount.environmentId),
        sk: key("AGENT-DEFINITION", authorization.agentDefinitionId),
      },
      kind: "condition-check",
      table: "control",
    },
    {
      conditionExpression:
        "#itemType = :itemType AND #data.#version = :version AND #data.#currentState = :ready AND #data.#desiredState = :running AND #data.#agentDefinitionId = :agentDefinitionId AND #data.#agentReleaseId = :releaseId",
      expressionAttributeNames: {
        "#agentDefinitionId": "agentDefinitionId",
        "#agentReleaseId": "agentReleaseId",
        "#currentState": "currentState",
        "#data": "data",
        "#desiredState": "desiredState",
        "#itemType": "itemType",
        "#version": "version",
      },
      expressionAttributeValues: {
        ":agentDefinitionId": authorization.agentDefinitionId,
        ":itemType": "agent-deployment",
        ":ready": "ready",
        ":releaseId": authorization.agentReleaseId,
        ":running": "running",
        ":version": authorization.agentDeploymentVersion,
      },
      key: {
        pk: key("ORG", organizationId, "ENV", authorization.mount.environmentId),
        sk: key("AGENT-DEPLOYMENT", authorization.agentDeploymentId),
      },
      kind: "condition-check",
      table: "control",
    },
    {
      conditionExpression:
        "#itemType = :itemType AND #data.#status = :active AND #data.#version = :version AND #data.#contentHash = :contentHash AND #data.#agentDefinitionId = :agentDefinitionId",
      expressionAttributeNames: {
        "#agentDefinitionId": "agentDefinitionId",
        "#contentHash": "contentHash",
        "#data": "data",
        "#itemType": "itemType",
        "#status": "status",
        "#version": "version",
      },
      expressionAttributeValues: {
        ":active": "active",
        ":agentDefinitionId": authorization.agentDefinitionId,
        ":contentHash": authorization.agentReleaseContentHash,
        ":itemType": "agent-release",
        ":version": authorization.agentReleaseVersion,
      },
      key: {
        pk: key("ORG", organizationId, "ENV", authorization.mount.environmentId),
        sk: key("AGENT-RELEASE", authorization.agentReleaseId),
      },
      kind: "condition-check",
      table: "control",
    },
  ];
}
