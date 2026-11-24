import { WorkspaceSpendResponse } from "@deployments-ai/api-contract";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";

import {
  Authentication,
  RequestLifecycle,
  environmentHeaders,
  idParams,
  idempotencyHeaders,
  listQuery,
  mutationErrors,
  operationalQuery,
  operationalSchemas,
  optionalRevokePayload,
  optionalRotatePayload,
  organizationHeaders,
  projectHeaders,
  readErrors,
  schemas,
  usageSummaryQuery,
  workspaceSpendQuery,
} from "./api-service-contracts.ts";
export const TenancyGroup = HttpApiGroup.make("tenancy")
  .add(
    HttpApiEndpoint.get("listOrganizations", "/v1/organizations", {
      query: listQuery,
      success: schemas.ListOrganizationsResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.post("createOrganization", "/v1/organizations", {
      headers: idempotencyHeaders,
      payload: schemas.CreateOrganizationRequest,
      success: schemas.OrganizationResponse.pipe(HttpApiSchema.status(201)),
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("getOrganization", "/v1/organizations/:id", {
      params: idParams,
      headers: organizationHeaders,
      success: schemas.OrganizationResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.patch("updateOrganization", "/v1/organizations/:id", {
      params: idParams,
      headers: { ...organizationHeaders, ...idempotencyHeaders },
      payload: schemas.UpdateOrganizationRequest,
      success: schemas.OrganizationResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("getOrganizationLimits", "/v1/organizations/:id/limits", {
      params: idParams,
      headers: organizationHeaders,
      success: schemas.OrganizationLimitsResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.get("getOrganizationStanding", "/v1/organizations/:id/standing", {
      params: idParams,
      headers: organizationHeaders,
      success: schemas.OrganizationStandingResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.get("listOrganizationMembers", "/v1/members", {
      query: listQuery,
      headers: organizationHeaders,
      success: schemas.ListOrganizationMembersResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.post("addOrganizationMember", "/v1/members", {
      headers: { ...organizationHeaders, ...idempotencyHeaders },
      payload: schemas.AddOrganizationMemberRequest,
      success: schemas.OrganizationMemberResponse.pipe(HttpApiSchema.status(201)),
      error: mutationErrors,
    }),
    HttpApiEndpoint.patch("updateOrganizationMember", "/v1/members/:id", {
      params: idParams,
      headers: { ...organizationHeaders, ...idempotencyHeaders },
      payload: schemas.UpdateOrganizationMemberRequest,
      success: schemas.OrganizationMemberResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.delete("removeOrganizationMember", "/v1/members/:id", {
      params: idParams,
      headers: { ...organizationHeaders, ...idempotencyHeaders },
      payload: optionalRevokePayload,
      success: schemas.OrganizationMemberResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("listOrganizationInvitations", "/v1/invitations", {
      query: listQuery,
      headers: organizationHeaders,
      success: schemas.ListOrganizationInvitationsResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.post("createOrganizationInvitation", "/v1/invitations", {
      headers: { ...organizationHeaders, ...idempotencyHeaders },
      payload: schemas.CreateOrganizationInvitationRequest,
      success: schemas.IssuedOrganizationInvitationResponse.pipe(HttpApiSchema.status(201)),
      error: mutationErrors,
    }),
    HttpApiEndpoint.delete("revokeOrganizationInvitation", "/v1/invitations/:id", {
      params: idParams,
      headers: { ...organizationHeaders, ...idempotencyHeaders },
      payload: optionalRevokePayload,
      success: schemas.OrganizationInvitationResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.post("acceptOrganizationInvitation", "/v1/invitations/:id/accept", {
      params: idParams,
      payload: schemas.AcceptOrganizationInvitationRequest,
      success: schemas.OrganizationMemberResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("listProjects", "/v1/projects", {
      query: listQuery,
      headers: organizationHeaders,
      success: schemas.ListProjectsResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.post("createProject", "/v1/projects", {
      headers: { ...organizationHeaders, ...idempotencyHeaders },
      payload: schemas.CreateProjectRequest,
      success: schemas.ProjectResponse.pipe(HttpApiSchema.status(201)),
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("getProject", "/v1/projects/:id", {
      params: idParams,
      headers: projectHeaders,
      success: schemas.ProjectResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.patch("updateProject", "/v1/projects/:id", {
      params: idParams,
      headers: { ...projectHeaders, ...idempotencyHeaders },
      payload: schemas.UpdateProjectRequest,
      success: schemas.ProjectResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.delete("archiveProject", "/v1/projects/:id", {
      params: idParams,
      headers: { ...projectHeaders, ...idempotencyHeaders },
      payload: optionalRevokePayload,
      success: schemas.ProjectResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("listEnvironments", "/v1/environments", {
      query: listQuery,
      headers: projectHeaders,
      success: schemas.ListEnvironmentsResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.post("createEnvironment", "/v1/environments", {
      headers: { ...projectHeaders, ...idempotencyHeaders },
      payload: schemas.CreateEnvironmentRequest,
      success: schemas.EnvironmentResponse.pipe(HttpApiSchema.status(201)),
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("getEnvironment", "/v1/environments/:id", {
      params: idParams,
      headers: environmentHeaders,
      success: schemas.EnvironmentResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.patch("updateEnvironment", "/v1/environments/:id", {
      params: idParams,
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: schemas.UpdateEnvironmentRequest,
      success: schemas.EnvironmentResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.delete("archiveEnvironment", "/v1/environments/:id", {
      params: idParams,
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: optionalRevokePayload,
      success: schemas.EnvironmentResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("listWorkspaces", "/v1/workspaces", {
      query: listQuery,
      headers: environmentHeaders,
      success: schemas.ListWorkspacesResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.post("createWorkspace", "/v1/workspaces", {
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: schemas.CreateWorkspaceRequest,
      success: schemas.WorkspaceResponse.pipe(HttpApiSchema.status(201)),
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("getWorkspace", "/v1/workspaces/:id", {
      params: idParams,
      headers: environmentHeaders,
      success: schemas.WorkspaceResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.patch("updateWorkspace", "/v1/workspaces/:id", {
      params: idParams,
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: schemas.UpdateWorkspaceRequest,
      success: schemas.WorkspaceResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.delete("archiveWorkspace", "/v1/workspaces/:id", {
      params: idParams,
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: optionalRevokePayload,
      success: schemas.WorkspaceResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("listServiceAccounts", "/v1/service-accounts", {
      query: listQuery,
      headers: environmentHeaders,
      success: schemas.ListServiceAccountsResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.post("createServiceAccount", "/v1/service-accounts", {
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: schemas.CreateServiceAccountRequest,
      success: schemas.ServiceAccountResponse.pipe(HttpApiSchema.status(201)),
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("getServiceAccount", "/v1/service-accounts/:id", {
      params: idParams,
      headers: environmentHeaders,
      success: schemas.ServiceAccountResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.delete("revokeServiceAccount", "/v1/service-accounts/:id", {
      params: idParams,
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: optionalRevokePayload,
      success: schemas.ServiceAccountResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("listApiCredentials", "/v1/api-keys", {
      query: listQuery,
      headers: environmentHeaders,
      success: schemas.ListApiCredentialsResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.post("createApiCredential", "/v1/api-keys", {
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: schemas.CreateApiCredentialRequest,
      success: schemas.IssuedApiCredentialResponse.pipe(HttpApiSchema.status(201)),
      error: mutationErrors,
    }),
    HttpApiEndpoint.post("rotateApiCredential", "/v1/api-keys/:id/rotate", {
      params: idParams,
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: optionalRotatePayload,
      success: schemas.IssuedApiCredentialResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.delete("revokeApiCredential", "/v1/api-keys/:id", {
      params: idParams,
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: optionalRevokePayload,
      success: schemas.ApiCredentialResponse,
      error: mutationErrors,
    }),
  )
  .middleware(Authentication)
  .middleware(RequestLifecycle);

export const AgentsGroup = HttpApiGroup.make("agents")
  .add(
    HttpApiEndpoint.get("listAgentDefinitions", "/v1/agent-definitions", {
      query: listQuery,
      headers: environmentHeaders,
      success: schemas.ListAgentDefinitionsResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.post("createAgentDefinition", "/v1/agent-definitions", {
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: Schema.Unknown,
      success: schemas.AgentDefinitionResponse.pipe(HttpApiSchema.status(201)),
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("getAgentDefinition", "/v1/agent-definitions/:id", {
      params: idParams,
      headers: environmentHeaders,
      success: schemas.AgentDefinitionResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.patch("updateAgentDefinition", "/v1/agent-definitions/:id", {
      params: idParams,
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: Schema.Unknown,
      success: schemas.AgentDefinitionResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.delete("archiveAgentDefinition", "/v1/agent-definitions/:id", {
      params: idParams,
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: schemas.ArchiveAgentResourceRequest,
      success: schemas.AgentDefinitionResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("listAgentReleases", "/v1/agent-definitions/:id/releases", {
      params: idParams,
      query: listQuery,
      headers: environmentHeaders,
      success: schemas.ListAgentReleasesResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.post("publishAgentRelease", "/v1/agent-definitions/:id/releases", {
      params: idParams,
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: schemas.PublishAgentReleaseRequest,
      success: schemas.AgentReleaseResponse.pipe(HttpApiSchema.status(201)),
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("getAgentRelease", "/v1/agent-releases/:id", {
      params: idParams,
      headers: environmentHeaders,
      success: schemas.AgentReleaseResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.post("promoteAgentRelease", "/v1/agent-releases/:id/promote", {
      params: idParams,
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: schemas.PromoteAgentReleaseRequest,
      success: schemas.AgentReleaseResponse.pipe(HttpApiSchema.status(201)),
      error: mutationErrors,
    }),
    HttpApiEndpoint.delete("archiveAgentRelease", "/v1/agent-releases/:id", {
      params: idParams,
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: schemas.ArchiveAgentResourceRequest,
      success: schemas.AgentReleaseResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("listAgentDeployments", "/v1/agent-deployments", {
      query: listQuery,
      headers: environmentHeaders,
      success: schemas.ListAgentDeploymentsResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.post("createAgentDeployment", "/v1/agent-deployments", {
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: schemas.CreateAgentDeploymentRequest,
      success: schemas.AgentDeploymentResponse.pipe(HttpApiSchema.status(201)),
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("getAgentDeployment", "/v1/agent-deployments/:id", {
      params: idParams,
      headers: environmentHeaders,
      success: schemas.AgentDeploymentResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.patch("updateAgentDeployment", "/v1/agent-deployments/:id", {
      params: idParams,
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: schemas.UpdateAgentDeploymentRequest,
      success: schemas.AgentDeploymentResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.delete("stopAgentDeployment", "/v1/agent-deployments/:id", {
      params: idParams,
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: schemas.ArchiveAgentResourceRequest,
      success: schemas.AgentDeploymentResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.post("startAgentDeploymentCanary", "/v1/agent-deployments/:id/canary", {
      params: idParams,
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: schemas.StartAgentDeploymentCanaryRequest,
      success: schemas.AgentDeploymentResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.post(
      "promoteAgentDeploymentCanary",
      "/v1/agent-deployments/:id/canary/promote",
      {
        params: idParams,
        headers: { ...environmentHeaders, ...idempotencyHeaders },
        payload: schemas.ResolveAgentDeploymentCanaryRequest,
        success: schemas.AgentDeploymentResponse,
        error: mutationErrors,
      },
    ),
    HttpApiEndpoint.post("abortAgentDeploymentCanary", "/v1/agent-deployments/:id/canary/abort", {
      params: idParams,
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: schemas.ResolveAgentDeploymentCanaryRequest,
      success: schemas.AgentDeploymentResponse,
      error: mutationErrors,
    }),
  )
  .middleware(Authentication)
  .middleware(RequestLifecycle);

export const OperationsGroup = HttpApiGroup.make("operations")
  .add(
    HttpApiEndpoint.get("listUsageRecords", "/v1/usage", {
      headers: environmentHeaders,
      query: operationalQuery,
      success: operationalSchemas.OperationalRecordPageResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.get("getUsageSummary", "/v1/usage/summary", {
      headers: environmentHeaders,
      query: usageSummaryQuery,
      success: operationalSchemas.UsageSummaryResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.get("listCostRecords", "/v1/costs", {
      headers: environmentHeaders,
      query: operationalQuery,
      success: operationalSchemas.OperationalRecordPageResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.get("getCostSummary", "/v1/costs/summary", {
      headers: environmentHeaders,
      query: usageSummaryQuery,
      success: operationalSchemas.UsageSummaryResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.get("getWorkspaceSpend", "/v1/workspaces/:id/spend", {
      headers: environmentHeaders,
      params: idParams,
      query: workspaceSpendQuery,
      success: WorkspaceSpendResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.get("listSpendRecords", "/v1/spend", {
      headers: environmentHeaders,
      query: operationalQuery,
      success: operationalSchemas.OperationalRecordPageResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.get("listApiCredentialUsage", "/v1/api-key-usage", {
      headers: environmentHeaders,
      query: operationalQuery,
      success: operationalSchemas.OperationalRecordPageResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.get("listAuditEvents", "/v1/audit-events", {
      headers: environmentHeaders,
      query: operationalQuery,
      success: operationalSchemas.AuditEventPageResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.get("getAuditEvent", "/v1/audit-events/:id", {
      headers: environmentHeaders,
      params: idParams,
      success: operationalSchemas.AuditEventResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.get("listOrganizationAuditEvents", "/v1/organizations/:id/audit-events", {
      headers: organizationHeaders,
      params: idParams,
      query: operationalQuery,
      success: operationalSchemas.OrganizationAuditEventPageResponse,
      error: readErrors,
    }),
  )
  .middleware(Authentication)
  .middleware(RequestLifecycle);

export const WorkflowsGroup = HttpApiGroup.make("workflows")
  .add(
    HttpApiEndpoint.get("listWorkflowDefinitions", "/v1/workflow-definitions", {
      query: listQuery,
      headers: environmentHeaders,
      success: schemas.ListWorkflowDefinitionsResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.post("createWorkflowDefinition", "/v1/workflow-definitions", {
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: Schema.Unknown,
      success: schemas.WorkflowDefinitionResponse.pipe(HttpApiSchema.status(201)),
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("getWorkflowDefinition", "/v1/workflow-definitions/:id", {
      params: idParams,
      headers: environmentHeaders,
      success: schemas.WorkflowDefinitionResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.patch("updateWorkflowDefinition", "/v1/workflow-definitions/:id", {
      params: idParams,
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: Schema.Unknown,
      success: schemas.WorkflowDefinitionResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.delete("archiveWorkflowDefinition", "/v1/workflow-definitions/:id", {
      params: idParams,
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: schemas.ArchiveWorkflowResourceRequest,
      success: schemas.WorkflowDefinitionResponse,
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("listWorkflowReleases", "/v1/workflow-definitions/:id/releases", {
      params: idParams,
      query: listQuery,
      headers: environmentHeaders,
      success: schemas.ListWorkflowReleasesResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.post("publishWorkflowRelease", "/v1/workflow-definitions/:id/releases", {
      params: idParams,
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: schemas.PublishWorkflowReleaseRequest,
      success: schemas.WorkflowReleaseResponse.pipe(HttpApiSchema.status(201)),
      error: mutationErrors,
    }),
    HttpApiEndpoint.get("getWorkflowRelease", "/v1/workflow-releases/:id", {
      params: idParams,
      headers: environmentHeaders,
      success: schemas.WorkflowReleaseResponse,
      error: readErrors,
    }),
    HttpApiEndpoint.delete("archiveWorkflowRelease", "/v1/workflow-releases/:id", {
      params: idParams,
      headers: { ...environmentHeaders, ...idempotencyHeaders },
      payload: schemas.ArchiveWorkflowResourceRequest,
      success: schemas.WorkflowReleaseResponse,
      error: mutationErrors,
    }),
  )
  .middleware(Authentication)
  .middleware(RequestLifecycle);
