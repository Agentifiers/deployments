import { TENANCY_API_SCHEMAS } from "@deployments-ai/api-contract";
import type { PlatformPersistence } from "@deployments-ai/db";
import { Schema } from "effect";
import type { TenancyApiService } from "./index.ts";

const schemas = TENANCY_API_SCHEMAS;

export function adaptTenancyPersistence(persistence: PlatformPersistence): TenancyApiService {
  return {
    organizations: {
      list: async (invocation) =>
        Schema.decodeUnknownSync(schemas.ListOrganizationsResponse)(
          await persistence.organizations.list(invocation),
        ),
      create: async (invocation) =>
        Schema.decodeUnknownSync(schemas.OrganizationResponse)(
          await persistence.organizations.create(invocation),
        ),
      get: async (invocation) =>
        Schema.decodeUnknownSync(schemas.OrganizationResponse)(
          await persistence.organizations.get(invocation),
        ),
      update: async (invocation) =>
        Schema.decodeUnknownSync(schemas.OrganizationResponse)(
          await persistence.organizations.update(invocation),
        ),
    },
    organizationMembers: {
      list: async (invocation) =>
        Schema.decodeUnknownSync(schemas.ListOrganizationMembersResponse)(
          await persistence.organizationMembers.list(invocation),
        ),
      add: async (invocation) =>
        Schema.decodeUnknownSync(schemas.OrganizationMemberResponse)(
          await persistence.organizationMembers.add(invocation),
        ),
      update: async (invocation) =>
        Schema.decodeUnknownSync(schemas.OrganizationMemberResponse)(
          await persistence.organizationMembers.update(invocation),
        ),
      remove: async (invocation) =>
        Schema.decodeUnknownSync(schemas.OrganizationMemberResponse)(
          await persistence.organizationMembers.remove(invocation),
        ),
    },
    organizationInvitations: {
      list: async (invocation) =>
        Schema.decodeUnknownSync(schemas.ListOrganizationInvitationsResponse)(
          await persistence.organizationInvitations.list(invocation),
        ),
      create: async (invocation) =>
        Schema.decodeUnknownSync(schemas.IssuedOrganizationInvitationResponse)(
          await persistence.organizationInvitations.create(invocation),
        ),
      revoke: async (invocation) =>
        Schema.decodeUnknownSync(schemas.OrganizationInvitationResponse)(
          await persistence.organizationInvitations.revoke(invocation),
        ),
      accept: async (invocation) =>
        Schema.decodeUnknownSync(schemas.OrganizationMemberResponse)(
          await persistence.organizationInvitations.accept(invocation),
        ),
    },
    projects: {
      list: async (invocation) =>
        Schema.decodeUnknownSync(schemas.ListProjectsResponse)(
          await persistence.projects.list(invocation),
        ),
      create: async (invocation) =>
        Schema.decodeUnknownSync(schemas.ProjectResponse)(
          await persistence.projects.create(invocation),
        ),
      get: async (invocation) =>
        Schema.decodeUnknownSync(schemas.ProjectResponse)(
          await persistence.projects.get(invocation),
        ),
      update: async (invocation) =>
        Schema.decodeUnknownSync(schemas.ProjectResponse)(
          await persistence.projects.update(invocation),
        ),
      archive: async (invocation) =>
        Schema.decodeUnknownSync(schemas.ProjectResponse)(
          await persistence.projects.archive(invocation),
        ),
    },
    environments: {
      list: async (invocation) =>
        Schema.decodeUnknownSync(schemas.ListEnvironmentsResponse)(
          await persistence.environments.list(invocation),
        ),
      create: async (invocation) =>
        Schema.decodeUnknownSync(schemas.EnvironmentResponse)(
          await persistence.environments.create(invocation),
        ),
      get: async (invocation) =>
        Schema.decodeUnknownSync(schemas.EnvironmentResponse)(
          await persistence.environments.get(invocation),
        ),
      update: async (invocation) =>
        Schema.decodeUnknownSync(schemas.EnvironmentResponse)(
          await persistence.environments.update(invocation),
        ),
      archive: async (invocation) =>
        Schema.decodeUnknownSync(schemas.EnvironmentResponse)(
          await persistence.environments.archive(invocation),
        ),
    },
    workspaces: {
      list: async (invocation) =>
        Schema.decodeUnknownSync(schemas.ListWorkspacesResponse)(
          await persistence.workspaces.list(invocation),
        ),
      create: async (invocation) =>
        Schema.decodeUnknownSync(schemas.WorkspaceResponse)(
          await persistence.workspaces.create(invocation),
        ),
      get: async (invocation) =>
        Schema.decodeUnknownSync(schemas.WorkspaceResponse)(
          await persistence.workspaces.get(invocation),
        ),
      update: async (invocation) =>
        Schema.decodeUnknownSync(schemas.WorkspaceResponse)(
          await persistence.workspaces.update(invocation),
        ),
      archive: async (invocation) =>
        Schema.decodeUnknownSync(schemas.WorkspaceResponse)(
          await persistence.workspaces.archive(invocation),
        ),
    },
    serviceAccounts: {
      list: async (invocation) =>
        Schema.decodeUnknownSync(schemas.ListServiceAccountsResponse)(
          await persistence.serviceAccounts.list(invocation),
        ),
      create: async (invocation) =>
        Schema.decodeUnknownSync(schemas.ServiceAccountResponse)(
          await persistence.serviceAccounts.create(invocation),
        ),
      get: async (invocation) =>
        Schema.decodeUnknownSync(schemas.ServiceAccountResponse)(
          await persistence.serviceAccounts.get(invocation),
        ),
      revoke: async (invocation) =>
        Schema.decodeUnknownSync(schemas.ServiceAccountResponse)(
          await persistence.serviceAccounts.revoke(invocation),
        ),
    },
    apiCredentials: {
      list: async (invocation) =>
        Schema.decodeUnknownSync(schemas.ListApiCredentialsResponse)(
          await persistence.apiCredentials.list(invocation),
        ),
      create: async (invocation) =>
        Schema.decodeUnknownSync(schemas.IssuedApiCredentialResponse)(
          await persistence.apiCredentials.create(invocation),
        ),
      rotate: async (invocation) =>
        Schema.decodeUnknownSync(schemas.IssuedApiCredentialResponse)(
          await persistence.apiCredentials.rotate(invocation),
        ),
      revoke: async (invocation) =>
        Schema.decodeUnknownSync(schemas.ApiCredentialResponse)(
          await persistence.apiCredentials.revoke(invocation),
        ),
    },
    agentDefinitions: {
      list: async (invocation) =>
        Schema.decodeUnknownSync(schemas.ListAgentDefinitionsResponse)(
          await persistence.agentDefinitions.list(invocation),
        ),
      create: async (invocation) =>
        Schema.decodeUnknownSync(schemas.AgentDefinitionResponse)(
          await persistence.agentDefinitions.create(invocation),
        ),
      get: async (invocation) =>
        Schema.decodeUnknownSync(schemas.AgentDefinitionResponse)(
          await persistence.agentDefinitions.get(invocation),
        ),
      update: async (invocation) =>
        Schema.decodeUnknownSync(schemas.AgentDefinitionResponse)(
          await persistence.agentDefinitions.update(invocation),
        ),
      archive: async (invocation) =>
        Schema.decodeUnknownSync(schemas.AgentDefinitionResponse)(
          await persistence.agentDefinitions.archive(invocation),
        ),
    },
    agentReleases: {
      list: async (invocation) =>
        Schema.decodeUnknownSync(schemas.ListAgentReleasesResponse)(
          await persistence.agentReleases.list(invocation),
        ),
      publish: async (invocation) =>
        Schema.decodeUnknownSync(schemas.AgentReleaseResponse)(
          await persistence.agentReleases.publish(invocation),
        ),
      get: async (invocation) =>
        Schema.decodeUnknownSync(schemas.AgentReleaseResponse)(
          await persistence.agentReleases.get(invocation),
        ),
      promote: async (invocation) => {
        const result = await persistence.agentReleases.promote(invocation);
        return {
          created: result.created,
          release: Schema.decodeUnknownSync(schemas.AgentReleaseResponse)(result.release),
        };
      },
      archive: async (invocation) =>
        Schema.decodeUnknownSync(schemas.AgentReleaseResponse)(
          await persistence.agentReleases.archive(invocation),
        ),
    },
    agentDeployments: {
      list: async (invocation) =>
        Schema.decodeUnknownSync(schemas.ListAgentDeploymentsResponse)(
          await persistence.agentDeployments.list(invocation),
        ),
      create: async (invocation) =>
        Schema.decodeUnknownSync(schemas.AgentDeploymentResponse)(
          await persistence.agentDeployments.create(invocation),
        ),
      get: async (invocation) =>
        Schema.decodeUnknownSync(schemas.AgentDeploymentResponse)(
          await persistence.agentDeployments.get(invocation),
        ),
      update: async (invocation) =>
        Schema.decodeUnknownSync(schemas.AgentDeploymentResponse)(
          await persistence.agentDeployments.update(invocation),
        ),
      stop: async (invocation) =>
        Schema.decodeUnknownSync(schemas.AgentDeploymentResponse)(
          await persistence.agentDeployments.stop(invocation),
        ),
      startCanary: async (invocation) =>
        Schema.decodeUnknownSync(schemas.AgentDeploymentResponse)(
          await persistence.agentDeployments.startCanary(invocation),
        ),
      promoteCanary: async (invocation) =>
        Schema.decodeUnknownSync(schemas.AgentDeploymentResponse)(
          await persistence.agentDeployments.promoteCanary(invocation),
        ),
      abortCanary: async (invocation) =>
        Schema.decodeUnknownSync(schemas.AgentDeploymentResponse)(
          await persistence.agentDeployments.abortCanary(invocation),
        ),
    },
  };
}
