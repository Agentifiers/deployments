export interface TokenPolicy {
  readonly accessTokenSeconds: number;
  readonly idTokenSeconds: number;
  readonly issuer: string;
  readonly resourceAudience: string;
}

export const PLATFORM_CLI_SCOPES = [
  "agents:read",
  "agents:write",
  "agent-email:admin",
  "agent-email:read",
  "agent-email:write",
  "approvals:read",
  "approvals:write",
  "api-keys:read",
  "api-keys:write",
  "apps:publish",
  "apps:read",
  "apps:write",
  "artifacts:read",
  "artifacts:write",
  "audit:read",
  "brains:admin",
  "brains:create",
  "brains:read",
  "brains:write",
  "budgets:read",
  "budgets:write",
  "email:admin",
  "email:read",
  "email:write",
  "end-users:erase",
  "environments:read",
  "environments:write",
  "governance:read",
  "governance:write",
  "invitations:accept",
  "invitations:read",
  "invitations:write",
  "managed-skills:install",
  "managed-skills:read",
  "memory:admin",
  "memory:read",
  "memory:write",
  "members:read",
  "members:write",
  "models:read",
  "models:write",
  "monitors:read",
  "monitors:write",
  "offline_access",
  "observability:read",
  "observability:write",
  "organizations:read",
  "organizations:write",
  "projects:read",
  "projects:write",
  "providers:read",
  "providers:write",
  "runs:erase",
  "runs:read",
  "runs:write",
  "schedules:read",
  "schedules:write",
  "secrets:read",
  "service-accounts:read",
  "service-accounts:write",
  "spend:read",
  "tools:read",
  "tools:write",
  "usage:read",
  "webhooks:read",
  "webhooks:write",
  "workflows:execute",
  "workflows:read",
  "workflows:write",
  "workspaces:read",
  "workspaces:write",
] as const;

/**
 * Scopes the web console requests on top of the CLI's. The console shows channel bindings and
 * their deliveries but never changes them, so it asks for `channels:read` and not `channels:write`.
 */
export const PLATFORM_CONSOLE_SCOPES = ["channels:read"] as const;

export const PLATFORM_PRIVILEGED_SCOPES = ["managed-skills:admin", "memory:execute"] as const;

export const SUPPORTED_OAUTH_SCOPES = [
  "email",
  "openid",
  ...PLATFORM_CLI_SCOPES,
  ...PLATFORM_CONSOLE_SCOPES,
  ...PLATFORM_PRIVILEGED_SCOPES,
  "profile",
] as const;

export interface AccessTokenClaims {
  readonly aud: string;
  readonly client_id: string;
  /** Whether identity had verified the person's email when it minted the token. */
  readonly email_verified: boolean;
  readonly exp: number;
  readonly iat: number;
  readonly iss: string;
  readonly jti: string;
  readonly nbf: number;
  readonly scope: string;
  readonly sid: string;
  readonly sub: string;
}

export function accessTokenClaims(input: {
  readonly clientId: string;
  readonly emailVerified: boolean;
  readonly issuedAt: Date;
  readonly jti: string;
  readonly policy: TokenPolicy;
  readonly principalId: string;
  readonly scopes: readonly string[];
  readonly sessionId: string;
}): AccessTokenClaims {
  const issuedAt = Math.floor(input.issuedAt.getTime() / 1_000);
  return {
    aud: input.policy.resourceAudience,
    client_id: input.clientId,
    email_verified: input.emailVerified,
    exp: issuedAt + input.policy.accessTokenSeconds,
    iat: issuedAt,
    iss: input.policy.issuer,
    jti: input.jti,
    nbf: issuedAt,
    scope: [...new Set(input.scopes)].sort().join(" "),
    sid: input.sessionId,
    sub: input.principalId,
  };
}

/**
 * `amr` values (RFC 8176) an ID token reports. `fed` is not in the IANA registry: it says an
 * external identity provider authenticated the person and claims nothing about how, because the
 * platform does not forward the provider's own `amr`.
 */
export type AuthenticationMethodReference = "fed" | "mfa" | "otp" | "pwd";

export function idTokenClaims(input: {
  /** Undefined without a browser session; only device grants lack one, and they exclude openid. */
  readonly authenticationMethods: readonly AuthenticationMethodReference[] | undefined;
  readonly authenticationTime: Date;
  readonly clientId: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly issuedAt: Date;
  readonly nonce?: string;
  readonly policy: TokenPolicy;
  readonly principalId: string;
  readonly scopes: readonly string[];
  readonly sessionEpoch: number;
}) {
  if (!input.scopes.includes("openid")) return undefined;
  const issuedAt = Math.floor(input.issuedAt.getTime() / 1_000);
  const includeEmail = input.scopes.includes("email") && input.email !== undefined;
  const includeName = input.scopes.includes("profile") && input.displayName !== undefined;
  return {
    ...(input.authenticationMethods ? { amr: [...input.authenticationMethods] } : {}),
    aud: input.clientId,
    auth_time: Math.floor(input.authenticationTime.getTime() / 1_000),
    ...(includeEmail ? { email: input.email, email_verified: input.emailVerified ?? false } : {}),
    exp: issuedAt + input.policy.idTokenSeconds,
    iat: issuedAt,
    iss: input.policy.issuer,
    ...(includeName ? { name: input.displayName } : {}),
    ...(input.nonce ? { nonce: input.nonce } : {}),
    ...(input.clientId === "deployments-web"
      ? { "https://deployments.ai/session_epoch": input.sessionEpoch }
      : {}),
    sub: input.principalId,
  };
}

export function authorizationServerMetadata(issuer: string) {
  return {
    authorization_endpoint: `${issuer}/oauth2/authorize`,
    code_challenge_methods_supported: ["S256"],
    device_authorization_endpoint: `${issuer}/oauth2/device_authorization`,
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:device_code",
    ],
    issuer,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    revocation_endpoint: `${issuer}/oauth2/revoke`,
    revocation_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
    scopes_supported: SUPPORTED_OAUTH_SCOPES,
    token_endpoint: `${issuer}/oauth2/token`,
    token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
  };
}

export function openIdConfiguration(issuer: string) {
  return {
    ...authorizationServerMetadata(issuer),
    id_token_signing_alg_values_supported: ["RS256"],
    prompt_values_supported: ["login", "none"],
    subject_types_supported: ["public"],
  };
}
