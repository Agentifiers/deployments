import { describe, expect, test } from "bun:test";
import type { PublicApiRouteContract } from "@deployments-ai/api-contract/route-contract";
import {
  CREDENTIAL_REFERENCE_API_ROUTES,
  MODEL_API_ROUTES,
  PROVIDER_API_ROUTES,
  TOOL_CATALOG_API_ROUTES,
  TOOLING_API_ROUTES,
} from "@deployments-ai/api-contract";
import { PUBLIC_API_ROUTES, publicRouteContract } from "@deployments-ai/api-contract/product";
import {
  ORGANIZATION_CAPABILITY_RULES,
  ORGANIZATION_ROLES,
  effectiveOrganizationCapabilities,
  operationRoleAction,
  organizationRoleAllows,
} from "@deployments-ai/db";
import { PLATFORM_CLI_SCOPES } from "@deployments-ai/identity";
import {
  CONSOLE_OPERATIONS,
  ENFORCED_SCOPES,
  operationAccess,
  operationRequirement,
  type ConsoleOperation,
} from "./access.ts";
import { canUseRoute, type ConsoleAuthorization } from "./permissions.ts";

const gatedRoutes = (PUBLIC_API_ROUTES as readonly PublicApiRouteContract[]).filter(
  (route) => route.requiredAuthorization !== undefined,
);

/** What `/v1/whoami` returns for a member holding the platform CLI/web scopes. */
function memberAuthorization(role: (typeof ORGANIZATION_ROLES)[number]): ConsoleAuthorization {
  return {
    capabilities: effectiveOrganizationCapabilities(role, PLATFORM_CLI_SCOPES),
    organizationRole: role,
  };
}

describe("canUseRoute", () => {
  test("covers operations that declare a required scope", () => {
    expect(gatedRoutes.length).toBeGreaterThan(100);
  });

  for (const role of ORGANIZATION_ROLES) {
    test(`follows the organization role matrix for ${role}`, () => {
      const authorization = memberAuthorization(role);
      for (const route of gatedRoutes) {
        const required = route.requiredAuthorization!;
        const [namespace = "", level = ""] = required.split(":");
        const action = ORGANIZATION_CAPABILITY_RULES[namespace]?.restricted[level];
        const expected =
          (PLATFORM_CLI_SCOPES as readonly string[]).includes(required) &&
          (action === undefined || organizationRoleAllows(role, action));
        expect({ route: route.name, allowed: canUseRoute(authorization, route) }).toEqual({
          route: route.name,
          allowed: expected,
        });
      }
    });
  }

  test("lets only owners and admins mutate runtime resources", () => {
    const resolveApproval = publicRouteContract("resolveApproval");
    expect(resolveApproval.requiredAuthorization).toBe("approvals:write");
    const allowed = ORGANIZATION_ROLES.filter((role) =>
      canUseRoute(memberAuthorization(role), resolveApproval),
    );
    expect(allowed).toEqual(["owner", "admin"]);
  });

  test("reserves system operations for platform administrators", () => {
    const installation = publicRouteContract("getSystemInstallation");
    for (const role of ORGANIZATION_ROLES) {
      expect(canUseRoute(memberAuthorization(role), installation)).toBe(false);
    }
    expect(
      canUseRoute(
        { capabilities: PLATFORM_CLI_SCOPES, platformRole: "administrator" },
        installation,
      ),
    ).toBe(true);
  });

  test("denies callers without a role in the selected organization", () => {
    expect(
      canUseRoute({ capabilities: PLATFORM_CLI_SCOPES }, publicRouteContract("getEnvironment")),
    ).toBe(false);
  });

  test("allows members operations that declare no scope", () => {
    const route = publicRouteContract("getEnvironment");
    expect(route.requiredAuthorization).toBeUndefined();
    expect(canUseRoute(memberAuthorization("viewer"), route)).toBe(true);
  });

  test("holds platform administrators to their token scopes outside platform operations", () => {
    const administrator: ConsoleAuthorization = {
      capabilities: ["observability:read"],
      platformRole: "administrator",
    };
    expect(canUseRoute(administrator, publicRouteContract("listObservabilityTraces"))).toBe(true);
    expect(canUseRoute(administrator, publicRouteContract("listChannelBindings"))).toBe(false);
  });

  test("applies an operation's role action: only owners request tenant erasure", () => {
    const erasure = {
      ...publicRouteContract("createTenantErasure"),
      requiredRoleAction: operationRoleAction("createTenantErasure"),
    };
    expect(
      ORGANIZATION_ROLES.filter((role) => canUseRoute(memberAuthorization(role), erasure)),
    ).toEqual(["owner"]);
    expect(
      canUseRoute({ capabilities: ["governance:write"], platformRole: "administrator" }, erasure),
    ).toBe(true);
  });
});

