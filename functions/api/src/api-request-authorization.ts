import { type ApiContextScope, type TenancyRouteName } from "@deployments-ai/api-contract";
import { PersistenceError } from "@deployments-ai/db";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { DeviceAuthorizationError } from "./device-authorization.ts";
import { OperationalReadError } from "./operational-read-input.ts";
import { errorLogFields } from "./error-log-fields.ts";
import { persistenceStatus } from "./persistence-error-status.ts";

import { AgentsGroup, OperationsGroup, TenancyGroup, WorkflowsGroup } from "./api-route-groups.ts";
import {
  ApiProblem,
  Authentication,
  DeviceAuthorizationGroup,
  RequestLifecycle,
  SecurityGroup,
  SystemGroup,
  environmentHeaders,
  idParams,
  idempotencyHeaders,
  listQuery,
  mutationErrors,
  readErrors,
  schemas,
  type ApiIdentity,
  type ApiInvocation,
} from "./api-service-contracts.ts";
export const ManagedSkillsGroup = HttpApiGroup.make("managedSkills")
  .add(
    HttpApiEndpoint.get("listManagedSkillSources", "/v1/managed-skill-sources", {
      query: listQuery,
      success: schemas.ListManagedSkillSourcesResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.post("createManagedSkillSource", "/v1/managed-skill-sources", {
      headers: idempotencyHeaders,
      payload: schemas.CreateManagedSkillSourceRequest,
      success: schemas.ManagedSkillSourceResponse.pipe(HttpApiSchema.status(201)),
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("getManagedSkillSource", "/v1/managed-skill-sources/:id", {
      params: idParams,
      success: schemas.ManagedSkillSourceResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.patch("updateManagedSkillSource", "/v1/managed-skill-sources/:id", {
      params: idParams,
      headers: idempotencyHeaders,
      payload: schemas.UpdateManagedSkillSourceRequest,
      success: schemas.ManagedSkillSourceResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.delete("archiveManagedSkillSource", "/v1/managed-skill-sources/:id", {
      params: idParams,
      headers: idempotencyHeaders,
      payload: schemas.ArchiveManagedSkillResourceRequest,
      success: schemas.ManagedSkillSourceResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("listManagedSkillReleases", "/v1/managed-skill-sources/:id/releases", {
      params: idParams,
      query: listQuery,
      success: schemas.ListManagedSkillReleasesResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.post("publishManagedSkillRelease", "/v1/managed-skill-sources/:id/releases", {
      params: idParams,
      headers: idempotencyHeaders,
      payload: schemas.PublishManagedSkillReleaseRequest,
      success: schemas.ManagedSkillReleaseResponse.pipe(HttpApiSchema.status(201)),
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("getManagedSkillRelease", "/v1/managed-skill-releases/:id", {
      params: idParams,
      success: schemas.ManagedSkillReleaseResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.delete("archiveManagedSkillRelease", "/v1/managed-skill-releases/:id", {
      params: idParams,
      headers: idempotencyHeaders,
      payload: schemas.ArchiveManagedSkillResourceRequest,
      success: schemas.ManagedSkillReleaseResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("listManagedSkills", "/v1/managed-skill-releases/:id/skills", {
      params: idParams,
      query: listQuery,
      success: schemas.ListManagedSkillsResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.get("getManagedSkill", "/v1/managed-skills/:id", {
      params: idParams,
      success: schemas.ManagedSkillResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.get("listManagedSkillInstallations", "/v1/managed-skill-installations", {
      query: listQuery,
      headers: environmentHeaders,
      success: schemas.ListManagedSkillInstallationsResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.post("installManagedSkill", "/v1/managed-skill-installations", {
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: schemas.InstallManagedSkillRequest,
      success: schemas.ManagedSkillInstallationResponse.pipe(HttpApiSchema.status(201)),
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("getManagedSkillInstallation", "/v1/managed-skill-installations/:id", {
      params: idParams,
      headers: environmentHeaders,
      success: schemas.ManagedSkillInstallationResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.delete(
      "removeManagedSkillInstallation",
      "/v1/managed-skill-installations/:id",
      {
        params: idParams,
        headers: { ...environmentHeaders, ...idempotencyHeaders },
        payload: schemas.ArchiveManagedSkillResourceRequest,
        success: schemas.ManagedSkillInstallationResponse,
        error: mutationErrors,
      },
    ),
  )
  .middleware(Authentication)
  .middleware(RequestLifecycle);

export const TenancyHttpApi = HttpApi.make("deployments-ai-api").add(
  SystemGroup,
  DeviceAuthorizationGroup,
  SecurityGroup,
  TenancyGroup,
  AgentsGroup,
  OperationsGroup,
  WorkflowsGroup,
  ManagedSkillsGroup,
);

export const capabilities: Readonly<Record<TenancyRouteName, string>> = {
  listAgentDefinitions: "agents:read",
  createAgentDefinition: "agents:write",
  getAgentDefinition: "agents:read",
  updateAgentDefinition: "agents:write",
  archiveAgentDefinition: "agents:write",
  listAgentReleases: "agents:read",
  publishAgentRelease: "agents:write",
  getAgentRelease: "agents:read",
  archiveAgentRelease: "agents:write",
  promoteAgentRelease: "agents:write",
  listAgentDeployments: "agents:read",
  createAgentDeployment: "agents:write",
  getAgentDeployment: "agents:read",
  updateAgentDeployment: "agents:write",
  stopAgentDeployment: "agents:write",
  startAgentDeploymentCanary: "agents:write",
  promoteAgentDeploymentCanary: "agents:write",
  abortAgentDeploymentCanary: "agents:write",
  listWorkflowDefinitions: "workflows:read",
  createWorkflowDefinition: "workflows:write",
  getWorkflowDefinition: "workflows:read",
  updateWorkflowDefinition: "workflows:write",
  archiveWorkflowDefinition: "workflows:write",
  listWorkflowReleases: "workflows:read",
  publishWorkflowRelease: "workflows:write",
  getWorkflowRelease: "workflows:read",
  archiveWorkflowRelease: "workflows:write",
  listManagedSkillSources: "managed-skills:read",
  createManagedSkillSource: "managed-skills:admin",
  getManagedSkillSource: "managed-skills:read",
  updateManagedSkillSource: "managed-skills:admin",
  archiveManagedSkillSource: "managed-skills:admin",
  listManagedSkillReleases: "managed-skills:read",
  publishManagedSkillRelease: "managed-skills:admin",
  getManagedSkillRelease: "managed-skills:read",
  archiveManagedSkillRelease: "managed-skills:admin",
  listManagedSkills: "managed-skills:read",
  getManagedSkill: "managed-skills:read",
  listManagedSkillInstallations: "managed-skills:read",
  installManagedSkill: "managed-skills:install",
  getManagedSkillInstallation: "managed-skills:read",
  removeManagedSkillInstallation: "managed-skills:install",
  listOrganizations: "organizations:read",
  createOrganization: "organizations:write",
  getOrganization: "organizations:read",
  updateOrganization: "organizations:write",
  getOrganizationLimits: "organizations:read",
  getOrganizationStanding: "organizations:read",
  listOrganizationMembers: "members:read",
  addOrganizationMember: "members:write",
  updateOrganizationMember: "members:write",
  removeOrganizationMember: "members:write",
  listOrganizationInvitations: "invitations:read",
  createOrganizationInvitation: "invitations:write",
  revokeOrganizationInvitation: "invitations:write",
  acceptOrganizationInvitation: "invitations:accept",
  listProjects: "projects:read",
  createProject: "projects:write",
  getProject: "projects:read",
  updateProject: "projects:write",
  archiveProject: "projects:write",
  listEnvironments: "environments:read",
  createEnvironment: "environments:write",
  getEnvironment: "environments:read",
  updateEnvironment: "environments:write",
  archiveEnvironment: "environments:write",
  listWorkspaces: "workspaces:read",
  createWorkspace: "workspaces:write",
  getWorkspace: "workspaces:read",
  updateWorkspace: "workspaces:write",
  archiveWorkspace: "workspaces:write",
  listServiceAccounts: "service-accounts:read",
  createServiceAccount: "service-accounts:write",
  getServiceAccount: "service-accounts:read",
  revokeServiceAccount: "service-accounts:write",
  listApiCredentials: "api-keys:read",
  createApiCredential: "api-keys:write",
  rotateApiCredential: "api-keys:write",
  revokeApiCredential: "api-keys:write",
};

export function scopeHeader(scope: ApiContextScope) {
  if (scope === "organization") return ["x-deployments-organization", "organizationId"] as const;
  if (scope === "project") return ["x-deployments-project", "projectId"] as const;
  if (scope === "environment") return ["x-deployments-environment", "environmentId"] as const;
  return undefined;
}

export function assertScope(
  identity: ApiIdentity,
  scope: ApiContextScope,
  value: string | undefined,
  allowMissingGrant: boolean,
) {
  if (scope === "none") return;
  if (!value) throw new ApiProblem(400, "missing_scope", `The ${scope} scope header is required.`);
  const allowed =
    scope === "organization"
      ? identity.organizationIds
      : scope === "project"
        ? identity.projectIds
        : identity.environmentIds;
  if (allowed === undefined && allowMissingGrant) return;
  if (allowed !== "*" && !allowed?.includes(value)) {
    throw new ApiProblem(
      403,
      `${scope}_scope_violation`,
      `The credential cannot access the requested ${scope}.`,
    );
  }
}

export function idempotencyOwner(
  identity: ApiIdentity,
  scope: ApiInvocation["scope"],
  contextScope: ApiContextScope,
  agentRoute: boolean,
): { readonly organizationId?: string } {
  if (contextScope === "organization") {
    return scope.organizationId ? { organizationId: scope.organizationId } : {};
  }
  if (!agentRoute) return {};
  // Agent idempotency remains in the deployed organization partition. JWT authentication
  // resolves a concrete environment grant back to its organization before routing.
  if (identity.organizationIds !== "*" && identity.organizationIds?.length === 1) {
    return { organizationId: identity.organizationIds[0]! };
  }
  if (identity.organizationIds !== "*") {
    throw new ApiProblem(
      403,
      "ambiguous_tenant_scope",
      "The authenticated identity must resolve exactly one organization.",
    );
  }
  return {};
}

export function resultOrganizationId(routeName: TenancyRouteName, result: unknown) {
  if (!result || typeof result !== "object") return undefined;
  const response = result as Readonly<Record<string, unknown>>;
  if (typeof response.organizationId === "string") return response.organizationId;
  return routeName === "createOrganization" && typeof response.id === "string"
    ? response.id
    : undefined;
}

export async function requestBody(request: Request, optional: boolean) {
  const text = await request.text();
  if (!text && optional) return undefined;
  if (!text) throw new ApiProblem(400, "invalid_request", "A JSON request body is required.");
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiProblem(400, "invalid_json", "The request body must be valid JSON.");
  }
}

export function problem(cause: unknown, requestId: string) {
  const api =
    cause instanceof ApiProblem
      ? cause
      : cause instanceof OperationalReadError
        ? new ApiProblem(cause.status, cause.code, cause.message)
        : cause instanceof DeviceAuthorizationError
          ? new ApiProblem(cause.status, cause.code, cause.message)
          : cause instanceof PersistenceError
            ? new ApiProblem(persistenceStatus(cause), cause.code, cause.message)
            : undefined;
  const validation =
    !api &&
    cause instanceof Error &&
    (cause.name.includes("ParseError") ||
      cause.name.includes("SchemaError") ||
      cause.name.includes("HttpApiSchemaError") ||
      "issue" in cause);
  const status = api?.status ?? (validation ? 422 : 500);
  const code = api?.code ?? (validation ? "validation_failed" : "internal_error");
  if (status === 500) {
    console.error("Platform API request failed.", { ...errorLogFields(cause), requestId });
  }
  return HttpServerResponse.jsonUnsafe(
    {
      type: `https://docs.deployments.ai/errors/${code.replaceAll("_", "-")}`,
      title:
        status === 500
          ? "Internal server error"
          : cause instanceof Error
            ? cause.message
            : "Request failed",
      status,
      code,
      requestId,
    },
    {
      status,
      contentType: "application/problem+json",
      headers: { "x-request-id": requestId },
    },
  );
}

export function webRequest(request: HttpServerRequest.HttpServerRequest): Request {
  if (!(request.source instanceof Request)) {
    throw new ApiProblem(500, "internal_error", "The API requires a Fetch-compatible request.");
  }
  return request.source;
}

export interface RawEndpointInput {
  readonly params?: { readonly id?: string };
  readonly request: HttpServerRequest.HttpServerRequest;
}
