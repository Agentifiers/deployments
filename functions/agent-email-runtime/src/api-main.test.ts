import { describe, expect, it } from "bun:test";
import {
  agentEmailIdentityFromApiIdentity,
  agentEmailPlacementIdentityResources,
  agentEmailTenantIdentityResources,
  assertAgentEmailEnvironmentActive,
  hostedAgentEmailDomainSeed,
  persistHostedDomainBeforeTenantReconciliation,
  validateAgentEmailDeployment,
} from "./api-main.ts";

const scope = {
  environmentId: "environment",
  organizationId: "organization",
  projectId: "project",
};

function manifest(triggers: readonly string[]) {
  return {
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: {
      key: "email.assistant",
      name: "Email Assistant",
      version: "1.0.0",
    },
    spec: {
      capabilities: { tools: [] },
      instructions: "Answer incoming email.",
      memory: { mode: "thread" },
      model: { id: "openrouter/default" },
      runtime: { toolRequests: [] },
      sandbox: { mode: "none" },
      skills: [],
      triggers,
    },
  };
}

function deployment() {
  return {
    data: {
      agentDefinitionId: "definition",
      agentReleaseId: "release",
      currentState: "ready",
      desiredState: "running",
      environmentId: scope.environmentId,
      id: "deployment",
      organizationId: scope.organizationId,
      projectId: scope.projectId,
    },
    itemType: "agent-deployment" as const,
  };
}

function release(status: "active" | "archived" | "draft", triggers: readonly string[]) {
  return {
    data: {
      agentDefinitionId: "definition",
      environmentId: scope.environmentId,
      id: "release",
      manifest: manifest(triggers),
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      status,
    },
    itemType: "agent-release" as const,
  };
}

describe("agent email API Lambda composition", () => {
  it("adapts an exact authenticated hierarchy and preserves permissions", () => {
    expect(
      agentEmailIdentityFromApiIdentity({
        apiCredentialId: "credential",
        authentication: "api-credential",
        environmentIds: ["environment"],
        organizationIds: ["organization"],
        principalId: "principal",
        projectIds: ["project"],
        scopes: ["agent-email:read", "agent-email:write"],
      }),
    ).toEqual({
      apiCredentialId: "credential",
      authentication: "api-credential",
      permissions: ["agent-email:read", "agent-email:write"],
      principalId: "principal",
      scope: {
        environmentId: "environment",
        organizationId: "organization",
        projectId: "project",
      },
    });
  });

  it("fails authentication closed for ambiguous or incomplete hierarchy scopes", () => {
    const base = {
      environmentIds: ["environment"],
      organizationIds: ["organization"],
      principalId: "principal",
      projectIds: ["project"],
      scopes: ["agent-email:read"],
    } as const;
    expect(agentEmailIdentityFromApiIdentity(null)).toBeNull();
    expect(agentEmailIdentityFromApiIdentity({ ...base, environmentIds: "*" })).toBeNull();
    expect(
      agentEmailIdentityFromApiIdentity({
        ...base,
        projectIds: ["project", "other-project"],
      }),
    ).toBeNull();
    const { organizationIds: _organizationIds, ...incomplete } = base;
    expect(agentEmailIdentityFromApiIdentity(incomplete)).toBeNull();
  });

  it("derives a stable provider-managed hosted domain for each environment", () => {
    const first = hostedAgentEmailDomainSeed(
      scope,
      "Agents.Example.com.",
      "2026-07-26T00:00:00.000Z",
    );
    const retry = hostedAgentEmailDomainSeed(
      scope,
      "agents.example.com",
      "2026-07-27T00:00:00.000Z",
    );

    expect(first).toMatchObject({
      domain: "agents.example.com",
      mailFromDomain: "bounce.agents.example.com",
      providerManaged: true,
      status: "pending",
    });
    expect(retry.id).toBe(first.id);
  });

  it("recomputes tenant identity associations from current verified domains", () => {
    const placement = {
      createdAt: "2026-07-26T00:00:00.000Z",
      dedicatedPool: false,
      id: "current",
      isDefault: false,
      name: "Current",
      organizationId: scope.organizationId,
      provider: "ses" as const,
      providerMetadata: {},
      region: "us-east-1",
      status: "active" as const,
      updatedAt: "2026-07-26T00:00:00.000Z",
    };
    const domains = [
      { data: { domain: "current.example.com", placementId: "current", status: "verified" } },
      { data: { domain: "revoked.example.com", placementId: "current", status: "revoked" } },
      { data: { domain: "other.example.com", placementId: "other", status: "verified" } },
      {
        data: {
          domain: "agents.example.com",
          providerManaged: true,
          status: "verified",
        },
      },
    ] as never;
    const placements = [
      {
        data: {
          id: "other",
          region: "us-east-1",
          status: "active",
        },
      },
    ] as never;

    expect(
      agentEmailTenantIdentityResources({
        accountId: "123456789012",
        domains,
        mode: "dissociate",
        placement,
        placements,
        region: "us-east-1",
        tenantRegion: "us-east-1",
      }),
    ).toEqual(["arn:aws:ses:us-east-1:123456789012:identity/other.example.com"]);
    expect(
      agentEmailPlacementIdentityResources({
        accountId: "123456789012",
        domains,
        placement,
        tenantRegion: "us-east-1",
      }),
    ).toEqual([
      "arn:aws:ses:us-east-1:123456789012:identity/current.example.com",
      "arn:aws:ses:us-east-1:123456789012:identity/revoked.example.com",
    ]);
  });

  it("propagates hosted-domain tenant reconciliation failures after persistence", async () => {
    const providerFailure = new Error("SES tenant reconciliation failed");
    expect(
      persistHostedDomainBeforeTenantReconciliation({
        create: async () => {},
        loadCommitted: async () => undefined,
        reconcile: async () => {
          throw providerFailure;
        },
      }),
    ).rejects.toBe(providerFailure);
  });

  it("reconciles after an ambiguous hosted-domain create committed", async () => {
    let reconciled = false;
    expect(
      persistHostedDomainBeforeTenantReconciliation({
        create: async () => {
          throw new Error("DynamoDB response was lost");
        },
        loadCommitted: async () => ({ id: "committed-domain" }),
        reconcile: async () => {
          reconciled = true;
        },
      }),
    ).resolves.toBeUndefined();
    expect(reconciled).toBe(true);
  });

  it("accepts bindings only when the pinned active release allows email", async () => {
    const valid = await validateAgentEmailDeployment(scope, "deployment", {
      loadAgentDeployment: async () => deployment() as never,
      loadAgentRelease: async () => release("active", ["api", "email"]) as never,
    });
    expect(String(valid?.agentDefinitionId)).toBe("definition");

    expect(
      validateAgentEmailDeployment(scope, "deployment", {
        loadAgentDeployment: async () => deployment() as never,
        loadAgentRelease: async () => release("archived", ["email"]) as never,
      }),
    ).resolves.toBeUndefined();

    expect(
      validateAgentEmailDeployment(scope, "deployment", {
        loadAgentDeployment: async () => deployment() as never,
        loadAgentRelease: async () => release("active", ["api"]) as never,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects API work outside an exact active environment", () => {
    const environment = {
      data: {
        id: scope.environmentId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        status: "archived",
      },
      itemType: "environment" as const,
    };

    expect(() => assertAgentEmailEnvironmentActive(environment as never, scope)).toThrow(
      "inactive environment",
    );
    expect(() =>
      assertAgentEmailEnvironmentActive(
        {
          ...environment,
          data: { ...environment.data, status: "active" },
        } as never,
        scope,
      ),
    ).not.toThrow();
  });
});
