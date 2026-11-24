import { IdempotencyKey, ListQuery, ProblemDetails } from "./primitives.ts";
import {
  AgentDefinitionResponse,
  AgentDefinitionSummaryResponse,
  AgentDeploymentResponse,
  AgentReleaseResponse,
  AgentReleaseSummaryResponse,
  ArchiveAgentResourceRequest,
  CreateAgentDefinitionRequest,
  CreateAgentDeploymentRequest,
  ListAgentDefinitionsResponse,
  ListAgentDeploymentsResponse,
  ListAgentReleasesResponse,
  PromoteAgentReleaseRequest,
  PublishAgentReleaseRequest,
  ResolveAgentDeploymentCanaryRequest,
  StartAgentDeploymentCanaryRequest,
  UpdateAgentDefinitionRequest,
  UpdateAgentDeploymentRequest,
} from "./agents.ts";
import {
  AcceptOrganizationInvitationRequest,
  AddOrganizationMemberRequest,
  ApiCredentialResponse,
  CreateApiCredentialRequest,
  CreateEnvironmentRequest,
  CreateOrganizationRequest,
  CreateOrganizationInvitationRequest,
  CreateProjectRequest,
  CreateServiceAccountRequest,
  CreateWorkspaceRequest,
  EnvironmentResponse,
  IssuedApiCredentialResponse,
  IssuedOrganizationInvitationResponse,
  ListApiCredentialsResponse,
  ListEnvironmentsResponse,
  ListOrganizationsResponse,
  ListOrganizationInvitationsResponse,
  ListOrganizationMembersResponse,
  ListProjectsResponse,
  ListServiceAccountsResponse,
  ListWorkspacesResponse,
  OrganizationInvitationResponse,
  OrganizationMemberResponse,
  OrganizationResponse,
  ProjectResponse,
  RevokeResourceRequest,
  RotateApiCredentialRequest,
  ServiceAccountResponse,
  UpdateEnvironmentRequest,
  UpdateOrganizationRequest,
  UpdateOrganizationMemberRequest,
  UpdateProjectRequest,
  UpdateWorkspaceRequest,
  WorkspaceResponse,
} from "./tenancy.ts";
import { MEMORY_API_SCHEMAS } from "./memory.ts";
import { BRAIN_API_SCHEMAS } from "./brains.ts";
import { GOVERNANCE_API_SCHEMAS } from "./governance.ts";
import { IDENTITY_API_SCHEMAS } from "./identity.ts";
import { OPERATIONS_API_SCHEMAS } from "./operations.ts";
import { OBSERVABILITY_API_SCHEMAS } from "./observability.ts";
import { EVALUATION_API_SCHEMAS } from "./evaluations.ts";
import { PROVIDER_API_SCHEMAS } from "./providers.ts";
import { RUNTIME_API_SCHEMAS } from "./runtime.ts";
import { SYSTEM_API_SCHEMAS } from "./system.ts";
import { AGENT_EMAIL_API_SCHEMAS } from "./agent-email.ts";
import { EMAIL_API_SCHEMAS } from "./email.ts";
import {
  ArchiveManagedSkillResourceRequest,
  CreateManagedSkillSourceRequest,
  InstallManagedSkillRequest,
  ListManagedSkillInstallationsResponse,
  ListManagedSkillReleasesResponse,
  ListManagedSkillSourcesResponse,
  ListManagedSkillsResponse,
  ManagedSkillInstallationResponse,
  ManagedSkillReleaseResponse,
  ManagedSkillResponse,
  ManagedSkillSourceResponse,
  PublishManagedSkillReleaseRequest,
  UpdateManagedSkillSourceRequest,
} from "./managed-skills.ts";
import {
  ArchiveWorkflowResourceRequest,
  CreateWorkflowDefinitionRequest,
  ListWorkflowDefinitionsResponse,
  ListWorkflowReleasesResponse,
  PublishWorkflowReleaseRequest,
  UpdateWorkflowDefinitionRequest,
  WorkflowDefinitionResponse,
  WorkflowDefinitionSummaryResponse,
  WorkflowReleaseResponse,
  WorkflowReleaseSummaryResponse,
} from "./workflows.ts";
import { TOOLING_API_SCHEMAS } from "./tooling.ts";
import { BUDGET_API_SCHEMAS } from "./budgets.ts";
import { MONITOR_API_SCHEMAS } from "./monitors.ts";
import { CREDENTIAL_REFERENCE_API_SCHEMAS } from "./credential-references.ts";
import { TOOL_CATALOG_API_SCHEMAS } from "./tool-catalog.ts";
import {
  OrganizationStandingResponse,
  OrganizationSuspendedProblem,
} from "./organization-standing.ts";
import { OrganizationLimitsResponse } from "./tenant-limits.ts";
import { FeatureNotInPlanProblem } from "./plan-features.ts";
import { MODEL_API_SCHEMAS } from "./model-schemas.ts";
import { MODEL_CREDENTIAL_API_SCHEMAS } from "./model-credentials.ts";
import { EGRESS_ALLOWLIST_API_SCHEMAS } from "./egress-allowlist.ts";
import { ORGANIZATION_SPEND_API_SCHEMAS } from "./organization-spend.ts";
import { WORKSPACE_SPEND_API_SCHEMAS } from "./workspace-spend.ts";
import { IDENTITY_FEDERATION_API_SCHEMAS } from "./identity-federation.ts";
import { DIRECTORY_API_SCHEMAS } from "./directory.ts";
import { APPS_API_SCHEMAS } from "./apps-schemas.ts";

