import type { PublicApiStanding } from "./route-contract.ts";
import type { TenancyApiSchemaName } from "./schema-registry.ts";
export const TENANCY_PATHS = {
  agentDefinitions: "/v1/agent-definitions",
  agentDeployments: "/v1/agent-deployments",
  agentReleases: "/v1/agent-releases",
  apiCredentials: "/v1/api-keys",
  environments: "/v1/environments",
  invitations: "/v1/invitations",
  managedSkillInstallations: "/v1/managed-skill-installations",
  managedSkillReleases: "/v1/managed-skill-releases",
  managedSkillSources: "/v1/managed-skill-sources",
  managedSkills: "/v1/managed-skills",
  members: "/v1/members",
  organizations: "/v1/organizations",
  projects: "/v1/projects",
  serviceAccounts: "/v1/service-accounts",
  workflowDefinitions: "/v1/workflow-definitions",
  workflowReleases: "/v1/workflow-releases",
  workspaces: "/v1/workspaces",
} as const;

export const TENANCY_LIST_PATHS = Object.freeze([
  TENANCY_PATHS.agentDefinitions,
  TENANCY_PATHS.agentDeployments,
  TENANCY_PATHS.apiCredentials,
  TENANCY_PATHS.environments,
  TENANCY_PATHS.invitations,
  TENANCY_PATHS.managedSkillInstallations,
  TENANCY_PATHS.managedSkillSources,
  TENANCY_PATHS.members,
  TENANCY_PATHS.organizations,
  TENANCY_PATHS.projects,
  TENANCY_PATHS.serviceAccounts,
  TENANCY_PATHS.workflowDefinitions,
  TENANCY_PATHS.workspaces,
]);

export type ApiContextScope = "environment" | "none" | "organization" | "project";
export type ApiMethod = "DELETE" | "GET" | "PATCH" | "POST";

export interface ApiRouteContract {
  readonly errors: readonly number[];
  readonly idempotent: boolean;
  readonly method: ApiMethod;
  readonly name: string;
  readonly path: string;
  readonly requestBody?: TenancyApiSchemaName;
  readonly requestBodyRequired?: boolean;
  readonly responseBody: TenancyApiSchemaName;
  readonly scope: ApiContextScope;
  readonly standing?: PublicApiStanding;
  readonly successStatus: number;
  readonly tag?: "Agents" | "Managed Skills" | "Tenancy" | "Workflows";
}

export function route<const Contract extends ApiRouteContract>(contract: Contract): Contract {
  return contract;
}

export const readErrors = [400, 401, 403, 404, 422] as const;
export const mutationErrors = [400, 401, 403, 404, 409, 422, 429] as const;
