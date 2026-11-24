import type { ProviderDefinition } from "./provider-definition-types.ts";
import type {
  VendorMcpDiscoveredAuthorization,
  VendorMcpOAuthAuthorization,
  VendorMcpServerDefinition,
} from "./vendor-mcp-types.ts";
import {
  VendorMcpConfigurationError,
  vendorMcpIsTemplated,
  vendorMcpSubstitute,
  vendorMcpTemplateTenant,
} from "./vendor-mcp-template.ts";
import { vendorMcpServer } from "./vendor-mcp-tools.ts";

function invalidResource(message: string): VendorMcpConfigurationError {
  return new VendorMcpConfigurationError("invalid_mcp_resource", message);
}

/**
 * Canonical MCP URI (RFC 8707 resource) for a connection. Static servers return the
 * pinned url; templated servers require `requestedResource` to be exactly the template
 * with one valid tenant label on an allowed host suffix.
 */
export function vendorMcpCanonicalUrl(
  definition: ProviderDefinition,
  requestedResource?: string,
): string {
  const server = vendorMcpServer(definition);
  if (!vendorMcpIsTemplated(server.url)) {
    if (requestedResource !== undefined && requestedResource !== server.url) {
      throw invalidResource(`MCP resource must be ${server.url}.`);
    }
    return server.url;
  }
  if (requestedResource === undefined) {
    throw invalidResource(`MCP resource is required for ${server.tenant?.label ?? "this tenant"}.`);
  }
  if (vendorMcpTemplateTenant(server.url, requestedResource) === undefined) {
    throw invalidResource(`MCP resource must match ${server.url}.`);
  }
  const hostname = new URL(requestedResource).hostname;
  if (!server.tenant?.hostSuffixes.some((suffix) => hostname.endsWith(`.${suffix}`))) {
    throw invalidResource("MCP resource host is not on an allowed tenant host suffix.");
  }
  return requestedResource;
}

/** Tenant label of a canonical url for a templated server; undefined for static servers. */
export function vendorMcpTenant(
  definition: ProviderDefinition,
  canonicalUrl: string,
): string | undefined {
  const server = vendorMcpServer(definition);
  if (!vendorMcpIsTemplated(server.url)) return undefined;
  const tenant = vendorMcpTemplateTenant(server.url, canonicalUrl);
  if (tenant === undefined) throw invalidResource(`MCP resource must match ${server.url}.`);
  return tenant;
}

/**
 * RFC 8707 resource (token audience) for a connection: the pinned protected-resource
 * `resource`, tenant-substituted. Vendors often publish their origin as the resource while
 * serving MCP on a path, so this can differ from the canonical endpoint url.
 */
export function vendorMcpResource(definition: ProviderDefinition, canonicalUrl: string): string {
  const endpoint = vendorMcpCanonicalUrl(definition, canonicalUrl);
  return vendorMcpSubstitute(
    vendorMcpServer(definition).resource,
    vendorMcpTenant(definition, endpoint),
  );
}

export function vendorMcpOAuthPins(definition: ProviderDefinition): {
  readonly authorization: VendorMcpOAuthAuthorization;
  readonly server: VendorMcpServerDefinition;
} {
  const server = vendorMcpServer(definition);
  if (server.authorization.kind !== "oauth") {
    throw new VendorMcpConfigurationError(
      "invalid_mcp_definition",
      `Provider ${definition.key} does not use OAuth for its MCP server.`,
    );
  }
  return { authorization: server.authorization, server };
}

