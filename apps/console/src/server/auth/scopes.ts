import { PLATFORM_CLI_SCOPES, PLATFORM_CONSOLE_SCOPES } from "@deployments-ai/identity";

/**
 * Scopes the console requests from the `deployments-web` client: OIDC `openid`, `offline_access`
 * (in `PLATFORM_CLI_SCOPES`) for the BFF refresh token, every first-party API scope, because
 * the console fronts the whole management API and gates actions by organization role, and the
 * console-only read scopes. The privileged scopes (`managed-skills:admin`, `memory:execute`) and
 * the `email`/`profile` claim scopes are deliberately not requested.
 */
export const CONSOLE_OAUTH_SCOPES: readonly string[] = [
  "openid",
  ...PLATFORM_CLI_SCOPES,
  ...PLATFORM_CONSOLE_SCOPES,
];
