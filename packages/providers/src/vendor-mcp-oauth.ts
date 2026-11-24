import type { PlatformOAuthAppConfig } from "./platform-oauth-types.ts";
import type { ProviderDefinition } from "./provider-definition-types.ts";
import type { VendorMcpTokenEndpointAuthMethod } from "./vendor-mcp-types.ts";
import { VENDOR_MCP_CLIENT_METADATA_PATH } from "./vendor-mcp-types.ts";
import { VendorMcpConfigurationError, vendorMcpSubstitute } from "./vendor-mcp-template.ts";
import {
  vendorMcpCanonicalUrl,
  vendorMcpOAuthPins,
  vendorMcpTenant,
  vendorMcpResource,
} from "./vendor-mcp-authorization.ts";

const CALLBACK_PATH_PREFIX = "/public/provider-connections/oauth/callback/";

/** Exact HTTPS origin of the channel API that serves callbacks and the CIMD document. */
function publicOriginOf(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new VendorMcpConfigurationError(
      "invalid_mcp_definition",
      "Public OAuth origin must be an absolute HTTPS origin.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    (value !== url.origin && value !== `${url.origin}/`)
  ) {
    throw new VendorMcpConfigurationError(
      "invalid_mcp_definition",
      "Public OAuth origin must be an absolute HTTPS origin.",
    );
  }
  return url.origin;
}

function redirectUri(publicOrigin: string, definition: ProviderDefinition): string {
  if (!definition.oauthProviderKey) {
    throw new VendorMcpConfigurationError(
      "invalid_mcp_definition",
      `Provider ${definition.key} has no OAuth provider key.`,
    );
  }
  return `${publicOrigin}${CALLBACK_PATH_PREFIX}${definition.oauthProviderKey}`;
}

/**
 * Synthesize the OAuth app protocol for a vendor MCP connection from code-owned pins.
 * The pinned, tenant-substituted protected-resource `resource` (`vendorMcpResource`) is
 * the only allowed RFC 8707 resource and is sent verbatim on authorization, token, and
 * refresh requests. Callers request `mcpServer.authorization.scopes`; identity comes from
 * the token response `sub` when present (no identity endpoint).
 */