export const TENANCY_API_SCHEMAS = {
  AcceptOrganizationInvitationRequest,
  AddOrganizationMemberRequest,
  AgentDefinitionResponse,
  AgentDefinitionSummaryResponse,
  AgentDeploymentResponse,
  AgentReleaseResponse,
  AgentReleaseSummaryResponse,
  ArchiveManagedSkillResourceRequest,
  ArchiveAgentResourceRequest,
  ArchiveWorkflowResourceRequest,
  ApiCredentialResponse,
  CreateAgentDefinitionRequest,
  CreateAgentDeploymentRequest,
  CreateApiCredentialRequest,
  CreateEnvironmentRequest,
  CreateManagedSkillSourceRequest,
  CreateOrganizationRequest,
  CreateOrganizationInvitationRequest,
  CreateProjectRequest,
  CreateServiceAccountRequest,
  CreateWorkspaceRequest,
  CreateWorkflowDefinitionRequest,
  EnvironmentResponse,
  IdempotencyKey,
  IssuedApiCredentialResponse,
  IssuedOrganizationInvitationResponse,
  InstallManagedSkillRequest,
  ListApiCredentialsResponse,
  ListAgentDefinitionsResponse,
  ListAgentDeploymentsResponse,
  ListAgentReleasesResponse,
  ListEnvironmentsResponse,
  ListOrganizationsResponse,
  ListManagedSkillInstallationsResponse,
  ListManagedSkillReleasesResponse,
  ListManagedSkillSourcesResponse,
  ListManagedSkillsResponse,
  ListOrganizationInvitationsResponse,
  ListOrganizationMembersResponse,
  ListProjectsResponse,
  ListQuery,
  ListServiceAccountsResponse,
  ListWorkflowDefinitionsResponse,
  ListWorkflowReleasesResponse,
  ListWorkspacesResponse,
  ManagedSkillInstallationResponse,
  ManagedSkillReleaseResponse,
  ManagedSkillResponse,
  ManagedSkillSourceResponse,
  OrganizationInvitationResponse,
  OrganizationMemberResponse,
  OrganizationLimitsResponse,
  OrganizationResponse,
  OrganizationStandingResponse,
  OrganizationSuspendedProblem,
  FeatureNotInPlanProblem,
  ProblemDetails,
  ProjectResponse,
  PublishAgentReleaseRequest,
  PublishManagedSkillReleaseRequest,
  PublishWorkflowReleaseRequest,
  RevokeResourceRequest,
  RotateApiCredentialRequest,
  ServiceAccountResponse,
  UpdateEnvironmentRequest,
  UpdateAgentDefinitionRequest,
  UpdateAgentDeploymentRequest,
  StartAgentDeploymentCanaryRequest,
  ResolveAgentDeploymentCanaryRequest,
  PromoteAgentReleaseRequest,
  UpdateManagedSkillSourceRequest,
  UpdateOrganizationRequest,
  UpdateOrganizationMemberRequest,
  UpdateProjectRequest,
  UpdateWorkspaceRequest,
  WorkspaceResponse,
  UpdateWorkflowDefinitionRequest,
  WorkflowDefinitionResponse,
  WorkflowDefinitionSummaryResponse,
  WorkflowReleaseResponse,
  WorkflowReleaseSummaryResponse,
} as const;

export type TenancyApiSchemaName = keyof typeof TENANCY_API_SCHEMAS;

export const PUBLIC_API_SCHEMAS = {
  ...TENANCY_API_SCHEMAS,
  ...IDENTITY_API_SCHEMAS,
  ...IDENTITY_FEDERATION_API_SCHEMAS,
  ...DIRECTORY_API_SCHEMAS,
  ...AGENT_EMAIL_API_SCHEMAS,
  ...EMAIL_API_SCHEMAS,
  ...APPS_API_SCHEMAS,
  ...RUNTIME_API_SCHEMAS,
  ...MEMORY_API_SCHEMAS,
  ...BRAIN_API_SCHEMAS,
  ...OPERATIONS_API_SCHEMAS,
  ...OBSERVABILITY_API_SCHEMAS,
  ...EVALUATION_API_SCHEMAS,
  ...GOVERNANCE_API_SCHEMAS,
  ...SYSTEM_API_SCHEMAS,
  ...PROVIDER_API_SCHEMAS,
  ...TOOLING_API_SCHEMAS,
  ...CREDENTIAL_REFERENCE_API_SCHEMAS,
  ...BUDGET_API_SCHEMAS,
  ...MONITOR_API_SCHEMAS,
  ...TOOL_CATALOG_API_SCHEMAS,
  ...MODEL_API_SCHEMAS,
  ...MODEL_CREDENTIAL_API_SCHEMAS,
  ...EGRESS_ALLOWLIST_API_SCHEMAS,
  ...ORGANIZATION_SPEND_API_SCHEMAS,
  ...WORKSPACE_SPEND_API_SCHEMAS,
} as const;

export type PublicApiSchemaName = keyof typeof PUBLIC_API_SCHEMAS;
