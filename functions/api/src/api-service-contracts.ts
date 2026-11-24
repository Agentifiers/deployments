import {
  IDENTITY_API_SCHEMAS,
  OPERATIONS_API_SCHEMAS,
  PublicId,
  TENANCY_API_ROUTES,
  TENANCY_API_SCHEMAS,
  type AcceptOrganizationInvitationRequest,
  type AddOrganizationMemberRequest,
  type AgentDefinitionResponse,
  type AgentDeploymentResponse,
  type AgentReleaseResponse,
  type ApiCredentialResponse,
  type ArchiveAgentResourceRequest,
  type ArchiveManagedSkillResourceRequest,
  type ArchiveWorkflowResourceRequest,
  type CreateAgentDefinitionRequest,
  type CreateAgentDeploymentRequest,
  type CreateApiCredentialRequest,
  type CreateEnvironmentRequest,
  type CreateManagedSkillSourceRequest,
  type CreateOrganizationInvitationRequest,
  type CreateOrganizationRequest,
  type CreateProjectRequest,
  type CreateServiceAccountRequest,
  type CreateWorkflowDefinitionRequest,
  type CreateWorkspaceRequest,
  type EnvironmentResponse,
  type InstallManagedSkillRequest,
  type IssuedApiCredentialResponse,
  type IssuedOrganizationInvitationResponse,
  type ManagedSkillInstallationResponse,
  type ManagedSkillReleaseResponse,
  type ManagedSkillResponse,
  type ManagedSkillSourceResponse,
  type OrganizationInvitationResponse,
  type OrganizationMemberResponse,
  type OrganizationResponse,
  type OrganizationRole,
  type ProjectResponse,
  type PromoteAgentReleaseRequest,
  type PublishAgentReleaseRequest,
  type PublicOpenApiSpec,
  type ResolveAgentDeploymentCanaryRequest,
  type StartAgentDeploymentCanaryRequest,
  type PublishManagedSkillReleaseRequest,
  type PublishWorkflowReleaseRequest,
  type RevokeResourceRequest,
  type RotateApiCredentialRequest,
  type ServiceAccountResponse,
  type UpdateAgentDefinitionRequest,
  type UpdateAgentDeploymentRequest,
  type UpdateEnvironmentRequest,
  type UpdateManagedSkillSourceRequest,
  type UpdateOrganizationMemberRequest,
  type UpdateOrganizationRequest,
  type UpdateProjectRequest,
  type UpdateWorkflowDefinitionRequest,
  type UpdateWorkspaceRequest,
  type WorkflowDefinitionResponse,
  type WorkflowReleaseResponse,
  type WorkspaceResponse,
} from "@deployments-ai/api-contract";
import {
  type ApiCredentialUsageRecorder,
  type IdempotencyPersistence,
  type OperatorAccessGrant,
  type Ulid,
} from "@deployments-ai/db";
import { Context, Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "effect/unstable/httpapi";
import { type DeviceAuthorizationService } from "./device-authorization.ts";
import { type OperationalReadService } from "./operational-reads.ts";

export * from "./administration-api.ts";
export { makeAdministrationPersistence } from "./administration-persistence.ts";
export type {
  AdministrationCredentialIdentity,
  AdministrationCredentialPort,
  AdministrationEnvironment,
  AdministrationMcpDiscoveryPort,
  AdministrationPersistenceDependencies,
  AdministrationPreparedCredentialMutation,
} from "./administration-persistence.ts";
export * from "./agent-api.ts";
export * from "./application-auth.ts";
export * from "./control-resource-api.ts";
export * from "./device-authorization.ts";
export * from "./governance-api.ts";
export * from "./lambda.ts";
export * from "./operational-reads.ts";
export * from "./provider-verification.ts";
export * from "./tenancy-persistence-adapter.ts";

export interface ApiIdentity {
  readonly apiCredentialId?: string;
  readonly authentication?: "api-credential" | "tenant-jwt";
  /** Set when the caller's token carries a signed `email_verified: true` claim. */
  readonly emailVerified?: true;
  readonly erasureReceiptOnly?: true;
  readonly opaqueCredential?: true;
  /**
   * Set when a platform administrator without membership was admitted to the selected
   * organization under an open operator access grant; tenant audit records carry it.
   */
  readonly operatorAccess?: OperatorAccessGrant;
  /** The caller's live organization role, set when a human request selected one organization. */
  readonly organizationRole?: OrganizationRole;
  readonly platformRole?: "administrator";
  readonly principalId: string;
  readonly scopes: readonly string[];
  readonly organizationIds?: readonly string[] | "*";
  readonly projectIds?: readonly string[] | "*";
  readonly environmentIds?: readonly string[] | "*";
  /** Set when a tenant JWT without an environment claim selected `environmentIds` by request header. */
  readonly environmentSelection?: "request";
  readonly tokenSessionId?: Ulid;
  readonly workspaceId?: string;
}

export interface ApiInvocation<Body = unknown> {
  readonly body: Body;
  readonly id?: string;
  readonly identity: ApiIdentity;
  readonly idempotencyKey?: string;
  readonly query: { readonly cursor?: string; readonly limit?: number };
  readonly scope: {
    readonly organizationId?: string;
    readonly projectId?: string;
    readonly environmentId?: string;
  };
}

export type ListOrganizationsResponse = typeof schemas.ListOrganizationsResponse.Type;
export type ListOrganizationMembersResponse = typeof schemas.ListOrganizationMembersResponse.Type;
export type ListOrganizationInvitationsResponse =
  typeof schemas.ListOrganizationInvitationsResponse.Type;
export type ListProjectsResponse = typeof schemas.ListProjectsResponse.Type;
export type ListEnvironmentsResponse = typeof schemas.ListEnvironmentsResponse.Type;
export type ListServiceAccountsResponse = typeof schemas.ListServiceAccountsResponse.Type;
export type ListApiCredentialsResponse = typeof schemas.ListApiCredentialsResponse.Type;
export type ListWorkspacesResponse = typeof schemas.ListWorkspacesResponse.Type;
export type ListAgentDefinitionsResponse = typeof schemas.ListAgentDefinitionsResponse.Type;
export type ListAgentDeploymentsResponse = typeof schemas.ListAgentDeploymentsResponse.Type;
export type ListAgentReleasesResponse = typeof schemas.ListAgentReleasesResponse.Type;
export type ListWorkflowDefinitionsResponse = typeof schemas.ListWorkflowDefinitionsResponse.Type;
export type ListWorkflowReleasesResponse = typeof schemas.ListWorkflowReleasesResponse.Type;
export type ListManagedSkillSourcesResponse = typeof schemas.ListManagedSkillSourcesResponse.Type;
export type ListManagedSkillReleasesResponse = typeof schemas.ListManagedSkillReleasesResponse.Type;
export type ListManagedSkillsResponse = typeof schemas.ListManagedSkillsResponse.Type;
export type ListManagedSkillInstallationsResponse =
  typeof schemas.ListManagedSkillInstallationsResponse.Type;

export interface OrganizationApiService {
  readonly list: (invocation: ApiInvocation<undefined>) => Promise<ListOrganizationsResponse>;
  readonly create: (
    invocation: ApiInvocation<CreateOrganizationRequest>,
  ) => Promise<OrganizationResponse>;
  readonly get: (invocation: ApiInvocation<undefined>) => Promise<OrganizationResponse>;
  readonly update: (
    invocation: ApiInvocation<UpdateOrganizationRequest>,
  ) => Promise<OrganizationResponse>;
}

export type OrganizationLimitsResponse = typeof schemas.OrganizationLimitsResponse.Type;

export interface OrganizationLimitsApiService {
  readonly get: (invocation: ApiInvocation<undefined>) => Promise<OrganizationLimitsResponse>;
}

export type OrganizationStandingResponse = typeof schemas.OrganizationStandingResponse.Type;

export interface OrganizationStandingApiService {
  readonly get: (invocation: ApiInvocation<undefined>) => Promise<OrganizationStandingResponse>;
}

export interface OrganizationMemberApiService {
  readonly list: (invocation: ApiInvocation<undefined>) => Promise<ListOrganizationMembersResponse>;
  readonly add: (
    invocation: ApiInvocation<AddOrganizationMemberRequest>,
  ) => Promise<OrganizationMemberResponse>;
  readonly update: (
    invocation: ApiInvocation<UpdateOrganizationMemberRequest>,
  ) => Promise<OrganizationMemberResponse>;
  readonly remove: (
    invocation: ApiInvocation<RevokeResourceRequest>,
  ) => Promise<OrganizationMemberResponse>;
}

export interface OrganizationInvitationApiService {
  readonly list: (
    invocation: ApiInvocation<undefined>,
  ) => Promise<ListOrganizationInvitationsResponse>;
  readonly create: (
    invocation: ApiInvocation<CreateOrganizationInvitationRequest>,
  ) => Promise<IssuedOrganizationInvitationResponse>;
  readonly revoke: (
    invocation: ApiInvocation<RevokeResourceRequest>,
  ) => Promise<OrganizationInvitationResponse>;
  readonly accept: (
    invocation: ApiInvocation<AcceptOrganizationInvitationRequest>,
  ) => Promise<OrganizationMemberResponse>;
}

export interface ProjectApiService {
  readonly list: (invocation: ApiInvocation<undefined>) => Promise<ListProjectsResponse>;
  readonly create: (invocation: ApiInvocation<CreateProjectRequest>) => Promise<ProjectResponse>;
  readonly get: (invocation: ApiInvocation<undefined>) => Promise<ProjectResponse>;
  readonly update: (invocation: ApiInvocation<UpdateProjectRequest>) => Promise<ProjectResponse>;
  readonly archive: (invocation: ApiInvocation<RevokeResourceRequest>) => Promise<ProjectResponse>;
}

export interface EnvironmentApiService {
  readonly list: (invocation: ApiInvocation<undefined>) => Promise<ListEnvironmentsResponse>;
  readonly create: (
    invocation: ApiInvocation<CreateEnvironmentRequest>,
  ) => Promise<EnvironmentResponse>;
  readonly get: (invocation: ApiInvocation<undefined>) => Promise<EnvironmentResponse>;
  readonly update: (
    invocation: ApiInvocation<UpdateEnvironmentRequest>,
  ) => Promise<EnvironmentResponse>;
  readonly archive: (
    invocation: ApiInvocation<RevokeResourceRequest>,
  ) => Promise<EnvironmentResponse>;
}

export interface WorkspaceApiService {
  readonly list: (invocation: ApiInvocation<undefined>) => Promise<ListWorkspacesResponse>;
  readonly create: (
    invocation: ApiInvocation<CreateWorkspaceRequest>,
  ) => Promise<WorkspaceResponse>;
  readonly get: (invocation: ApiInvocation<undefined>) => Promise<WorkspaceResponse>;
  readonly update: (
    invocation: ApiInvocation<UpdateWorkspaceRequest>,
  ) => Promise<WorkspaceResponse>;
  readonly archive: (
    invocation: ApiInvocation<RevokeResourceRequest>,
  ) => Promise<WorkspaceResponse>;
}

export interface ServiceAccountApiService {
  readonly list: (invocation: ApiInvocation<undefined>) => Promise<ListServiceAccountsResponse>;
  readonly create: (
    invocation: ApiInvocation<CreateServiceAccountRequest>,
  ) => Promise<ServiceAccountResponse>;
  readonly get: (invocation: ApiInvocation<undefined>) => Promise<ServiceAccountResponse>;
  readonly revoke: (
    invocation: ApiInvocation<RevokeResourceRequest>,
  ) => Promise<ServiceAccountResponse>;
}

export interface ApiCredentialApiService {
  readonly list: (invocation: ApiInvocation<undefined>) => Promise<ListApiCredentialsResponse>;
  readonly create: (
    invocation: ApiInvocation<CreateApiCredentialRequest>,
  ) => Promise<IssuedApiCredentialResponse>;
  readonly rotate: (
    invocation: ApiInvocation<RotateApiCredentialRequest>,
  ) => Promise<IssuedApiCredentialResponse>;
  readonly revoke: (
    invocation: ApiInvocation<RevokeResourceRequest>,
  ) => Promise<ApiCredentialResponse>;
}

export interface AgentDefinitionApiService {
  readonly list: (invocation: ApiInvocation<undefined>) => Promise<ListAgentDefinitionsResponse>;
  readonly create: (
    invocation: ApiInvocation<CreateAgentDefinitionRequest>,
  ) => Promise<AgentDefinitionResponse>;
  readonly get: (invocation: ApiInvocation<undefined>) => Promise<AgentDefinitionResponse>;
  readonly update: (
    invocation: ApiInvocation<UpdateAgentDefinitionRequest>,
  ) => Promise<AgentDefinitionResponse>;
  readonly archive: (
    invocation: ApiInvocation<ArchiveAgentResourceRequest>,
  ) => Promise<AgentDefinitionResponse>;
}

export interface AgentReleasePromotionResult {
  readonly created: boolean;
  readonly release: AgentReleaseResponse;
}

export interface AgentReleaseApiService {
  readonly list: (invocation: ApiInvocation<undefined>) => Promise<ListAgentReleasesResponse>;
  readonly publish: (
    invocation: ApiInvocation<PublishAgentReleaseRequest>,
  ) => Promise<AgentReleaseResponse>;
  readonly get: (invocation: ApiInvocation<undefined>) => Promise<AgentReleaseResponse>;
  readonly promote: (
    invocation: ApiInvocation<PromoteAgentReleaseRequest>,
  ) => Promise<AgentReleasePromotionResult>;
  readonly archive: (
    invocation: ApiInvocation<ArchiveAgentResourceRequest>,
  ) => Promise<AgentReleaseResponse>;
}

export interface AgentDeploymentApiService {
  readonly list: (invocation: ApiInvocation<undefined>) => Promise<ListAgentDeploymentsResponse>;
  readonly create: (
    invocation: ApiInvocation<CreateAgentDeploymentRequest>,
  ) => Promise<AgentDeploymentResponse>;
  readonly get: (invocation: ApiInvocation<undefined>) => Promise<AgentDeploymentResponse>;
  readonly update: (
    invocation: ApiInvocation<UpdateAgentDeploymentRequest>,
  ) => Promise<AgentDeploymentResponse>;
  readonly stop: (
    invocation: ApiInvocation<ArchiveAgentResourceRequest>,
  ) => Promise<AgentDeploymentResponse>;
  readonly startCanary: (
    invocation: ApiInvocation<StartAgentDeploymentCanaryRequest>,
  ) => Promise<AgentDeploymentResponse>;
  readonly promoteCanary: (
    invocation: ApiInvocation<ResolveAgentDeploymentCanaryRequest>,
  ) => Promise<AgentDeploymentResponse>;
  readonly abortCanary: (
    invocation: ApiInvocation<ResolveAgentDeploymentCanaryRequest>,
  ) => Promise<AgentDeploymentResponse>;
}

export interface WorkflowDefinitionApiService {
  readonly list: (invocation: ApiInvocation<undefined>) => Promise<ListWorkflowDefinitionsResponse>;
  readonly create: (
    invocation: ApiInvocation<CreateWorkflowDefinitionRequest>,
  ) => Promise<WorkflowDefinitionResponse>;
  readonly get: (invocation: ApiInvocation<undefined>) => Promise<WorkflowDefinitionResponse>;
  readonly update: (
    invocation: ApiInvocation<UpdateWorkflowDefinitionRequest>,
  ) => Promise<WorkflowDefinitionResponse>;
  readonly archive: (
    invocation: ApiInvocation<ArchiveWorkflowResourceRequest>,
  ) => Promise<WorkflowDefinitionResponse>;
}

export interface WorkflowReleaseApiService {
  readonly list: (invocation: ApiInvocation<undefined>) => Promise<ListWorkflowReleasesResponse>;
  readonly publish: (
    invocation: ApiInvocation<PublishWorkflowReleaseRequest>,
  ) => Promise<WorkflowReleaseResponse>;
  readonly get: (invocation: ApiInvocation<undefined>) => Promise<WorkflowReleaseResponse>;
  readonly archive: (
    invocation: ApiInvocation<ArchiveWorkflowResourceRequest>,
  ) => Promise<WorkflowReleaseResponse>;
}

export interface ManagedSkillSourceApiService {
  readonly list: (invocation: ApiInvocation<undefined>) => Promise<ListManagedSkillSourcesResponse>;
  readonly create: (
    invocation: ApiInvocation<CreateManagedSkillSourceRequest>,
  ) => Promise<ManagedSkillSourceResponse>;
  readonly get: (invocation: ApiInvocation<undefined>) => Promise<ManagedSkillSourceResponse>;
  readonly update: (
    invocation: ApiInvocation<UpdateManagedSkillSourceRequest>,
  ) => Promise<ManagedSkillSourceResponse>;
  readonly archive: (
    invocation: ApiInvocation<ArchiveManagedSkillResourceRequest>,
  ) => Promise<ManagedSkillSourceResponse>;
}

export interface ManagedSkillReleaseApiService {
  readonly list: (
    invocation: ApiInvocation<undefined>,
  ) => Promise<ListManagedSkillReleasesResponse>;
  readonly publish: (
    invocation: ApiInvocation<PublishManagedSkillReleaseRequest>,
  ) => Promise<ManagedSkillReleaseResponse>;
  readonly get: (invocation: ApiInvocation<undefined>) => Promise<ManagedSkillReleaseResponse>;
  readonly archive: (
    invocation: ApiInvocation<ArchiveManagedSkillResourceRequest>,
  ) => Promise<ManagedSkillReleaseResponse>;
}

export interface ManagedSkillApiService {
  readonly list: (invocation: ApiInvocation<undefined>) => Promise<ListManagedSkillsResponse>;
  readonly get: (invocation: ApiInvocation<undefined>) => Promise<ManagedSkillResponse>;
}

export interface ManagedSkillInstallationApiService {
  readonly list: (
    invocation: ApiInvocation<undefined>,
  ) => Promise<ListManagedSkillInstallationsResponse>;
  readonly install: (
    invocation: ApiInvocation<InstallManagedSkillRequest>,
  ) => Promise<ManagedSkillInstallationResponse>;
  readonly get: (invocation: ApiInvocation<undefined>) => Promise<ManagedSkillInstallationResponse>;
  readonly remove: (
    invocation: ApiInvocation<ArchiveManagedSkillResourceRequest>,
  ) => Promise<ManagedSkillInstallationResponse>;
}

export interface TenancyApiService {
  readonly agentDefinitions: AgentDefinitionApiService;
  readonly agentDeployments: AgentDeploymentApiService;
  readonly agentReleases: AgentReleaseApiService;
  readonly organizations: OrganizationApiService;
  readonly organizationMembers: OrganizationMemberApiService;
  readonly organizationInvitations: OrganizationInvitationApiService;
  readonly projects: ProjectApiService;
  readonly environments: EnvironmentApiService;
  readonly workspaces: WorkspaceApiService;
  readonly serviceAccounts: ServiceAccountApiService;
  readonly apiCredentials: ApiCredentialApiService;
  readonly organizationLimits?: OrganizationLimitsApiService;
  readonly organizationStanding?: OrganizationStandingApiService;
  readonly workflowDefinitions?: WorkflowDefinitionApiService;
  readonly workflowReleases?: WorkflowReleaseApiService;
  readonly managedSkillSources?: ManagedSkillSourceApiService;
  readonly managedSkillReleases?: ManagedSkillReleaseApiService;
  readonly managedSkills?: ManagedSkillApiService;
  readonly managedSkillInstallations?: ManagedSkillInstallationApiService;
}

export type AgentLifecycleApiService = Pick<
  TenancyApiService,
  "agentDefinitions" | "agentDeployments" | "agentReleases"
>;

export type IdempotencyStore = IdempotencyPersistence;

export interface CreateTenancyApiOptions {
  readonly authorize: (
    invocation: ApiInvocation,
    operationName: string,
    mutation: boolean,
  ) => Promise<void>;
  readonly authenticate: (request: Request) => Promise<ApiIdentity | null>;
  readonly authenticateIdentity?: (request: Request) => Promise<ApiIdentity | null>;
  readonly deviceAuthorization?: DeviceAuthorizationService;
  readonly idempotency: IdempotencyStore;
  readonly openApiSpec?: () => PublicOpenApiSpec;
  readonly operationalReads?: OperationalReadService;
  readonly recordApiCredentialUsage?: ApiCredentialUsageRecorder;
  readonly requestId?: () => string;
  readonly service: TenancyApiService;
}

export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiProblem";
  }
}