export function vendorMcpOAuthAppConfig(input: {
  readonly definition: ProviderDefinition;
  readonly canonicalUrl: string;
  readonly clientId: string;
  readonly clientAuthentication: VendorMcpTokenEndpointAuthMethod;
  readonly publicOrigin: string;
}): PlatformOAuthAppConfig {
  const { authorization } = vendorMcpOAuthPins(input.definition);
  const canonicalUrl = vendorMcpCanonicalUrl(input.definition, input.canonicalUrl);
  const tenant = vendorMcpTenant(input.definition, canonicalUrl);
  if (!authorization.tokenEndpointAuthMethods.includes(input.clientAuthentication)) {
    throw new VendorMcpConfigurationError(
      "invalid_mcp_definition",
      `Token endpoint auth method ${input.clientAuthentication} is not pinned for ${input.definition.key}.`,
    );
  }
  const clientId = input.clientId.trim();
  if (!clientId || clientId !== input.clientId) {
    throw new VendorMcpConfigurationError("invalid_mcp_definition", "OAuth client id is invalid.");
  }
  const revocationEndpoint = authorization.revocationEndpoint
    ? vendorMcpSubstitute(authorization.revocationEndpoint, tenant)
    : undefined;
  return Object.freeze({
    allowedResources: Object.freeze([vendorMcpResource(input.definition, canonicalUrl)]),
    allowedResourceHostSuffixes: Object.freeze([]),
    authorizationClientIdParameterName: "client_id",
    authorizationEndpoint: vendorMcpSubstitute(authorization.authorizationEndpoint, tenant),
    authorizationIncludesRedirectUri: true,
    authorizationIncludesResponseType: true,
    authorizationIncludesScope: true,
    authorizationParams: Object.freeze({}),
    callbackCodeParameterName: "code",
    clientAuthentication: input.clientAuthentication,
    clientId,
    identityClientAuthentication: "none",
    identityBodyFormat: "form",
    identityCredentialPlacement: "bearer",
    identityHeaders: Object.freeze({}),
    identityMethod: "GET",
    identityParameterName: "access_token",
    identityParams: Object.freeze({}),
    identityScopesRequired: false,
    identityScopeSeparator: "space",
    issuer: vendorMcpSubstitute(authorization.issuer, tenant),
    issParameterSupported: authorization.issParameterSupported,
    pkce: true,
    providerRequestHeaders: Object.freeze({}),
    redirectUri: redirectUri(publicOriginOf(input.publicOrigin), input.definition),
    refreshParams: Object.freeze({}),
    requestedScopesFallback: true,
    refreshTokenRequired: false,
    refreshTokenRotationRequired: false,
    resourceMode: "canonical_uri",
    ...(revocationEndpoint
      ? {
          revocation: Object.freeze({
            mode: "request" as const,
            additionalCredentials: Object.freeze([]),
            alreadyRevokedJsonValues: Object.freeze([]),
            bodyFormat: "form" as const,
            clientIdParameterName: "client_id",
            clientAuthentication: input.clientAuthentication,
            clientSecretParameterName: "client_secret",
            credential: "refresh_token" as const,
            credentialPlacement: "body" as const,
            endpoint: revocationEndpoint,
            endpointFromResource: false,
            impact: "token" as const,
            includeClientId: input.clientAuthentication === "none",
            method: "POST" as const,
            parameterName: "token",
            params: Object.freeze({ token_type_hint: "refresh_token" }),
          }),
        }
      : {}),
    scopeImplications: Object.freeze({}),
    scopeSeparator: "space",
    tokenAuthorizationCodeParameterName: "code",
    tokenBodyFormat: "form",
    tokenClientIdParameterName: "client_id",
    tokenClientSecretParameterName: "client_secret",
    tokenEndpoint: vendorMcpSubstitute(authorization.tokenEndpoint, tenant),
    tokenHeaders: Object.freeze({}),
    tokenIncludesGrantType: true,
    tokenIncludesRedirectUri: true,
    tokenIdentityIdPaths: Object.freeze(["sub"]),
    tokenParams: Object.freeze({}),
  });
}

/** Environment client ID metadata document URL (also the CIMD `client_id`). */
export function vendorMcpClientMetadataUrl(publicOrigin: string): string {
  return `${publicOriginOf(publicOrigin)}${VENDOR_MCP_CLIENT_METADATA_PATH}`;
}

/**
 * OAuth Client ID Metadata Document served at `VENDOR_MCP_CLIENT_METADATA_PATH`, listing
 * the callback of every vendor MCP OAuth provider.
 */
export function vendorMcpClientMetadataDocument(input: {
  readonly publicOrigin: string;
  readonly definitions: readonly ProviderDefinition[];
}): Readonly<Record<string, unknown>> {
  const publicOrigin = publicOriginOf(input.publicOrigin);
  const redirectUris = [
    ...new Set(
      input.definitions
        .filter(
          (definition) =>
            definition.route === "vendor_mcp" &&
            definition.mcpServer?.authorization.kind === "oauth",
        )
        .map((definition) => redirectUri(publicOrigin, definition)),
    ),
  ].toSorted();
  return Object.freeze({
    client_id: vendorMcpClientMetadataUrl(publicOrigin),
    client_name: "Deployments.ai",
    client_uri: "https://deployments.ai",
    redirect_uris: Object.freeze(redirectUris),
    grant_types: Object.freeze(["authorization_code", "refresh_token"]),
    response_types: Object.freeze(["code"]),
    token_endpoint_auth_method: "none",
    application_type: "web",
  });
}
