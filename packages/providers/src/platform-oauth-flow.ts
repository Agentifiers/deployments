import { createHash, createHmac } from "node:crypto";
import { normalizeConnectorScopes } from "./tools/connector-grants.ts";
import type { PlatformOAuthAppConfig, PlatformOAuthTokenBundle } from "./platform-oauth-types.ts";
import { PLATFORM_OAUTH_STATE_SECRET_ENV } from "./platform-oauth-types.ts";
import { isRecord, requiredText, optionalText, oauthKey } from "./platform-oauth-config.ts";

export function platformOAuthStateHash(state: string): string {
  return createHash("sha256")
    .update(requiredText(state, "OAuth state", 512))
    .digest("hex");
}

export function platformOAuthPkceVerifier(attemptId: string, stateSecret: string): string {
  return createHmac("sha256", requiredText(stateSecret, PLATFORM_OAUTH_STATE_SECRET_ENV))
    .update(`platform-oauth-pkce:${requiredText(attemptId, "OAuth attempt id", 256)}`)
    .digest("base64url");
}

export function platformOAuthCompletionToken(
  args: {
    readonly attemptId: string;
    readonly oauthProviderKey: string;
    readonly organizationId: string;
    readonly principalId: string;
    readonly state: string;
  },
  stateSecret: string,
): string {
  return createHmac("sha256", requiredText(stateSecret, PLATFORM_OAUTH_STATE_SECRET_ENV))
    .update(
      JSON.stringify([
        "platform-oauth-completion",
        requiredText(args.attemptId, "OAuth attempt id", 256),
        oauthKey(args.oauthProviderKey, "OAuth provider key"),
        requiredText(args.organizationId, "OAuth organization id", 256),
        requiredText(args.principalId, "OAuth principal id", 256),
        platformOAuthStateHash(args.state),
      ]),
    )
    .digest("base64url");
}

export function platformOAuthPkceChallenge(verifier: string): string {
  return createHash("sha256")
    .update(requiredText(verifier, "PKCE verifier", 256))
    .digest("base64url");
}

export const RESERVED_AUTHORIZATION_PARAMS = new Set([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "resource",
  "response_type",
  "scope",
  "state",
]);

