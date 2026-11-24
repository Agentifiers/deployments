import { describe, expect, it } from "bun:test";
import { authorizeBrainAccess, type BrainAuthorizationInput } from "./authorization.ts";
import type { Brain, BrainDeploymentMount, BrainGrant } from "./models.ts";

const brain: Brain = {
  createdAt: "2026-07-30T12:00:00.000Z",
  createdByPrincipalId: "principal-1",
  id: "brain-1",
  kind: "company",
  maintenancePolicy: {},
  name: "Engineering",
  organizationId: "organization-1",
  ownershipGeneration: 0,
  retrievalPolicy: {},
  schemaVersion: 1,
  sensitivity: "internal",
  slug: "engineering",
  status: "active",
  updatedAt: "2026-07-30T12:00:00.000Z",
  updatedByPrincipalId: "principal-1",
  version: 0,
};

const humanGrant: BrainGrant = {
  brainId: brain.id,
  brainKind: brain.kind,
  createdAt: brain.createdAt,
  grantedByPrincipalId: "principal-1",
  id: "grant-1",
  organizationId: brain.organizationId,
  permission: "owner",
  status: "active",
  target: { principalId: "principal-1", type: "principal" },
  updatedAt: brain.updatedAt,
  version: 0,
};

function input(overrides: Partial<BrainAuthorizationInput> = {}): BrainAuthorizationInput {
  return {
    brain,
    caller: {
      kind: "human",
      membershipActive: true,
      organizationRole: "owner",
      principalActive: true,
      principalId: "principal-1",
      scopes: ["brains:*"],
    },
    callerGrant: humanGrant,
    operation: "read",
    ownerActive: true,
    organizationActive: true,
    ...overrides,
  };
}

describe("Brain live authorization", () => {
  it("allows an active human only within the live grant permission", () => {
    expect(authorizeBrainAccess(input())).toEqual({ allowed: true });
    expect(
      authorizeBrainAccess(
        input({
          callerGrant: { ...humanGrant, permission: "reader" },
          operation: "write",
        }),
      ),
    ).toEqual({ allowed: false, reason: "permission-denied" });
  });

  it("accepts the platform administrator scope at the shared Brain boundary", () => {
    expect(
      authorizeBrainAccess(
        input({
          caller: {
            kind: "human",
            membershipActive: true,
            organizationRole: "owner",
            principalActive: true,
            principalId: "principal-1",
            scopes: ["platform:admin"],
          },
          operation: "write",
        }),
      ),
    ).toEqual({ allowed: true });
  });

  it("invalidates every former-owner delegation after ownership generation advances", () => {
    const privateBrain: Brain = {
      ...brain,
      kind: "member-private",
      ownerPrincipalId: "principal-2",
      ownershipGeneration: 2,
    };
    const formerOwnerServiceGrant: BrainGrant = {
      ...humanGrant,
      brainKind: "member-private",
      ownershipGeneration: 1,
      permission: "read-write",
      target: {
        environmentId: "environment-1",
        projectId: "project-1",
        serviceAccountId: "service-1",
        type: "service-account",
      },
    };

    expect(
      authorizeBrainAccess(
        input({
          brain: privateBrain,
          caller: {
            credentialActive: true,
            environmentId: "environment-1",
            kind: "service",
            organizationId: brain.organizationId,
            projectId: "project-1",
            scopes: ["brains:read"],
            serviceAccountActive: true,
            serviceAccountId: "service-1",
          },
          callerGrant: formerOwnerServiceGrant,
        }),
      ),
    ).toEqual({ allowed: false, reason: "caller-grant-invalid" });
  });

  it("requires the current member-private owner to remain active", () => {
    const privateBrain: Brain = {
      ...brain,
      kind: "member-private",
      ownerPrincipalId: "principal-1",
      ownershipGeneration: 1,
    };
    expect(
      authorizeBrainAccess(
        input({
          brain: privateBrain,
          callerGrant: {
            ...humanGrant,
            brainKind: "member-private",
            ownershipGeneration: 1,
          },
          ownerActive: false,
        }),
      ),
    ).toEqual({ allowed: false, reason: "owner-inactive" });
  });

  it("permits no ordinary human other than a member-private owner", () => {
    const privateBrain: Brain = {
      ...brain,
      kind: "member-private",
      ownerPrincipalId: "principal-2",
      ownershipGeneration: 1,
    };
    expect(
      authorizeBrainAccess(
        input({
          brain: privateBrain,
          callerGrant: {
            ...humanGrant,
            brainKind: "member-private",
            ownershipGeneration: 1,
          },
        }),
      ),
    ).toEqual({ allowed: false, reason: "permission-denied" });
  });

  it("intersects caller, agent grant, deployment mount, and release permission", () => {
    const agentGrant: BrainGrant = {
      ...humanGrant,
      id: "agent-grant",
      permission: "read-write",
      target: {
        agentDefinitionId: "agent-1",
        environmentId: "environment-1",
        projectId: "project-1",
        type: "agent-definition",
      },
    };
    const mount: BrainDeploymentMount = {
      agentDefinitionId: "agent-1",
      agentDeploymentId: "deployment-1",
      brainId: brain.id,
      brainKind: brain.kind,
      createdAt: brain.createdAt,
      grantedByPrincipalId: "principal-1",
      id: "mount-1",
      organizationId: brain.organizationId,
      permission: "read-write",
      environmentId: "environment-1",
      projectId: "project-1",
      status: "active",
      updatedAt: brain.updatedAt,
      version: 0,
    };
    const agent = {
      agentDefinitionGrant: agentGrant,
      agentDefinitionId: "agent-1",
      deploymentId: "deployment-1",
      mount,
      releasePermission: "read" as const,
    };

    expect(authorizeBrainAccess(input({ agent, operation: "read" }))).toEqual({
      allowed: true,
    });
    expect(authorizeBrainAccess(input({ agent, operation: "write" }))).toEqual({
      allowed: false,
      reason: "permission-denied",
    });
  });

  it("fails closed on revoked mounts and changed tenant identity", () => {
    const agentGrant: BrainGrant = {
      ...humanGrant,
      permission: "read",
      target: {
        agentDefinitionId: "agent-1",
        environmentId: "environment-1",
        projectId: "project-1",
        type: "agent-definition",
      },
    };
    const mount: BrainDeploymentMount = {
      agentDefinitionId: "agent-1",
      agentDeploymentId: "deployment-1",
      brainId: brain.id,
      brainKind: brain.kind,
      createdAt: brain.createdAt,
      grantedByPrincipalId: "principal-1",
      id: "mount-1",
      organizationId: "another-organization",
      permission: "read",
      environmentId: "environment-1",
      projectId: "project-1",
      revokedAt: brain.updatedAt,
      status: "revoked",
      updatedAt: brain.updatedAt,
      version: 1,
    };

    expect(
      authorizeBrainAccess(
        input({
          agent: {
            agentDefinitionGrant: agentGrant,
            agentDefinitionId: "agent-1",
            deploymentId: "deployment-1",
            mount,
            releasePermission: "read",
          },
        }),
      ),
    ).toEqual({ allowed: false, reason: "agent-mount-invalid" });
  });
});
