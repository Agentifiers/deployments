import type { TenancyMockResult, TenancyMockRouteContext } from "./tenancy-mock.ts";
import {
  API_CREDENTIAL_IDS,
  ENVIRONMENT_IDS,
  INVITATION_IDS,
  MEMBER_IDS,
  ORGANIZATION_IDS,
  PROJECT_IDS,
  SERVICE_ACCOUNT_IDS,
  WORKSPACE_IDS,
  apiCredential,
  environment,
  organization,
  organizationInvitation,
  organizationMember,
  project,
  serviceAccount,
  workspace,
} from "./tenancy-mock.ts";

export async function handleTenancyResourceMockRoutes(
  context: TenancyMockRouteContext,
): Promise<TenancyMockResult | undefined> {
  const {
    id,
    inputRequest: _inputRequest,
    issued,
    listQuery: _listQuery,
    now,
    request,
    respond,
    routeName,
    state: _state,
  } = context;
  switch (routeName) {
    case "listOrganizations":
      return respond({
        items: ORGANIZATION_IDS.map((itemId, index) =>
          organization(request, now, itemId, String(index + 1)),
        ),
        nextCursor: null,
      });
    case "createOrganization":
    case "getOrganization":
    case "updateOrganization":
      return respond(organization(request, now, id ?? ORGANIZATION_IDS[0], "mock"));
    case "listOrganizationMembers":
      return respond({
        items: MEMBER_IDS.map((itemId) => organizationMember(request, now, itemId)),
        nextCursor: null,
      });
    case "addOrganizationMember":
    case "removeOrganizationMember":
    case "updateOrganizationMember":
      return respond(organizationMember(request, now, id ?? MEMBER_IDS[0]));
    case "listOrganizationInvitations":
      return respond({
        items: INVITATION_IDS.map((itemId, index) =>
          organizationInvitation(request, now, itemId, String(index + 1)),
        ),
        nextCursor: null,
      });
    case "createOrganizationInvitation":
      return respond({
        ...organizationInvitation(request, now, INVITATION_IDS[0], "mock"),
        secretVisibleOnce: true,
        token: "dpl_inv_mock_secret_value",
      });
    case "revokeOrganizationInvitation":
      return respond(organizationInvitation(request, now, id ?? INVITATION_IDS[0], "mock"));
    case "acceptOrganizationInvitation":
      return respond(organizationMember(request, now, MEMBER_IDS[0]));
    case "listProjects":
      return respond({
        items: PROJECT_IDS.map((itemId, index) => project(request, now, itemId, String(index + 1))),
        nextCursor: null,
      });
    case "archiveProject":
    case "createProject":
    case "getProject":
    case "updateProject":
      return respond(project(request, now, id ?? PROJECT_IDS[0], "mock"));
    case "listEnvironments":
      return respond({
        items: ENVIRONMENT_IDS.map((itemId, index) =>
          environment(request, now, itemId, String(index + 1)),
        ),
        nextCursor: null,
      });
    case "archiveEnvironment":
    case "createEnvironment":
    case "getEnvironment":
    case "updateEnvironment":
      return respond(environment(request, now, id ?? ENVIRONMENT_IDS[0], "mock"));
    case "listWorkspaces":
      return respond({
        items: WORKSPACE_IDS.map((itemId, index) =>
          workspace(request, now, itemId, String(index + 1)),
        ),
        nextCursor: null,
      });
    case "archiveWorkspace":
    case "createWorkspace":
    case "getWorkspace":
    case "updateWorkspace":
      return respond(workspace(request, now, id ?? WORKSPACE_IDS[0], "mock"));
    case "listServiceAccounts":
      return respond({
        items: SERVICE_ACCOUNT_IDS.map((itemId, index) =>
          serviceAccount(request, now, itemId, String(index + 1)),
        ),
        nextCursor: null,
      });
    case "createServiceAccount":
    case "getServiceAccount":
    case "revokeServiceAccount":
      return respond(serviceAccount(request, now, id ?? SERVICE_ACCOUNT_IDS[0], "mock"));
    case "listApiCredentials":
      return respond({
        items: API_CREDENTIAL_IDS.map((itemId, index) =>
          apiCredential(request, now, itemId, String(index + 1)),
        ),
        nextCursor: null,
      });
    case "createApiCredential":
    case "revokeApiCredential":
    case "rotateApiCredential": {
      const credential = apiCredential(request, now, id ?? API_CREDENTIAL_IDS[0], "mock");
      return respond(
        issued
          ? { ...credential, secret: "dpl_mock_secret_value", secretVisibleOnce: true }
          : credential,
      );
    }
    default:
      return undefined;
  }
}