export const schemas = TENANCY_API_SCHEMAS;
export const identitySchemas = IDENTITY_API_SCHEMAS;
export const operationalSchemas = OPERATIONS_API_SCHEMAS;
export const agentRouteNames: ReadonlySet<string> = new Set(
  TENANCY_API_ROUTES.filter(
    (route) => "tag" in route && (route.tag === "Agents" || route.tag === "Workflows"),
  ).map((route) => route.name),
);
export const explicitEnvironmentGrantRouteNames: ReadonlySet<string> = new Set(
  TENANCY_API_ROUTES.filter(
    (route) =>
      route.scope === "environment" &&
      "tag" in route &&
      (route.tag === "Agents" ||
        route.tag === "Workflows" ||
        route.name.includes("ManagedSkillInstallation")),
  ).map((route) => route.name),
);
export const readErrors = [400, 401, 403, 404, 422].map((status) =>
  schemas.ProblemDetails.pipe(HttpApiSchema.status(status)),
);
export const mutationErrors = [400, 401, 403, 404, 409, 422, 429].map((status) =>
  schemas.ProblemDetails.pipe(HttpApiSchema.status(status)),
);
export const deviceAuthorizationErrors = [400, 429, 500, 503].map((status) =>
  schemas.ProblemDetails.pipe(HttpApiSchema.status(status)),
);
export const idParams = { id: PublicId };
export const listQuery = schemas.ListQuery;
export const idempotencyHeaders = {
  "idempotency-key": Schema.optional(schemas.IdempotencyKey),
};
export const organizationHeaders = {
  "x-deployments-organization": Schema.optional(PublicId),
};
export const projectHeaders = { "x-deployments-project": Schema.optional(PublicId) };
export const environmentHeaders = {
  "x-deployments-environment": Schema.optional(PublicId),
};
export const optionalRevokePayload = Schema.UndefinedOr(schemas.RevokeResourceRequest);
export const optionalRotatePayload = Schema.UndefinedOr(schemas.RotateApiCredentialRequest);
export const operationalQuery = Schema.Struct({
  actor: Schema.optional(Schema.String),
  apiCredentialId: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  event: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
  metric: Schema.optional(Schema.String),
  resource: Schema.optional(Schema.String),
  since: Schema.optional(Schema.String),
  until: Schema.optional(Schema.String),
});
export const usageSummaryQuery = Schema.Struct({
  agentDefinitionId: Schema.optional(Schema.String),
  interval: Schema.optional(Schema.String),
  since: Schema.String,
  until: Schema.String,
  workspaceId: Schema.optional(Schema.String),
});
export const workspaceSpendQuery = Schema.Struct({ month: Schema.optional(Schema.String) });

