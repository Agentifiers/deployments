import { PLATFORM_CLI_SCOPES } from "@deployments-ai/identity";

export function deviceAuthorizationProfile(
  claimProfile: "cognito" | "legacy" | "platform" | undefined,
) {
  return claimProfile === "platform"
    ? ({ bearerTokenSource: "access_token", scopes: PLATFORM_CLI_SCOPES } as const)
    : ({ bearerTokenSource: "id_token" } as const);
}

export function deviceAuthorizationAudienceIsCompatible(
  profile: ReturnType<typeof deviceAuthorizationProfile>,
  audience: string | readonly string[],
  clientId: string,
) {
  const acceptedAudiences = typeof audience === "string" ? [audience] : audience;
  return profile.bearerTokenSource === "access_token" || acceptedAudiences.includes(clientId);
}
