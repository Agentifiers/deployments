/**
 * Code-owned pins for vendor-hosted remote MCP servers (route `vendor_mcp`).
 *
 * The pinned values are reviewed against live discovery (RFC 9728 protected
 * resource metadata, RFC 8414 / OIDC authorization server metadata) and are
 * compared on every authorization begin; any mismatch is drift and fails closed.
 */

export const VENDOR_MCP_REGISTRATION_METHODS = [
  /** Operator-registered provider application (`deployments oauth-app register`). */
  "pre_registered",
  /** `client_id` is the environment CIMD URL; token endpoint auth `none`. */
  "client_id_metadata_document",
  /** RFC 7591; persisted as a provider-application with a dynamic registration. */
  "dynamic_client_registration",
] as const;

export type VendorMcpRegistrationMethod = (typeof VENDOR_MCP_REGISTRATION_METHODS)[number];

export const VENDOR_MCP_TOOL_EFFECTS = ["read", "write", "destructive"] as const;

export type VendorMcpToolEffect = (typeof VENDOR_MCP_TOOL_EFFECTS)[number];

export const VENDOR_MCP_TOKEN_ENDPOINT_AUTH_METHODS = [
  "none",
  "client_secret_basic",
  "client_secret_post",
] as const;

export type VendorMcpTokenEndpointAuthMethod =
  (typeof VENDOR_MCP_TOKEN_ENDPOINT_AUTH_METHODS)[number];

/** Capability scopes every vendor MCP connection grants (read-only and mutating tools). */
export const VENDOR_MCP_CAPABILITY_SCOPES = ["tools:read", "tools:write"] as const;

export type VendorMcpCapabilityScope = (typeof VENDOR_MCP_CAPABILITY_SCOPES)[number];

/** Only supported template placeholder; it must be one whole host label. */
export const VENDOR_MCP_TENANT_PLACEHOLDER = "{tenant}";

/** Public CIMD path served by the channel API OAuth Lambda. */
export const VENDOR_MCP_CLIENT_METADATA_PATH =
  "/public/provider-connections/oauth/client-metadata.json";

export interface VendorMcpOAuthAuthorization {
  readonly kind: "oauth";
  /**
   * The authorization server metadata `issuer`, verbatim; may contain `{tenant}` when the
   * server url is templated. Literal non-template path braces (Microsoft's `{tenantid}`)
   * are allowed only with `authorizationServerMetadataUrl`.
   */
  readonly issuer: string;
  /**
   * Reviewed exception: fetch authorization server metadata from this exact URL instead of
   * RFC 8414 / OIDC well-known locations derived from the issuer; the metadata `issuer`
   * is then compared verbatim.
   */
  readonly authorizationServerMetadataUrl?: string;
  /**
   * Identifier the protected resource metadata lists in `authorization_servers` when it
   * differs from `issuer` (for example Microsoft `organizations/v2.0`). Requires published
   * protected resource metadata and `authorizationServerMetadataUrl`.
   */
  readonly protectedResourceAuthorizationServer?: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  /** RFC 7009 revocation endpoint. */
  readonly revocationEndpoint?: string;
  /** Allowed registration set; the runtime applies the MCP spec priority. */
  readonly registrationMethods: readonly VendorMcpRegistrationMethod[];
  readonly tokenEndpointAuthMethods: readonly VendorMcpTokenEndpointAuthMethod[];
  /** Scopes requested at authorization. */
  readonly scopes: readonly string[];
  /** RFC 9207 `authorization_response_iss_parameter_supported`. */
  readonly issParameterSupported: boolean;
  /** `absent` = legacy server; authorization server metadata at the pinned issuer only. */
  readonly protectedResourceMetadata: "published" | "absent";
}

export interface VendorMcpApiKeyAuthorization {
  readonly kind: "api_key";
  /** Auth field key holding the key. */
  readonly field: string;
  /** Lowercase header name, for example `authorization`. */
  readonly headerName: string;
  readonly scheme?: "Bearer";
}

export interface VendorMcpTenantTemplate {
  /** Human label for the tenant value, for example "Atlassian site name". */
  readonly label: string;
  readonly hostSuffixes: readonly string[];
}

export interface VendorMcpServerDefinition {
  /** Canonical MCP URI (== RFC 8707 resource); may contain `{tenant}` in the host. */
  readonly url: string;
  /** Required iff `url` is templated. */
  readonly tenant?: VendorMcpTenantTemplate;
  /** RFC 9728 protected resource metadata `resource`; usually equal to `url`. */
  readonly resource: string;
  readonly authorization: VendorMcpOAuthAuthorization | VendorMcpApiKeyAuthorization;
  readonly documentationUrl: string;
  /** YYYY-MM-DD of the last pin review. */
  readonly reviewedAt: string;
  /** Remote tool name -> effect. Unclassified tools are treated as writes. */
  readonly toolEffects: Readonly<Record<string, VendorMcpToolEffect>>;
}

/** Catalog input shape; validated and frozen by provider normalization. */
export type VendorMcpServerDefinitionInput = VendorMcpServerDefinition;

/** Live discovery result compared against the pins by `vendorMcpAuthorizationDrift`. */
export interface VendorMcpDiscoveredAuthorization {
  readonly protectedResource?: {
    readonly resource: string;
    readonly authorizationServers: readonly string[];
    readonly scopesSupported?: readonly string[];
  };
  readonly authorizationServer: {
    readonly issuer: string;
    readonly authorizationEndpoint: string;
    readonly tokenEndpoint: string;
    readonly registrationEndpoint?: string;
    readonly revocationEndpoint?: string;
    readonly clientIdMetadataDocumentSupported: boolean;
    readonly codeChallengeMethodsSupported: readonly string[];
    readonly tokenEndpointAuthMethodsSupported: readonly string[];
    readonly authorizationResponseIssParameterSupported: boolean;
  };
}