export const HealthResponse = Schema.Struct({
  service: Schema.Literal("deployments-ai-api"),
  status: Schema.Literal("ok"),
});

export class ApiRequestContext extends Context.Service<
  ApiRequestContext,
  { readonly requestId: string }
>()("deployments-ai/ApiRequestContext") {}

export class AuthenticatedIdentity extends Context.Service<AuthenticatedIdentity, ApiIdentity>()(
  "deployments-ai/AuthenticatedIdentity",
) {}

export class RequestLifecycle extends HttpApiMiddleware.Service<
  RequestLifecycle,
  { provides: ApiRequestContext }
>()("deployments-ai/RequestLifecycle") {}

export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: AuthenticatedIdentity; requires: ApiRequestContext }
>()("deployments-ai/Authentication", {
  security: { bearer: HttpApiSecurity.bearer },
}) {}

export const SystemGroup = HttpApiGroup.make("system", { topLevel: true })
  .add(
    HttpApiEndpoint.get("health", "/health", { success: HealthResponse }),
    HttpApiEndpoint.get("openapi", "/v1/openapi.json", { success: Schema.Unknown }),
  )
  .middleware(RequestLifecycle);

export const SecurityGroup = HttpApiGroup.make("security")
  .add(
    HttpApiEndpoint.get("getIdentity", "/v1/whoami", {
      success: identitySchemas.IdentityResponse,
      error: readErrors,
    }),
  )
  .middleware(RequestLifecycle);

export const DeviceAuthorizationGroup = HttpApiGroup.make("deviceAuthorization")
  .add(
    HttpApiEndpoint.post("startDeviceAuthorization", "/v1/device-authorizations", {
      payload: identitySchemas.StartDeviceAuthorizationRequest,
      success: identitySchemas.DeviceAuthorizationResponse,
      error: deviceAuthorizationErrors,
    }),
    HttpApiEndpoint.post("exchangeDeviceAuthorization", "/v1/device-authorizations/token", {
      payload: identitySchemas.ExchangeDeviceAuthorizationRequest,
      success: identitySchemas.DeviceTokenResponse,
      error: deviceAuthorizationErrors,
    }),
    HttpApiEndpoint.post("revokeDeviceAuthorization", "/v1/device-authorizations/revoke", {
      payload: identitySchemas.RevokeDeviceAuthorizationRequest,
      success: identitySchemas.DeviceRevocationResponse,
      error: deviceAuthorizationErrors,
    }),
  )
  .middleware(RequestLifecycle);
