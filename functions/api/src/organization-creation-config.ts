import type { OrganizationCreationPolicy } from "@deployments-ai/db";
import type { PlatformJwtClaimProfile } from "@deployments-ai/identity/platform-jwt";

export const ORGANIZATION_CREATION_QUOTA_ENV =
  "DEPLOYMENTS_AI_ORGANIZATION_CREATION_QUOTA_PER_PRINCIPAL";

/**
 * Platform identity signs `email_verified` into every access token it mints, so an install that
 * trusts it requires that claim. Other JWT issuers make no such promise.
 */
export function organizationCreationFromEnvironment(
  environment: NodeJS.ProcessEnv,
  claimProfile: PlatformJwtClaimProfile | undefined,
): OrganizationCreationPolicy {
  const quota = environment[ORGANIZATION_CREATION_QUOTA_ENV]?.trim();
  if (quota && !(/^\d+$/u.test(quota) && Number.isSafeInteger(Number(quota)))) {
    throw new Error(
      `${ORGANIZATION_CREATION_QUOTA_ENV} must be a whole number of organizations, or unset for no quota.`,
    );
  }
  return {
    quotaPerPrincipal: quota ? Number(quota) : null,
    requireVerifiedEmail: claimProfile === "platform",
  };
}
