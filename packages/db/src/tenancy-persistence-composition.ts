import { makeApiCredentialPersistence } from "./api-credential-persistence.ts";
import { makeEnvironmentPersistence } from "./environment-persistence.ts";
import type { Ulid } from "./ids.ts";
import { makeOrganizationInvitationPersistence } from "./organization-invitation-persistence.ts";
import { makeOrganizationMemberPersistence } from "./organization-member-persistence.ts";
import { makeOrganizationPersistence } from "./organization-persistence.ts";
import { organizationRoleAllows } from "./organization-role-matrix.ts";
import { PersistenceError } from "./persistence-types.ts";
import { makeProjectPersistence } from "./project-persistence.ts";
import { makeServiceAccountPersistence } from "./service-account-persistence.ts";
import { isGlobalManagedSkillMutation, isMutationOperation } from "./tenancy-authorization.ts";
import type { TenancyPersistence, TenancyPersistenceDependencies } from "./tenancy-contracts.ts";
import { makeTenancyContext } from "./tenancy-persistence-context.ts";
import { requiredScope } from "./tenancy-record-mapping.ts";
import { makeWorkspacePersistence } from "./workspace-persistence.ts";

export function makeTenancyPersistence(
  dependencies: TenancyPersistenceDependencies,
): TenancyPersistence {
  const context = makeTenancyContext(dependencies);
  const organizations = makeOrganizationPersistence(context);
  const organizationMembers = makeOrganizationMemberPersistence(context);
  const organizationInvitations = makeOrganizationInvitationPersistence(context);
  const projects = makeProjectPersistence({ ...context, organizations });
  const environments = makeEnvironmentPersistence({ ...context, projects });
  const workspaces = makeWorkspacePersistence(context);
  const serviceAccounts = makeServiceAccountPersistence(context);
  const apiCredentials = makeApiCredentialPersistence(context);
  const {
    authorizeOrganization,
    environmentFor,
    isPlatformAdministrator,
    projectFor,
    requireOrganizationRole,
  } = context;
  return {
    async authorize(
      invocation,
      operationName,
      mutation = operationName ? isMutationOperation(operationName) : false,
    ) {
      if (
        operationName &&
        isGlobalManagedSkillMutation(operationName) &&
        !isPlatformAdministrator(invocation)
      ) {
        throw new PersistenceError(
          "forbidden",
          "insufficient_role",
          "Managing the global skill catalog requires platform administrator access.",
        );
      }
      if (operationName === "createOrganizationInvitation") {
        const organizationId = requiredScope(invocation, "organizationId");
        const actor = await requireOrganizationRole(
          invocation,
          organizationId,
          "invitations.manage",
          "Creating organization invitations",
        );
        if (
          (invocation.body as { readonly role?: unknown }).role === "owner" &&
          actor !== undefined &&
          !organizationRoleAllows(actor.data.role, "owners.manage")
        ) {
          throw new PersistenceError(
            "forbidden",
            "insufficient_role",
            "Only an organization owner can invite another owner.",
          );
        }
      }
      let organizationId: Ulid | undefined;
      if (invocation.scope.environmentId) {
        organizationId = (await environmentFor(invocation)).data.organizationId;
      } else if (invocation.scope.projectId) {
        organizationId = (await projectFor(invocation, requiredScope(invocation, "projectId"))).data
          .organizationId;
      } else if (invocation.scope.organizationId) {
        organizationId = requiredScope(invocation, "organizationId");
        await authorizeOrganization(invocation, organizationId);
      }
      // Membership is request-admission state; concurrent role changes govern later requests.
      if (organizationId && mutation && invocation.identity.authentication !== "api-credential") {
        await requireOrganizationRole(
          invocation,
          organizationId,
          "resources.mutate",
          "Mutating organization resources",
        );
      }
    },
    apiCredentials,
    environments,
    organizationInvitations,
    organizationMembers,
    organizations,
    projects,
    serviceAccounts,
    workspaces,
  };
}