describe("console operation scopes", () => {
  const managers = ["owner", "admin"];
  const everyone = ["owner", "admin", "billing", "member", "viewer"];

  function whoMay(operations: readonly ConsoleOperation[]): [ConsoleOperation, string[]][] {
    const access = ORGANIZATION_ROLES.map((role) => ({
      role,
      access: operationAccess(memberAuthorization(role)),
    }));
    return operations.map((operation) => [
      operation,
      access.filter((entry) => entry.access[operation]).map((entry) => entry.role),
    ]);
  }

  function expectWhoMay(expected: readonly [ConsoleOperation, string[]][]) {
    expect(whoMay(expected.map(([operation]) => operation))).toEqual([...expected]);
  }

  test("every console operation resolves to the scope the API enforces", () => {
    const unresolved = CONSOLE_OPERATIONS.filter((operation) => {
      const declared = publicRouteContract(operation).requiredAuthorization;
      const enforced = ENFORCED_SCOPES[operation];
      return (declared === undefined) === (enforced === undefined);
    });
    expect(unresolved).toEqual([]);
  });

  test("administration operations resolve to the scope the dispatcher derives", () => {
    const administration: readonly PublicApiRouteContract[] = [
      ...PROVIDER_API_ROUTES,
      ...TOOLING_API_ROUTES,
      ...TOOL_CATALOG_API_ROUTES,
      ...MODEL_API_ROUTES,
      ...CREDENTIAL_REFERENCE_API_ROUTES,
    ];
    const routes = new Map(administration.map((route) => [route.name, route]));
    const served = CONSOLE_OPERATIONS.flatMap((operation) => {
      const route = routes.get(operation);
      return route === undefined ? [] : [{ operation, route }];
    });
    expect(served.length).toBeGreaterThan(40);
    expect(
      served.map(({ operation }) => [
        operation,
        operationRequirement(operation).requiredAuthorization,
      ]),
    ).toEqual(
      served.map(({ operation, route }) => [
        operation,
        route.requiredAuthorization ??
          `${route.tag === "Providers" ? "providers" : "tools"}:${route.method === "GET" ? "read" : "write"}`,
      ]),
    );
  });

  test("lets only owners and admins operate agent deployments", () => {
    expectWhoMay([
      ["abortAgentDeploymentCanary", managers],
      ["createAgentDeployment", managers],
      ["promoteAgentDeploymentCanary", managers],
      ["startAgentDeploymentCanary", managers],
      ["stopAgentDeployment", managers],
      ["updateAgentDeployment", managers],
    ]);
  });

  test("lets owners and admins manage people and tenancy; every member lists members", () => {
    expectWhoMay([
      ["createEnvironment", managers],
      ["createOrganizationInvitation", managers],
      ["createProject", managers],
      ["listOrganizationInvitations", managers],
      ["listOrganizationMembers", everyone],
      ["removeOrganizationMember", managers],
      ["revokeOrganizationInvitation", managers],
      ["updateOrganizationMember", managers],
    ]);
  });

  test("lets owners alone rename the organization; owners and admins change projects, environments, workspaces, and automations", () => {
    expectWhoMay([
      ["archiveEnvironment", managers],
      ["archiveProject", managers],
      ["archiveWorkspace", managers],
      ["createHeartbeat", managers],
      ["createSchedule", managers],
      ["getProject", everyone],
      ["getWorkspace", everyone],
      ["updateEnvironment", managers],
      ["updateHeartbeat", managers],
      ["updateOrganization", ["owner"]],
      ["updateProject", managers],
      ["updateSchedule", managers],
      ["updateWorkspace", managers],
    ]);
  });

  test("lets owners and admins operate runs, approvals, API keys, and webhooks; members read", () => {
    expectWhoMay([
      ["archiveWebhook", managers],
      ["cancelRun", managers],
      ["createApiCredential", managers],
      ["createServiceAccount", managers],
      ["createWebhook", managers],
      ["disableWebhook", managers],
      ["enableWebhook", managers],
      ["getApproval", everyone],
      ["getRunById", everyone],
      ["getThread", everyone],
      ["getWebhook", everyone],
      ["getWebhookDelivery", everyone],
      ["listApiCredentialUsage", everyone],
      ["listApiCredentials", everyone],
      ["listRunLogs", everyone],
      ["listRunToolCalls", everyone],
      ["listServiceAccounts", everyone],
      ["listThreadMessages", everyone],
      ["listWebhookDeliveryAttempts", everyone],
      ["listWebhooks", everyone],
      ["replayRun", managers],
      ["resolveApproval", managers],
      ["retryRun", managers],
      ["retryWebhookDelivery", managers],
      ["revokeApiCredential", managers],
      ["revokeServiceAccount", managers],
      ["rotateApiCredential", managers],
      ["rotateWebhookSecret", managers],
      ["testWebhook", managers],
      ["updateWebhook", managers],
    ]);
  });

  test("lets every role read workflows and only owners and admins change or run them", () => {
    expectWhoMay([
      ["getWorkflowApproval", everyone],
      ["getWorkflowDefinition", everyone],
      ["getWorkflowExecution", everyone],
      ["getWorkflowRelease", everyone],
      ["listWorkflowDefinitions", everyone],
      ["listWorkflowExecutions", everyone],
      ["listWorkflowReleases", everyone],
      ["listWorkflowStepAttempts", everyone],
      ["archiveWorkflowDefinition", managers],
      ["archiveWorkflowRelease", managers],
      ["cancelWorkflowExecution", managers],
      ["createWorkflowDefinition", managers],
      ["publishWorkflowRelease", managers],
      ["resolveWorkflowApproval", managers],
      ["startWorkflowExecution", managers],
      ["updateWorkflowDefinition", managers],
    ]);
  });

  test("lets owners, admins, and billing members change budgets; every role reads them", () => {
    const writers = ["owner", "admin", "billing"];
    expectWhoMay([
      ["archiveBudget", writers],
      ["createBudget", writers],
      ["getBudget", everyone],
      ["listBudgetPeriods", everyone],
      ["listBudgets", everyone],
      ["updateBudget", writers],
    ]);
  });

  test("lets owners and admins change monitors; every role reads alerts and sets its own email", () => {
    const managers = ["owner", "admin"];
    expectWhoMay([
      ["archiveMonitor", managers],
      ["createMonitor", managers],
      ["getAlertIncident", everyone],
      ["getAlertNotificationPreferences", everyone],
      ["getMonitor", everyone],
      ["listAlertIncidents", everyone],
      ["listMonitors", everyone],
      ["putAlertNotificationPreferences", everyone],
      ["testMonitor", managers],
      ["updateMonitor", managers],
    ]);
  });

  test("offers every Brain operation to every role; per-Brain grants decide inside the API", () => {
    expectWhoMay([
      ["archiveBrain", everyone],
      ["askBrains", everyone],
      ["captureBrainDocument", everyone],
      ["createBrain", everyone],
      ["createBrainGrant", everyone],
      ["createBrainMount", everyone],
      ["createBrainSource", everyone],
      ["createBrainUploadTicket", everyone],
      ["eraseBrain", everyone],
      ["getBrain", everyone],
      ["getBrainDocument", everyone],
      ["getBrainEntity", everyone],
      ["getBrainErasure", everyone],
      ["getBrainUploadTicket", everyone],
      ["listBrainGrants", everyone],
      ["listBrainIndexHealth", everyone],
      ["listBrainMounts", everyone],
      ["listBrainReviewItems", everyone],
      ["listBrainSources", everyone],
      ["listBrains", everyone],
      ["recordBrainFeedback", everyone],
      ["resolveBrainReviewItem", everyone],
      ["revokeBrainGrant", everyone],
      ["revokeBrainMount", everyone],
      ["searchBrains", everyone],
      ["updateBrain", everyone],
      ["uploadBrainContent", everyone],
    ]);
  });

  test("lets owners and admins manage connections, grants, and workspaces; members read", () => {
    expectWhoMay([
      ["createConnectionGrant", managers],
      ["createProviderCredential", managers],
      ["createWorkspace", managers],
      ["getAgentDeployment", everyone],
      ["getConnectionVerification", everyone],
      ["getProviderConnection", everyone],
      ["listConnectionCapabilities", everyone],
      ["listWorkspaces", everyone],
      ["requestConnectionVerification", managers],
      ["revokeConnectionGrant", managers],
      ["revokeProviderConnection", managers],
      ["rotateProviderCredential", managers],
      ["archiveProviderApplication", managers],
      ["beginProviderAuthorization", managers],
      ["createProviderApplication", managers],
      ["listProviderApplications", everyone],
      ["rotateProviderApplicationSecret", managers],
    ]);
  });

  test("lets owners and admins change tool policies, MCP servers, and extensions; members read", () => {
    expectWhoMay([
      ["archiveExtensionTool", managers],
      ["archiveMcpServer", managers],
      ["archiveToolPolicy", managers],
      ["createExtensionTool", managers],
      ["createHostedCodeArtifact", managers],
      ["createMcpConnection", managers],
      ["createMcpServer", managers],
      ["createToolPolicy", managers],
      ["discoverMcpServer", managers],
      ["evaluateToolPolicy", everyone],
      ["getToolPolicy", everyone],
      ["listExtensionTools", everyone],
      ["listMcpConnections", everyone],
      ["listMcpServers", everyone],
      ["listToolPolicies", everyone],
      ["listTools", everyone],
      ["revokeMcpConnection", managers],
      ["syncConnectionTools", managers],
      ["updateExtensionTool", managers],
      ["updateMcpServer", managers],
      ["updateToolPolicy", managers],
    ]);
  });

  test("lets owners and admins govern data, owners alone erase it; every role reads audit and secrets", () => {
    expectWhoMay([
      ["createImmutableAuditExport", managers],
      ["createTenantDataExport", managers],
      ["createTenantErasure", ["owner"]],
      ["getOrganizationRetentionPolicy", everyone],
      ["listAuditEvents", everyone],
      ["listCredentialReferences", everyone],
      ["listGovernanceOperations", everyone],
      ["listOrganizationAuditEvents", everyone],
      ["updateOrganizationRetentionPolicy", managers],
    ]);
  });

  test("lets owners and admins change model policies and install skills; every role reads them", () => {
    expectWhoMay([
      ["archiveModelPolicy", managers],
      ["createModelPolicy", managers],
      ["installManagedSkill", managers],
      ["listManagedSkillInstallations", everyone],
      ["listManagedSkillSources", everyone],
      ["listModels", everyone],
      ["removeManagedSkillInstallation", managers],
      ["updateModelPolicy", managers],
    ]);
  });

  test("lets every role send agent email and owners and admins administer it", () => {
    expectWhoMay([
      ["approveAgentEmailDraft", managers],
      ["cancelAgentEmailDraft", everyone],
      ["createAgentEmailBinding", everyone],
      ["createAgentEmailDomain", managers],
      ["createAgentEmailDraft", everyone],
      ["createAgentEmailInbox", everyone],
      ["createAgentEmailPlacement", managers],
      ["createAgentEmailSuppression", managers],
      ["createEmailDomain", managers],
      ["createEmailTenant", managers],
      ["deleteAgentEmailBinding", everyone],
      ["forwardAgentEmailMessage", everyone],
      ["getAgentEmailPolicy", everyone],
      ["getAgentEmailUsage", everyone],
      ["listAgentEmailDomains", everyone],
      ["listAgentEmailInboxes", everyone],
      ["listAgentEmailPlacements", everyone],
      ["listAgentEmailSuppressions", everyone],
      ["listEmailTenants", everyone],
      ["refreshAgentEmailDomain", managers],
      ["refreshEmailDomain", managers],
      ["rejectAgentEmailDraft", managers],
      ["removeAgentEmailSuppression", managers],
      ["replyAllToAgentEmailMessage", everyone],
      ["replyToAgentEmailMessage", everyone],
      ["reprocessAgentEmailMessage", managers],
      ["revokeAgentEmailDomain", managers],
      ["revokeEmailDomain", managers],
      ["sendAgentEmailDraft", everyone],
      ["sendAgentEmailMessage", everyone],
      ["sendEmail", everyone],
      ["submitAgentEmailDraft", everyone],
      ["updateAgentEmailDraft", everyone],
      ["updateAgentEmailInbox", everyone],
      ["updateAgentEmailPlacement", managers],
      ["updateAgentEmailPolicy", managers],
      ["updateEmailTenant", managers],
    ]);
  });

  test("lets every role read apps and only owners and admins change them", () => {
    expectWhoMay([
      ["archiveApp", managers],
      ["attachAppDomain", managers],
      ["detachAppDomain", managers],
      ["eraseApp", managers],
      ["listAppDomains", everyone],
      ["listAppGrants", everyone],
      ["listAppReleases", everyone],
      ["listApps", everyone],
      ["promoteAppRelease", managers],
      ["putAppGrant", managers],
      ["refreshAppDomain", managers],
      ["removeAppGrant", managers],
      ["setAppPublication", managers],
      ["updateApp", managers],
    ]);
  });

  test("shows sign-in settings, reads included, only to owners and admins", () => {
    expectWhoMay([
      ["addLoginDomain", managers],
      ["createDirectoryToken", managers],
      ["deleteIdentityProvider", managers],
      ["deleteIdentityProviderLink", managers],
      ["getDirectory", managers],
      ["getIdentityProvider", managers],
      ["listIdentityProviderLinks", managers],
      ["listLoginDomains", managers],
      ["putDirectory", managers],
      ["putIdentityProvider", managers],
      ["removeLoginDomain", managers],
      ["revokeDirectoryToken", managers],
      ["setIdentityProviderState", managers],
      ["verifyLoginDomain", managers],
    ]);
  });

  test("lets every role read memory spaces and policies; owners and admins govern them", () => {
    expectWhoMay([
      ["archiveMemorySpace", managers],
      ["createMemoryPolicy", managers],
      ["createMemorySpace", managers],
      ["createMemorySpaceGrant", managers],
      ["getMemorySpace", everyone],
      ["listMemoryPolicies", everyone],
      ["listMemorySpaceGrants", managers],
      ["listMemorySpaces", everyone],
      ["revokeMemorySpaceGrant", managers],
      ["updateMemorySpaceGrant", managers],
      ["upsertMemoryPolicy", managers],
    ]);
  });

  test("lets every role search memory and read its quality; only owners and admins see contents", () => {
    expectWhoMay([
      ["archiveMemory", managers],
      ["deleteMemory", managers],
      ["exportMemories", managers],
      ["getMemoryQuality", everyone],
      ["importMemories", managers],
      ["listMemories", managers],
      ["listMemoryReviewItems", managers],
      ["recordMemoryRetrievalFeedback", managers],
      ["resolveMemoryReview", managers],
      ["restoreMemory", managers],
      ["searchMemories", everyone],
      ["strategySearchMemories", managers],
    ]);
  });
});
