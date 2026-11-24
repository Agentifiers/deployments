import { credentialScopePermits } from "@deployments-ai/identity/scopes";
import type { ApiIdentity } from "./api-service-contracts.ts";

export function permits(scopes: readonly string[], required: string) {
  if (
    scopes.includes("platform:*") ||
    scopes.includes("platform:admin") ||
    scopes.includes(required)
  ) {
    return true;
  }
  const group = required.split(":", 1)[0];
  return scopes.includes(`${group}:*`);
}

export function identityPermits(
  identity: Pick<ApiIdentity, "authentication" | "scopes">,
  required: string,
) {
  return identity.authentication === "api-credential"
    ? credentialScopePermits(identity.scopes, required)
    : permits(identity.scopes, required);
}

export function allowed(grants: readonly string[] | "*" | undefined, value: string) {
  return grants === "*" || grants?.includes(value) === true;
}

/**
 * A person with the platform administrator role (or a platform-wide scope on a signed-in token).
 * API keys never qualify, whatever scopes they carry: they cannot hold operator access. On a
 * tenant request the authenticator has already admitted the administrator under open operator
 * access to the selected organization, or acted on their membership and dropped the role.
 */
export function isPlatformAdministrator(
  identity: Pick<ApiIdentity, "authentication" | "platformRole" | "scopes">,
) {
  return (
    identity.authentication !== "api-credential" &&
    (identity.platformRole === "administrator" ||
      identity.scopes.includes("platform:*") ||
      identity.scopes.includes("platform:admin"))
  );
}

/**
 * Whether a platform administrator acts in `organizationId` under the operator access the
 * authenticator admitted for it. Route-level administrator exemptions on tenant routes use this,
 * never the bare role, so no route lets an administrator past an organization it was not opened.
 */
export function actsUnderOperatorAccess(
  identity: Pick<ApiIdentity, "authentication" | "operatorAccess" | "platformRole" | "scopes">,
  organizationId: string | undefined,
) {
  return (
    isPlatformAdministrator(identity) &&
    organizationId !== undefined &&
    identity.operatorAccess?.organizationId === organizationId
  );
}

/** The one organization a tenant request selected, if it selected exactly one. */
export function selectedOrganization(identity: Pick<ApiIdentity, "organizationIds">) {
  return identity.organizationIds !== "*" && identity.organizationIds?.length === 1
    ? identity.organizationIds[0]
    : undefined;
}
