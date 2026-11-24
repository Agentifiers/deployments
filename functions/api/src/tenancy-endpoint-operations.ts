import { Schema } from "effect";
import {
  endpointOperation,
  noRequestBody,
  requestDecoder,
  responseDecoder,
  schemas,
  serviceOperation,
} from "./endpoint-operation-definition.ts";
import type { TenancyApiService } from "./index.ts";

export function createTenancyEndpointOperations(service: TenancyApiService) {
  return {
    listManagedSkills: endpointOperation(
      "listManagedSkills",
      noRequestBody,
      serviceOperation(service.managedSkills?.list, "Managed skill"),
      responseDecoder(
        "listManagedSkills",
        Schema.decodeUnknownSync(schemas.ListManagedSkillsResponse),
      ),
    ),
    getManagedSkill: endpointOperation(
      "getManagedSkill",
      noRequestBody,
      serviceOperation(service.managedSkills?.get, "Managed skill"),
      responseDecoder("getManagedSkill", Schema.decodeUnknownSync(schemas.ManagedSkillResponse)),
    ),
    listManagedSkillInstallations: endpointOperation(
      "listManagedSkillInstallations",
      noRequestBody,
      serviceOperation(service.managedSkillInstallations?.list, "Managed skill installation"),
      responseDecoder(
        "listManagedSkillInstallations",
        Schema.decodeUnknownSync(schemas.ListManagedSkillInstallationsResponse),
      ),
    ),
    installManagedSkill: endpointOperation(
      "installManagedSkill",
      requestDecoder(
        "installManagedSkill",
        Schema.decodeUnknownSync(schemas.InstallManagedSkillRequest),
      ),
      serviceOperation(service.managedSkillInstallations?.install, "Managed skill installation"),
      responseDecoder(
        "installManagedSkill",
        Schema.decodeUnknownSync(schemas.ManagedSkillInstallationResponse),
      ),
    ),
    getManagedSkillInstallation: endpointOperation(
      "getManagedSkillInstallation",
      noRequestBody,
      serviceOperation(service.managedSkillInstallations?.get, "Managed skill installation"),
      responseDecoder(
        "getManagedSkillInstallation",
        Schema.decodeUnknownSync(schemas.ManagedSkillInstallationResponse),
      ),
    ),
    removeManagedSkillInstallation: endpointOperation(
      "removeManagedSkillInstallation",
      requestDecoder(
        "removeManagedSkillInstallation",
        Schema.decodeUnknownSync(schemas.ArchiveManagedSkillResourceRequest),
      ),
      serviceOperation(service.managedSkillInstallations?.remove, "Managed skill installation"),
      responseDecoder(
        "removeManagedSkillInstallation",
        Schema.decodeUnknownSync(schemas.ManagedSkillInstallationResponse),
      ),
    ),
    listOrganizations: endpointOperation(
      "listOrganizations",
      noRequestBody,
      service.organizations.list,
      responseDecoder(
        "listOrganizations",
        Schema.decodeUnknownSync(schemas.ListOrganizationsResponse),
      ),
    ),
    createOrganization: endpointOperation(
      "createOrganization",
      requestDecoder(
        "createOrganization",
        Schema.decodeUnknownSync(schemas.CreateOrganizationRequest),
      ),
      service.organizations.create,
      responseDecoder("createOrganization", Schema.decodeUnknownSync(schemas.OrganizationResponse)),
    ),
    getOrganization: endpointOperation(
      "getOrganization",
      noRequestBody,
      service.organizations.get,
      responseDecoder("getOrganization", Schema.decodeUnknownSync(schemas.OrganizationResponse)),
    ),
    getOrganizationLimits: endpointOperation(
      "getOrganizationLimits",
      noRequestBody,
      serviceOperation(service.organizationLimits?.get, "Organization limits"),
      responseDecoder(
        "getOrganizationLimits",
        Schema.decodeUnknownSync(schemas.OrganizationLimitsResponse),
      ),
    ),
    getOrganizationStanding: endpointOperation(
      "getOrganizationStanding",
      noRequestBody,
      serviceOperation(service.organizationStanding?.get, "Organization standing"),
      responseDecoder(
        "getOrganizationStanding",
        Schema.decodeUnknownSync(schemas.OrganizationStandingResponse),
      ),
    ),
    updateOrganization: endpointOperation(
      "updateOrganization",
      requestDecoder(
        "updateOrganization",
        Schema.decodeUnknownSync(schemas.UpdateOrganizationRequest),
      ),
      service.organizations.update,
      responseDecoder("updateOrganization", Schema.decodeUnknownSync(schemas.OrganizationResponse)),
    ),
    listOrganizationMembers: endpointOperation(
      "listOrganizationMembers",
      noRequestBody,
      service.organizationMembers.list,
      responseDecoder(
        "listOrganizationMembers",
        Schema.decodeUnknownSync(schemas.ListOrganizationMembersResponse),
      ),
    ),
    addOrganizationMember: endpointOperation(
      "addOrganizationMember",
      requestDecoder(
        "addOrganizationMember",
        Schema.decodeUnknownSync(schemas.AddOrganizationMemberRequest),
      ),
      service.organizationMembers.add,
      responseDecoder(
        "addOrganizationMember",
        Schema.decodeUnknownSync(schemas.OrganizationMemberResponse),
      ),
    ),
    updateOrganizationMember: endpointOperation(
      "updateOrganizationMember",
      requestDecoder(
        "updateOrganizationMember",
        Schema.decodeUnknownSync(schemas.UpdateOrganizationMemberRequest),
      ),
      service.organizationMembers.update,
      responseDecoder(
        "updateOrganizationMember",
        Schema.decodeUnknownSync(schemas.OrganizationMemberResponse),
      ),
    ),
    removeOrganizationMember: endpointOperation(
      "removeOrganizationMember",
      requestDecoder(
        "removeOrganizationMember",
        Schema.decodeUnknownSync(schemas.RevokeResourceRequest),
      ),
      service.organizationMembers.remove,
      responseDecoder(
        "removeOrganizationMember",
        Schema.decodeUnknownSync(schemas.OrganizationMemberResponse),
      ),
    ),
    listOrganizationInvitations: endpointOperation(
      "listOrganizationInvitations",
      noRequestBody,
      service.organizationInvitations.list,
      responseDecoder(
        "listOrganizationInvitations",
        Schema.decodeUnknownSync(schemas.ListOrganizationInvitationsResponse),
      ),
    ),
    createOrganizationInvitation: endpointOperation(
      "createOrganizationInvitation",
      requestDecoder(
        "createOrganizationInvitation",
        Schema.decodeUnknownSync(schemas.CreateOrganizationInvitationRequest),
      ),
      service.organizationInvitations.create,
      responseDecoder(
        "createOrganizationInvitation",
        Schema.decodeUnknownSync(schemas.IssuedOrganizationInvitationResponse),
      ),
    ),
    revokeOrganizationInvitation: endpointOperation(
      "revokeOrganizationInvitation",
      requestDecoder(
        "revokeOrganizationInvitation",
        Schema.decodeUnknownSync(schemas.RevokeResourceRequest),
      ),
      service.organizationInvitations.revoke,
      responseDecoder(
        "revokeOrganizationInvitation",
        Schema.decodeUnknownSync(schemas.OrganizationInvitationResponse),
      ),
    ),
    acceptOrganizationInvitation: endpointOperation(
      "acceptOrganizationInvitation",
      requestDecoder(
        "acceptOrganizationInvitation",
        Schema.decodeUnknownSync(schemas.AcceptOrganizationInvitationRequest),
      ),
      service.organizationInvitations.accept,
      responseDecoder(
        "acceptOrganizationInvitation",
        Schema.decodeUnknownSync(schemas.OrganizationMemberResponse),
      ),
    ),
    listProjects: endpointOperation(
      "listProjects",
      noRequestBody,
      service.projects.list,
      responseDecoder("listProjects", Schema.decodeUnknownSync(schemas.ListProjectsResponse)),
    ),
    createProject: endpointOperation(
      "createProject",
      requestDecoder("createProject", Schema.decodeUnknownSync(schemas.CreateProjectRequest)),
      service.projects.create,
      responseDecoder("createProject", Schema.decodeUnknownSync(schemas.ProjectResponse)),
    ),
    getProject: endpointOperation(
      "getProject",
      noRequestBody,
      service.projects.get,
      responseDecoder("getProject", Schema.decodeUnknownSync(schemas.ProjectResponse)),
    ),
    updateProject: endpointOperation(
      "updateProject",
      requestDecoder("updateProject", Schema.decodeUnknownSync(schemas.UpdateProjectRequest)),
      service.projects.update,
      responseDecoder("updateProject", Schema.decodeUnknownSync(schemas.ProjectResponse)),
    ),
    archiveProject: endpointOperation(
      "archiveProject",
      requestDecoder("archiveProject", Schema.decodeUnknownSync(schemas.RevokeResourceRequest)),
      service.projects.archive,
      responseDecoder("archiveProject", Schema.decodeUnknownSync(schemas.ProjectResponse)),
    ),
    listEnvironments: endpointOperation(
      "listEnvironments",
      noRequestBody,
      service.environments.list,
      responseDecoder(
        "listEnvironments",
        Schema.decodeUnknownSync(schemas.ListEnvironmentsResponse),
      ),
    ),
    createEnvironment: endpointOperation(
      "createEnvironment",
      requestDecoder(
        "createEnvironment",
        Schema.decodeUnknownSync(schemas.CreateEnvironmentRequest),
      ),
      service.environments.create,
      responseDecoder("createEnvironment", Schema.decodeUnknownSync(schemas.EnvironmentResponse)),
    ),
    getEnvironment: endpointOperation(
      "getEnvironment",
      noRequestBody,
      service.environments.get,
      responseDecoder("getEnvironment", Schema.decodeUnknownSync(schemas.EnvironmentResponse)),
    ),
    updateEnvironment: endpointOperation(
      "updateEnvironment",
      requestDecoder(
        "updateEnvironment",
        Schema.decodeUnknownSync(schemas.UpdateEnvironmentRequest),
      ),
      service.environments.update,
      responseDecoder("updateEnvironment", Schema.decodeUnknownSync(schemas.EnvironmentResponse)),
    ),
    archiveEnvironment: endpointOperation(
      "archiveEnvironment",
      requestDecoder("archiveEnvironment", Schema.decodeUnknownSync(schemas.RevokeResourceRequest)),
      service.environments.archive,
      responseDecoder("archiveEnvironment", Schema.decodeUnknownSync(schemas.EnvironmentResponse)),
    ),
    listWorkspaces: endpointOperation(
      "listWorkspaces",
      noRequestBody,
      service.workspaces.list,
      responseDecoder("listWorkspaces", Schema.decodeUnknownSync(schemas.ListWorkspacesResponse)),
    ),
    createWorkspace: endpointOperation(
      "createWorkspace",
      requestDecoder("createWorkspace", Schema.decodeUnknownSync(schemas.CreateWorkspaceRequest)),
      service.workspaces.create,
      responseDecoder("createWorkspace", Schema.decodeUnknownSync(schemas.WorkspaceResponse)),
    ),
    getWorkspace: endpointOperation(
      "getWorkspace",
      noRequestBody,
      service.workspaces.get,
      responseDecoder("getWorkspace", Schema.decodeUnknownSync(schemas.WorkspaceResponse)),
    ),
    updateWorkspace: endpointOperation(
      "updateWorkspace",
      requestDecoder("updateWorkspace", Schema.decodeUnknownSync(schemas.UpdateWorkspaceRequest)),
      service.workspaces.update,
      responseDecoder("updateWorkspace", Schema.decodeUnknownSync(schemas.WorkspaceResponse)),
    ),
    archiveWorkspace: endpointOperation(
      "archiveWorkspace",
      requestDecoder("archiveWorkspace", Schema.decodeUnknownSync(schemas.RevokeResourceRequest)),
      service.workspaces.archive,
      responseDecoder("archiveWorkspace", Schema.decodeUnknownSync(schemas.WorkspaceResponse)),
    ),
    listServiceAccounts: endpointOperation(
      "listServiceAccounts",
      noRequestBody,
      service.serviceAccounts.list,
      responseDecoder(
        "listServiceAccounts",
        Schema.decodeUnknownSync(schemas.ListServiceAccountsResponse),
      ),
    ),
    createServiceAccount: endpointOperation(
      "createServiceAccount",
      requestDecoder(
        "createServiceAccount",
        Schema.decodeUnknownSync(schemas.CreateServiceAccountRequest),
      ),
      service.serviceAccounts.create,
      responseDecoder(
        "createServiceAccount",
        Schema.decodeUnknownSync(schemas.ServiceAccountResponse),
      ),
    ),
    getServiceAccount: endpointOperation(
      "getServiceAccount",
      noRequestBody,
      service.serviceAccounts.get,
      responseDecoder(
        "getServiceAccount",
        Schema.decodeUnknownSync(schemas.ServiceAccountResponse),
      ),
    ),
    revokeServiceAccount: endpointOperation(
      "revokeServiceAccount",
      requestDecoder(
        "revokeServiceAccount",
        Schema.decodeUnknownSync(schemas.RevokeResourceRequest),
      ),
      service.serviceAccounts.revoke,
      responseDecoder(
        "revokeServiceAccount",
        Schema.decodeUnknownSync(schemas.ServiceAccountResponse),
      ),
    ),
    listApiCredentials: endpointOperation(
      "listApiCredentials",
      noRequestBody,
      service.apiCredentials.list,
      responseDecoder(
        "listApiCredentials",
        Schema.decodeUnknownSync(schemas.ListApiCredentialsResponse),
      ),
    ),
    createApiCredential: endpointOperation(
      "createApiCredential",
      requestDecoder(
        "createApiCredential",
        Schema.decodeUnknownSync(schemas.CreateApiCredentialRequest),
      ),
      service.apiCredentials.create,
      responseDecoder(
        "createApiCredential",
        Schema.decodeUnknownSync(schemas.IssuedApiCredentialResponse),
      ),
    ),
    rotateApiCredential: endpointOperation(
      "rotateApiCredential",
      requestDecoder(
        "rotateApiCredential",
        Schema.decodeUnknownSync(schemas.RotateApiCredentialRequest),
      ),
      service.apiCredentials.rotate,
      responseDecoder(
        "rotateApiCredential",
        Schema.decodeUnknownSync(schemas.IssuedApiCredentialResponse),
      ),
    ),
    revokeApiCredential: endpointOperation(
      "revokeApiCredential",
      requestDecoder(
        "revokeApiCredential",
        Schema.decodeUnknownSync(schemas.RevokeResourceRequest),
      ),
      service.apiCredentials.revoke,
      responseDecoder(
        "revokeApiCredential",
        Schema.decodeUnknownSync(schemas.ApiCredentialResponse),
      ),
    ),
  };
}
