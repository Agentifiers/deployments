import { describe, expect, test } from "bun:test";
import type {
  BrainAgentWriteAuthorization,
  BrainDeploymentMount,
  BrainGrant,
} from "@deployments-ai/brains";
import { brainAgentWriteConditions } from "./agent-write-authorization.ts";

const timestamp = "2026-07-31T00:00:00.000Z";
const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const brainId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const principalId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const environmentId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const agentDefinitionId = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

const callerGrant: BrainGrant = {
  brainId,
  brainKind: "company",
  createdAt: timestamp,
  grantedByPrincipalId: principalId,
  id: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
  organizationId,
  permission: "owner",
  status: "active",
  target: { principalId, type: "principal" },
  updatedAt: timestamp,
  version: 0,
};

const agentDefinitionGrant: BrainGrant = {
  ...callerGrant,
  id: "01ARZ3NDEKTSV4RRFFQ69G5FB2",
  permission: "read-write",
  target: {
    agentDefinitionId,
    environmentId,
    projectId,
    type: "agent-definition",
  },
};

const mount: BrainDeploymentMount = {
  agentDefinitionId,
  agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FB3",
  brainId,
  brainKind: "company",
  createdAt: timestamp,
  environmentId,
  grantedByPrincipalId: principalId,
  id: "01ARZ3NDEKTSV4RRFFQ69G5FB4",
  organizationId,
  permission: "read-write",
  projectId,
  status: "active",
  updatedAt: timestamp,
  version: 0,
};

function authorization(grant: BrainGrant = agentDefinitionGrant): BrainAgentWriteAuthorization {
  return {
    agentDefinitionGrant: grant,
    agentDefinitionId,
    agentDefinitionVersion: 2,
    agentDeploymentId: mount.agentDeploymentId,
    agentDeploymentVersion: 3,
    agentReleaseContentHash: "sha256:release",
    agentReleaseId: "01ARZ3NDEKTSV4RRFFQ69G5FB5",
    agentReleaseVersion: 4,
    callerGrant,
    mount,
  };
}

describe("Brain agent write authorization", () => {
  test("transactionally fences the exact write-capable agent-definition grant", () => {
    const conditions = brainAgentWriteConditions(organizationId, authorization());

    expect(conditions[0]).toMatchObject({
      expressionAttributeValues: {
        ":permission": "read-write",
        ":targetEnvironmentId": environmentId,
        ":targetField": agentDefinitionId,
        ":targetProjectId": projectId,
        ":targetType": "agent-definition",
      },
    });
    expect(
      conditions.map((condition) => condition.expressionAttributeValues?.[":itemType"]),
    ).toEqual([
      "brain-grant",
      "brain-deployment-mount",
      "agent-definition",
      "agent-deployment",
      "agent-release",
    ]);
  });

  test("rejects an agent-definition grant without write permission before persistence", () => {
    expect(() =>
      brainAgentWriteConditions(
        organizationId,
        authorization({ ...agentDefinitionGrant, permission: "read" }),
      ),
    ).toThrow("agent-definition grant");
  });
});
