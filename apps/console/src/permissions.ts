import {
  organizationRoleAllows,
  type OrganizationRoleAction,
} from "@deployments-ai/db/organization-role-matrix";
import { platformScopePermits } from "@deployments-ai/identity/scopes";

/** The `/v1/whoami` fields (requested with the organization header) that decide UI gating. */
export interface ConsoleAuthorization {
  /** Token scopes intersected with the caller's organization role. */
  readonly capabilities: readonly string[];
  readonly organizationRole?: "admin" | "billing" | "member" | "owner" | "viewer";
  readonly platformRole?: "administrator";
}

/**
 * Whether the caller may use an operation, mirroring API enforcement: `platform:` operations
 * belong to platform administrators; every other operation needs membership in the selected
 * organization (platform administrators are exempt) and, when it names a required scope, that
 * scope among the token's role-adjusted capabilities. The platform role grants no token scopes.
 */
export function canUseRoute(
  authorization: ConsoleAuthorization,
  route: {
    readonly requiredAuthorization?: string | undefined;
    readonly requiredRoleAction?: OrganizationRoleAction | undefined;
  },
): boolean {
  const required = route.requiredAuthorization;
  if (required?.startsWith("platform:")) return authorization.platformRole === "administrator";
  const administrator = authorization.platformRole === "administrator";
  if (!administrator && authorization.organizationRole === undefined) return false;
  if (
    !administrator &&
    route.requiredRoleAction !== undefined &&
    !organizationRoleAllows(authorization.organizationRole, route.requiredRoleAction)
  )
    return false;
  return required === undefined || platformScopePermits(authorization.capabilities, required);
}