const ROOT_IDENTIFIER_PATTERN = /^(https:\/\/[^/?#@]+)\/?$/u;

/**
 * Authorization server identifier comparison: identical strings, or the same https
 * origin where both paths are empty or "/" (`https://accounts.google.com/` ≡
 * `https://accounts.google.com`). No other normalization is applied.
 */
export function vendorMcpIssuerEquivalent(left: string, right: string): boolean {
  if (left === right) return true;
  const leftOrigin = ROOT_IDENTIFIER_PATTERN.exec(left)?.[1];
  return leftOrigin !== undefined && leftOrigin === ROOT_IDENTIFIER_PATTERN.exec(right)?.[1];
}

export interface VendorMcpDiscoveryInput {
  /** Canonical MCP URI probed for protected resource metadata. */
  readonly mcpUrl: string;
  readonly protectedResourceMetadata: "published" | "absent";
  /**
   * Authorization server identifier to select from PRM `authorization_servers`
   * (`protectedResourceAuthorizationServer ?? issuer`); with absent PRM it is the issuer
   * whose well-known metadata is fetched.
   */
  readonly pinnedIssuer: string;
  /** Exact metadata URL to fetch instead of well-known locations (reviewed exception). */
  readonly authorizationServerMetadataUrl?: string;
  /** Verbatim metadata `issuer` required when `authorizationServerMetadataUrl` is used. */
  readonly expectedIssuer?: string;
}

/** Substituted discovery parameters shared by authorization begin and conformance. */
export function vendorMcpDiscoveryInput(
  definition: ProviderDefinition,
  canonicalUrl: string,
): VendorMcpDiscoveryInput {
  const { authorization } = vendorMcpOAuthPins(definition);
  const mcpUrl = vendorMcpCanonicalUrl(definition, canonicalUrl);
  const tenant = vendorMcpTenant(definition, mcpUrl);
  const issuer = vendorMcpSubstitute(authorization.issuer, tenant);
  return Object.freeze({
    mcpUrl,
    protectedResourceMetadata: authorization.protectedResourceMetadata,
    pinnedIssuer: vendorMcpSubstitute(
      authorization.protectedResourceAuthorizationServer ?? authorization.issuer,
      tenant,
    ),
    ...(authorization.authorizationServerMetadataUrl
      ? {
          authorizationServerMetadataUrl: vendorMcpSubstitute(
            authorization.authorizationServerMetadataUrl,
            tenant,
          ),
          expectedIssuer: issuer,
        }
      : {}),
  });
}

/**
 * Human-readable differences between live discovery and the pinned authorization
 * profile. Empty means the pins still hold; any entry must fail closed.
 */
export function vendorMcpAuthorizationDrift(
  definition: ProviderDefinition,
  canonicalUrl: string,
  discovered: VendorMcpDiscoveredAuthorization,
): readonly string[] {
  const { authorization, server } = vendorMcpOAuthPins(definition);
  const discovery = vendorMcpDiscoveryInput(definition, canonicalUrl);
  const tenant = vendorMcpTenant(definition, discovery.mcpUrl);
  const issuer = vendorMcpSubstitute(authorization.issuer, tenant);
  const drift: string[] = [];
  const prm = discovered.protectedResource;
  if (!prm && authorization.protectedResourceMetadata === "published") {
    drift.push("Protected resource metadata is pinned as published but was not found.");
  }
  if (prm) {
    const resource = vendorMcpSubstitute(server.resource, tenant);
    if (prm.resource !== resource) {
      drift.push(`Protected resource is ${prm.resource}; pinned ${resource}.`);
    }
    const listed = discovery.pinnedIssuer;
    if (!prm.authorizationServers.some((entry) => vendorMcpIssuerEquivalent(entry, listed))) {
      drift.push(
        `Protected resource authorization_servers do not include pinned authorization server ${listed}.`,
      );
    }
  }
  const as = discovered.authorizationServer;
  const issuerMatches = discovery.authorizationServerMetadataUrl
    ? as.issuer === issuer
    : vendorMcpIssuerEquivalent(as.issuer, issuer);
  if (!issuerMatches) {
    drift.push(`Authorization server issuer is ${as.issuer}; pinned ${issuer}.`);
  }
  const endpoints = [
    ["authorization_endpoint", as.authorizationEndpoint, authorization.authorizationEndpoint],
    ["token_endpoint", as.tokenEndpoint, authorization.tokenEndpoint],
    ["revocation_endpoint", as.revocationEndpoint, authorization.revocationEndpoint],
  ] as const;
  for (const [name, actual, pinned] of endpoints) {
    if (pinned === undefined) continue;
    const expected = vendorMcpSubstitute(pinned, tenant);
    if (actual !== expected) {
      drift.push(`Authorization server ${name} is ${actual ?? "absent"}; pinned ${expected}.`);
    }
  }
  if (!as.codeChallengeMethodsSupported.includes("S256")) {
    drift.push("Authorization server does not advertise PKCE S256.");
  }
  const usableRegistration = authorization.registrationMethods.some(
    (method) =>
      method === "pre_registered" ||
      (method === "client_id_metadata_document" && as.clientIdMetadataDocumentSupported) ||
      (method === "dynamic_client_registration" && as.registrationEndpoint !== undefined),
  );
  if (!usableRegistration) {
    drift.push(
      `Authorization server supports none of the pinned registration methods: ${authorization.registrationMethods.join(", ")}.`,
    );
  }
  if (as.authorizationResponseIssParameterSupported !== authorization.issParameterSupported) {
    drift.push(
      `Authorization server authorization_response_iss_parameter_supported is ${String(as.authorizationResponseIssParameterSupported)}; pinned ${String(authorization.issParameterSupported)}.`,
    );
  }
  return Object.freeze(drift);
}