export function platformOAuthAuthorizationUrl(args: {
  readonly app: PlatformOAuthAppConfig;
  readonly resource?: string;
  readonly scopes: readonly string[];
  readonly state: string;
  readonly verifier: string;
}): string {
  const canonicalResource =
    args.app.resourceMode === "canonical_uri"
      ? platformOAuthCanonicalResource(args.app, args.resource)
      : undefined;
  const resource =
    args.resource && args.app.resourceMode !== "canonical_uri"
      ? new URL(requiredText(args.resource, "OAuth resource", 2_048))
      : undefined;
  if (
    resource &&
    (resource.href !== `${resource.origin}/` ||
      !platformOAuthResourceAllowed(args.app, resource.origin))
  ) {
    throw new Error("OAuth resource is not allowed for this application.");
  }
  const url =
    resource && args.app.resourceMode === "endpoint_origin"
      ? platformOAuthEndpointAtResource(args.app.authorizationEndpoint, resource.origin)
      : new URL(args.app.authorizationEndpoint);
  const reservedAuthorizationParams = new Set([
    ...RESERVED_AUTHORIZATION_PARAMS,
    args.app.authorizationClientIdParameterName,
  ]);
  for (const [key, value] of Object.entries(args.app.authorizationParams)) {
    if (reservedAuthorizationParams.has(key)) {
      throw new Error(`OAuth authorization parameter ${key} is reserved.`);
    }
    url.searchParams.set(key, value);
  }
  url.searchParams.set(args.app.authorizationClientIdParameterName, args.app.clientId);
  if (args.app.authorizationIncludesRedirectUri) {
    url.searchParams.set("redirect_uri", args.app.redirectUri);
  }
  if (args.app.authorizationIncludesResponseType) {
    url.searchParams.set("response_type", "code");
  }
  url.searchParams.set("state", requiredText(args.state, "OAuth state", 512));
  if (resource && args.app.resourceMode === "parameter") {
    if (resource.href !== `${resource.origin}/`) {
      throw new Error("OAuth resource is not allowed for this application.");
    }
    url.searchParams.set("resource", resource.origin);
  }
  if (canonicalResource) url.searchParams.set("resource", canonicalResource);
  const scopes = normalizeConnectorScopes(args.scopes);
  if (args.app.authorizationIncludesScope && scopes.length > 0) {
    url.searchParams.set("scope", scopes.join(args.app.scopeSeparator === "comma" ? "," : " "));
  }
  if (args.app.pkce) {
    url.searchParams.set("code_challenge", platformOAuthPkceChallenge(args.verifier));
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

export function platformOAuthResourceAllowed(
  app: Pick<PlatformOAuthAppConfig, "allowedResourceHostSuffixes" | "allowedResources"> &
    Partial<Pick<PlatformOAuthAppConfig, "resourceMode">>,
  resource: string,
): boolean {
  if (app.resourceMode === "canonical_uri") {
    return canonicalResourceShape(resource) && app.allowedResources.includes(resource);
  }
  let origin: URL;
  try {
    origin = new URL(resource);
  } catch {
    return false;
  }
  const local = origin.hostname === "localhost" || origin.hostname === "127.0.0.1";
  if (
    (origin.protocol !== "https:" && !(local && origin.protocol === "http:")) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    (origin.pathname !== "/" && origin.pathname !== "")
  ) {
    return false;
  }
  if (app.allowedResources.includes(origin.origin)) return true;
  const hostname = origin.hostname.toLowerCase().replace(/\.$/u, "");
  return app.allowedResourceHostSuffixes.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

/** Exact HTTPS URI (path allowed) without credentials or fragment. */
function canonicalResourceShape(resource: string): boolean {
  if (resource.includes("#")) return false;
  try {
    const url = new URL(resource);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Resource sent verbatim (`resource=<exact uri>`) on authorize, token, and refresh
 * requests for `canonical_uri` apps. It must be one of the app's allowed resources;
 * no case, slash, or percent-encoding normalization is applied.
 */
export function platformOAuthCanonicalResource(
  app: Pick<
    PlatformOAuthAppConfig,
    "allowedResourceHostSuffixes" | "allowedResources" | "resourceMode"
  >,
  resource: string | undefined,
): string {
  if (app.resourceMode !== "canonical_uri") {
    throw new Error("OAuth app does not use canonical resource URIs.");
  }
  if (resource === undefined || !platformOAuthResourceAllowed(app, resource)) {
    throw new Error("OAuth resource is not allowed for this application.");
  }
  return resource;
}

/**
 * RFC 9207 authorization response validation as profiled by MCP 2026-07-28: a present
 * `iss` is always compared to the recorded issuer by simple string comparison; an absent
 * `iss` is rejected only when the authorization server advertises support.
 */
export function platformOAuthIssValidation(args: {
  readonly expectedIssuer: string;
  readonly issParameterSupported: boolean;
  readonly receivedIss: string | undefined;
}): "accept" | "reject" {
  if (args.receivedIss !== undefined) {
    return args.receivedIss === args.expectedIssuer ? "accept" : "reject";
  }
  return args.issParameterSupported ? "reject" : "accept";
}

export function platformOAuthEndpointAtResource(endpoint: string, resource: string): URL {
  const configured = new URL(endpoint);
  const origin = new URL(resource);
  const local = origin.hostname === "localhost" || origin.hostname === "127.0.0.1";
  if (
    (origin.protocol !== "https:" && !(local && origin.protocol === "http:")) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    (origin.pathname !== "/" && origin.pathname !== "")
  ) {
    throw new Error("OAuth resource must be an HTTPS origin.");
  }
  return new URL(`${configured.pathname}${configured.search}`, `${origin.origin}/`);
}

export function parsePlatformOAuthTokenResponse(
  value: unknown,
  now = Date.now(),
): PlatformOAuthTokenBundle {
  if (!isRecord(value)) throw new Error("OAuth token response must be an object.");
  const accessToken = requiredText(value.access_token ?? value.accessToken, "OAuth access token");
  const refreshToken = optionalText(
    value.refresh_token ?? value.refreshToken,
    "OAuth refresh token",
  );
  const tokenType = optionalText(value.token_type ?? value.tokenType, "OAuth token type", 128);
  const rawExpiresIn = value.expires_in ?? value.expiresIn;
  let expiresAt: number | undefined;
  if (rawExpiresIn !== undefined && rawExpiresIn !== null) {
    const expiresIn = typeof rawExpiresIn === "string" ? Number(rawExpiresIn) : rawExpiresIn;
    if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error("OAuth token expires_in is invalid.");
    }
    expiresAt = now + expiresIn * 1_000;
  }
  const rawScope = value.scope ?? value.scopes;
  const scopes = normalizeConnectorScopes(
    Array.isArray(rawScope)
      ? rawScope.flatMap((scope) =>
          typeof scope === "string"
            ? [scope]
            : typeof scope === "number" && Number.isFinite(scope)
              ? [String(scope)]
              : [],
        )
      : typeof rawScope === "string"
        ? rawScope.split(/[ ,]+/u)
        : [],
  );
  const rawAuthorizedAccountIds = value.authorized_account_ids ?? value.authorizedAccountIds;
  const authorizedAccountIds = normalizeConnectorScopes(
    Array.isArray(rawAuthorizedAccountIds)
      ? rawAuthorizedAccountIds.flatMap((accountId) =>
          typeof accountId === "string"
            ? [accountId]
            : typeof accountId === "number" && Number.isFinite(accountId)
              ? [String(accountId)]
              : [],
        )
      : [],
  );
  return Object.freeze({
    accessToken,
    ...(authorizedAccountIds.length > 0 ? { authorizedAccountIds } : {}),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(refreshToken ? { refreshToken } : {}),
    scopes,
    ...(tokenType ? { tokenType } : {}),
  });
}
