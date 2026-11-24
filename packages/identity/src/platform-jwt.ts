import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";

/**
 * Verification of human platform bearer JWTs shared by every API surface that accepts them.
 * Signature, issuer, and audience checks happen here; tenant access is resolved by each caller
 * against live control-plane state.
 */
export type PlatformJwtClaimProfile = "cognito" | "legacy" | "platform";

export interface JwtAuthenticationOptions {
  readonly audience: string | string[];
  readonly claimProfile?: PlatformJwtClaimProfile;
  readonly issuer: string;
  readonly jwksUri?: string;
  readonly verify?: (token: string) => Promise<JWTPayload>;
}

export type PlatformJwtVerifier = (token: string) => Promise<JWTPayload>;

/** Verified identity claims; tenant claims are only present when the token carries them. */
export interface PlatformJwtClaims {
  /** Set when the issuer signed `email_verified: true`. */
  readonly emailVerified?: true;
  readonly environmentId?: string;
  readonly organizationId?: string;
  readonly principalId: string;
  readonly projectId?: string;
  readonly scopes: readonly string[];
  readonly tokenSessionId?: string;
}

export const PLATFORM_JWT_ENV = {
  audience: "DEPLOYMENTS_AI_API_JWT_AUDIENCE",
  claimProfile: "DEPLOYMENTS_AI_API_JWT_CLAIM_PROFILE",
  issuer: "DEPLOYMENTS_AI_API_JWT_ISSUER",
  jwksUri: "DEPLOYMENTS_AI_API_JWKS_URI",
} as const;

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const COGNITO_ISSUER = /^https:\/\/cognito-idp\.[^/]+\.amazonaws\.com\//u;

function ulid(value: unknown): string | undefined {
  return typeof value === "string" && ULID.test(value) ? value : undefined;
}

function claimStrings(value: unknown): readonly string[] {
  if (typeof value === "string") {
    return value
      .split(/\s+/u)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry));
}

/** Bearer values with three dot-separated segments are JWTs; anything else is an opaque key. */
export function isJwtBearerToken(token: string) {
  return token.split(".").length === 3;
}

export function resolvePlatformJwtClaimProfile(
  options: Pick<JwtAuthenticationOptions, "claimProfile" | "issuer">,
): PlatformJwtClaimProfile {
  return options.claimProfile ?? (COGNITO_ISSUER.test(options.issuer) ? "cognito" : "legacy");
}

export function createPlatformJwtVerifier(options: JwtAuthenticationOptions): PlatformJwtVerifier {
  if (options.verify) return options.verify;
  const issuer = options.issuer.replace(/\/+$/u, "");
  const jwks = createRemoteJWKSet(new URL(options.jwksUri ?? `${issuer}/.well-known/jwks.json`));
  return async (token: string) => {
    const result = await jwtVerify(token, jwks, { audience: options.audience, issuer });
    return result.payload;
  };
}

/** Verifies tokens against keys the caller already holds, as the issuer does for its own tokens. */
export function createLocalPlatformJwtVerifier(input: {
  readonly audience: string;
  readonly issuer: string;
  readonly keys: () => Promise<JSONWebKeySet>;
}): PlatformJwtVerifier {
  let keySet: Promise<ReturnType<typeof createLocalJWKSet>> | undefined;
  return async (token: string) => {
    keySet ??= input.keys().then((keys) => createLocalJWKSet(keys));
    const result = await jwtVerify(token, await keySet, {
      audience: input.audience,
      issuer: input.issuer,
    });
    return result.payload;
  };
}

export function platformJwtClaims(
  payload: JWTPayload,
  claimProfile: PlatformJwtClaimProfile,
): PlatformJwtClaims | null {
  const principalId = ulid(
    claimProfile === "cognito"
      ? payload["custom:principal_id"]
      : claimProfile === "platform"
        ? payload.sub
        : (payload.principal_id ?? payload["custom:principal_id"] ?? payload.sub),
  );
  const tenantClaim = (name: "environment_id" | "organization_id" | "project_id") =>
    claimProfile === "cognito"
      ? payload[`custom:${name}`]
      : claimProfile === "platform"
        ? payload[name]
        : (payload[name] ?? payload[`custom:${name}`]);
  const organizationClaim = tenantClaim("organization_id");
  const projectClaim = tenantClaim("project_id");
  const environmentClaim = tenantClaim("environment_id");
  const organizationId = ulid(organizationClaim);
  const projectId = ulid(projectClaim);
  const environmentId = ulid(environmentClaim);
  const tokenSessionId = ulid(payload.sid);
  const scopes =
    claimProfile === "cognito"
      ? claimStrings(payload["custom:scope"])
      : claimProfile === "platform"
        ? claimStrings(payload.scope)
        : [
            ...claimStrings(payload.scope),
            ...claimStrings(payload.scp),
            ...claimStrings(payload.capabilities),
            ...claimStrings(payload["custom:scope"]),
          ];
  if (
    !principalId ||
    scopes.length === 0 ||
    (organizationClaim !== undefined && !organizationId) ||
    (projectClaim !== undefined && !projectId) ||
    (environmentClaim !== undefined && !environmentId)
  ) {
    return null;
  }
  return {
    principalId,
    scopes: [...new Set(scopes)],
    ...(organizationId ? { organizationId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(environmentId ? { environmentId } : {}),
    ...(payload.email_verified === true ? { emailVerified: true as const } : {}),
    ...(tokenSessionId ? { tokenSessionId } : {}),
  };
}

/** Parses an audience setting: a plain audience or a non-empty JSON string array. */
export function parsePlatformJwtAudience(
  value: string,
  environmentName: string = PLATFORM_JWT_ENV.audience,
): string | string[] {
  if (!value.startsWith("[")) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${environmentName} must be a JSON string array.`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  ) {
    throw new Error(`${environmentName} must be a non-empty JSON string array.`);
  }
  return parsed;
}

/** Parses a claim-profile setting; `auto` (or unset) selects by issuer. */
export function parsePlatformJwtClaimProfile(
  value: string | undefined,
  environmentName: string = PLATFORM_JWT_ENV.claimProfile,
): PlatformJwtClaimProfile | undefined {
  const profile = value?.trim() || "auto";
  if (profile === "auto") return undefined;
  if (profile === "cognito" || profile === "legacy" || profile === "platform") return profile;
  throw new Error(`${environmentName} must be auto, cognito, legacy, or platform.`);
}

/** Reads the platform bearer JWT settings shared by the platform and runtime API functions. */
export function platformJwtOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv,
): JwtAuthenticationOptions {
  const required = (name: string) => {
    const value = environment[name]?.trim();
    if (!value) throw new Error(`${name} is required.`);
    return value;
  };
  const claimProfile = parsePlatformJwtClaimProfile(environment[PLATFORM_JWT_ENV.claimProfile]);
  const jwksUri = environment[PLATFORM_JWT_ENV.jwksUri]?.trim();
  return {
    audience: parsePlatformJwtAudience(required(PLATFORM_JWT_ENV.audience)),
    ...(claimProfile ? { claimProfile } : {}),
    issuer: required(PLATFORM_JWT_ENV.issuer),
    ...(jwksUri ? { jwksUri } : {}),
  };
}
