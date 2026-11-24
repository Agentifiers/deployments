import type {
  ProviderAuthDefinition,
  ProviderDefinitionInput,
  ProviderRoute,
  ProviderVerificationDefinition,
} from "./provider-definition-types.ts";
import { AUTH_FIELD_KEY_PATTERN } from "./provider-definition-types.ts";
import {
  freezeDeepArray,
  isPlainRecord,
  normalizeProviderApiHost,
  normalizeProviderApiHosts,
  normalizeProviderDefaultScopes,
  requireNonEmptyText,
} from "./provider-key-schema-normalization.ts";
import type {
  VendorMcpApiKeyAuthorization,
  VendorMcpOAuthAuthorization,
  VendorMcpServerDefinition,
  VendorMcpServerDefinitionInput,
  VendorMcpTenantTemplate,
  VendorMcpToolEffect,
} from "./vendor-mcp-types.ts";
import {
  VENDOR_MCP_CAPABILITY_SCOPES,
  VENDOR_MCP_REGISTRATION_METHODS,
  VENDOR_MCP_TENANT_PLACEHOLDER,
  VENDOR_MCP_TOKEN_ENDPOINT_AUTH_METHODS,
  VENDOR_MCP_TOOL_EFFECTS,
} from "./vendor-mcp-types.ts";
import { vendorMcpIsTemplated } from "./vendor-mcp-template.ts";

const MAX_URL_LENGTH = 2_048;
const MAX_TOOL_NAME_LENGTH = 256;
const HEADER_NAME_PATTERN = /^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/u;
const SCOPE_TOKEN_PATTERN = /^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/u;
/** Headers owned by the MCP Streamable HTTP transport itself. */
const RESERVED_API_KEY_HEADERS: Readonly<Record<string, true>> = {
  accept: true,
  "content-length": true,
  "content-type": true,
  host: true,
  "last-event-id": true,
  "mcp-protocol-version": true,
  "mcp-session-id": true,
};

/**
 * Validate one pinned HTTPS URL. `{tenant}` may only appear as one whole host label
 * and only when `allowTemplate` is set; fragments and credentials are rejected.
 * `allowLiteralPathBraces` admits verbatim non-template path segments such as
 * Microsoft's published `{tenantid}` issuer. The exact pinned string is preserved
 * (no trailing-slash or case normalization).
 */
function pinnedUrl(
  value: unknown,
  label: string,
  options: {
    readonly allowTemplate: boolean;
    readonly allowQuery: boolean;
    readonly allowLiteralPathBraces?: boolean;
  },
): string {
  if (typeof value !== "string" || value.trim() !== value || !value) {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace.`);
  }
  if (value.length > MAX_URL_LENGTH) throw new Error(`${label} is too long.`);
  const authorityMatch = /^https:\/\/([^/?#]+)([^#]*)$/u.exec(value);
  if (!authorityMatch) {
    throw new Error(`${label} must be an absolute https URL without a fragment.`);
  }
  const authority = authorityMatch[1]!;
  const rest = authorityMatch[2]!;
  const checkedForBraces = (options.allowLiteralPathBraces ? authority : value).replaceAll(
    VENDOR_MCP_TENANT_PLACEHOLDER,
    "",
  );
  if (checkedForBraces.includes("{") || checkedForBraces.includes("}")) {
    throw new Error(`${label} may only use the {tenant} placeholder.`);
  }
  if (vendorMcpIsTemplated(value)) {
    if (!options.allowTemplate) {
      throw new Error(`${label} may only use {tenant} when the MCP server url is templated.`);
    }
    const labels = authority.split(".");
    if (
      rest.includes(VENDOR_MCP_TENANT_PLACEHOLDER) ||
      authority.includes("@") ||
      authority.includes(":") ||
      labels.filter((entry) => entry === VENDOR_MCP_TENANT_PLACEHOLDER).length !== 1 ||
      labels.some((entry) => entry !== VENDOR_MCP_TENANT_PLACEHOLDER && entry.includes("{"))
    ) {
      throw new Error(`${label} must use {tenant} exactly once as a whole host label.`);
    }
  }
  let url: URL;
  try {
    url = new URL(value.replaceAll(VENDOR_MCP_TENANT_PLACEHOLDER, "tenant"));
  } catch {
    throw new Error(`${label} must be an absolute https URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${label} must be an https URL without credentials or fragment.`);
  }
  if (!options.allowQuery && url.search) {
    throw new Error(`${label} must not include a query.`);
  }
  return value;
}

function uniqueSubset<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): readonly T[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array.`);
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !(allowed as readonly string[]).includes(entry)) {
      throw new Error(`${label} contains unsupported value ${String(entry)}.`);
    }
    if (seen.has(entry)) throw new Error(`${label} contains duplicate value ${entry}.`);
    seen.add(entry);
  }
  return freezeDeepArray(allowed.filter((entry) => seen.has(entry)));
}

function normalizeTenant(
  value: unknown,
  url: string,
  templated: boolean,
): VendorMcpTenantTemplate | undefined {
  if (!templated) {
    if (value !== undefined) {
      throw new Error("MCP server tenant is only valid when the url contains {tenant}.");
    }
    return undefined;
  }
  if (!isPlainRecord(value)) {
    throw new Error("A templated MCP server url requires tenant with hostSuffixes.");
  }
  const hostSuffixes = normalizeProviderApiHosts(
    Array.isArray(value.hostSuffixes) ? (value.hostSuffixes as string[]) : undefined,
  );
  if (hostSuffixes.length === 0) {
    throw new Error("A templated MCP server url requires non-empty tenant hostSuffixes.");
  }
  const sampleHost = new URL(url.replaceAll(VENDOR_MCP_TENANT_PLACEHOLDER, "tenant")).hostname;
  if (!hostSuffixes.some((suffix) => sampleHost.endsWith(`.${suffix}`))) {
    throw new Error("MCP server url template host must end with a declared tenant host suffix.");
  }
  return Object.freeze({
    label: requireNonEmptyText(value.label as string, "MCP server tenant label", 120),
    hostSuffixes,
  });
}

function normalizeOAuthAuthorization(
  input: Record<string, unknown>,
  templated: boolean,
): VendorMcpOAuthAuthorization {
  const endpoint = { allowTemplate: templated, allowQuery: true };
  const registrationMethods = uniqueSubset(
    input.registrationMethods,
    VENDOR_MCP_REGISTRATION_METHODS,
    "MCP authorization registrationMethods",
  );
  const tokenEndpointAuthMethods = uniqueSubset(
    input.tokenEndpointAuthMethods,
    VENDOR_MCP_TOKEN_ENDPOINT_AUTH_METHODS,
    "MCP authorization tokenEndpointAuthMethods",
  );
  if (
    registrationMethods.includes("client_id_metadata_document") &&
    !tokenEndpointAuthMethods.includes("none")
  ) {
    throw new Error("Client ID metadata document registration requires token auth method none.");
  }
  if (!Array.isArray(input.scopes)) throw new Error("MCP authorization scopes must be an array.");
  const scopes: string[] = [];
  for (const scope of input.scopes) {
    if (typeof scope !== "string" || !SCOPE_TOKEN_PATTERN.test(scope)) {
      throw new Error(`MCP authorization scope ${String(scope)} is invalid.`);
    }
    if (scopes.includes(scope)) throw new Error(`MCP authorization scope ${scope} is duplicated.`);
    scopes.push(scope);
  }
  if (typeof input.issParameterSupported !== "boolean") {
    throw new Error("MCP authorization issParameterSupported must be a boolean.");
  }
  if (
    input.protectedResourceMetadata !== "published" &&
    input.protectedResourceMetadata !== "absent"
  ) {
    throw new Error("MCP authorization protectedResourceMetadata must be published or absent.");
  }
  const authorizationServerMetadataUrl =
    input.authorizationServerMetadataUrl === undefined
      ? undefined
      : pinnedUrl(
          input.authorizationServerMetadataUrl,
          "MCP authorization authorizationServerMetadataUrl",
          { allowTemplate: templated, allowQuery: false },
        );
  let protectedResourceAuthorizationServer: string | undefined;
  if (input.protectedResourceAuthorizationServer !== undefined) {
    if (input.protectedResourceMetadata !== "published") {
      throw new Error(
        "MCP authorization protectedResourceAuthorizationServer requires published protected resource metadata.",
      );
    }
    if (authorizationServerMetadataUrl === undefined) {
      throw new Error(
        "MCP authorization protectedResourceAuthorizationServer requires authorizationServerMetadataUrl.",
      );
    }
    protectedResourceAuthorizationServer = pinnedUrl(
      input.protectedResourceAuthorizationServer,
      "MCP authorization protectedResourceAuthorizationServer",
      { allowTemplate: templated, allowQuery: false },
    );
  }
  return Object.freeze({
    kind: "oauth",
    issuer: pinnedUrl(input.issuer, "MCP authorization issuer", {
      allowTemplate: templated,
      allowQuery: false,
      allowLiteralPathBraces: authorizationServerMetadataUrl !== undefined,
    }),
    ...(authorizationServerMetadataUrl ? { authorizationServerMetadataUrl } : {}),
    ...(protectedResourceAuthorizationServer ? { protectedResourceAuthorizationServer } : {}),
    authorizationEndpoint: pinnedUrl(
      input.authorizationEndpoint,
      "MCP authorization authorizationEndpoint",
      endpoint,
    ),
    tokenEndpoint: pinnedUrl(input.tokenEndpoint, "MCP authorization tokenEndpoint", endpoint),
    ...(input.revocationEndpoint === undefined
      ? {}
      : {
          revocationEndpoint: pinnedUrl(
            input.revocationEndpoint,
            "MCP authorization revocationEndpoint",
            endpoint,
          ),
        }),
    registrationMethods,
    tokenEndpointAuthMethods,
    scopes: freezeDeepArray(scopes),
    issParameterSupported: input.issParameterSupported,
    protectedResourceMetadata: input.protectedResourceMetadata,
  });
}

function normalizeApiKeyAuthorization(
  input: Record<string, unknown>,
): VendorMcpApiKeyAuthorization {
  if (typeof input.field !== "string" || !AUTH_FIELD_KEY_PATTERN.test(input.field)) {
    throw new Error("MCP api_key authorization field must be a valid auth field key.");
  }
  if (
    typeof input.headerName !== "string" ||
    !HEADER_NAME_PATTERN.test(input.headerName) ||
    Object.hasOwn(RESERVED_API_KEY_HEADERS, input.headerName)
  ) {
    throw new Error(
      "MCP api_key authorization headerName must be a lowercase, non-reserved header.",
    );
  }
  if (input.scheme !== undefined && input.scheme !== "Bearer") {
    throw new Error("MCP api_key authorization scheme must be Bearer when set.");
  }
  return Object.freeze({
    kind: "api_key",
    field: input.field,
    headerName: input.headerName,
    ...(input.scheme === "Bearer" ? { scheme: "Bearer" as const } : {}),
  });
}

function normalizeToolEffects(value: unknown): Readonly<Record<string, VendorMcpToolEffect>> {
  if (!isPlainRecord(value)) throw new Error("MCP server toolEffects must be an object.");
  const entries = Object.entries(value).map(([name, effect]) => {
    if (name.length === 0 || name.length > MAX_TOOL_NAME_LENGTH) {
      throw new Error(`MCP toolEffects key must be 1 to ${MAX_TOOL_NAME_LENGTH} characters.`);
    }
    if (
      typeof effect !== "string" ||
      !(VENDOR_MCP_TOOL_EFFECTS as readonly string[]).includes(effect)
    ) {
      throw new Error(`MCP toolEffects entry ${name} has an unsupported effect.`);
    }
    return [name, effect as VendorMcpToolEffect] as const;
  });
  return Object.freeze(
    Object.fromEntries(
      entries.toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
  );
}

function normalizeReviewedAt(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new Error("MCP server reviewedAt must be a YYYY-MM-DD date.");
  }
  return value;
}

export function normalizeVendorMcpServerDefinition(
  input: VendorMcpServerDefinitionInput,
): VendorMcpServerDefinition {
  if (!isPlainRecord(input)) throw new Error("mcpServer must be an object.");
  const url = pinnedUrl(input.url, "MCP server url", { allowTemplate: true, allowQuery: false });
  const templated = vendorMcpIsTemplated(url);
  const tenant = normalizeTenant(input.tenant, url, templated);
  const authorization: unknown = input.authorization;
  if (!isPlainRecord(authorization)) throw new Error("MCP server authorization must be an object.");
  let normalizedAuthorization: VendorMcpOAuthAuthorization | VendorMcpApiKeyAuthorization;
  if (authorization.kind === "oauth") {
    normalizedAuthorization = normalizeOAuthAuthorization(authorization, templated);
  } else if (authorization.kind === "api_key") {
    normalizedAuthorization = normalizeApiKeyAuthorization(authorization);
  } else {
    throw new Error("MCP server authorization kind must be oauth or api_key.");
  }
  return Object.freeze({
    url,
    ...(tenant ? { tenant } : {}),
    resource: pinnedUrl(input.resource, "MCP server resource", {
      allowTemplate: templated,
      allowQuery: false,
    }),
    authorization: normalizedAuthorization,
    documentationUrl: pinnedUrl(input.documentationUrl, "MCP server documentationUrl", {
      allowTemplate: false,
      allowQuery: true,
    }),
    reviewedAt: normalizeReviewedAt(input.reviewedAt),
    toolEffects: normalizeToolEffects(input.toolEffects),
  });
}

/** API host allowlist for a vendor MCP server: the url host, or the tenant suffixes. */
export function vendorMcpApiHosts(server: VendorMcpServerDefinition): readonly string[] {
  return server.tenant
    ? server.tenant.hostSuffixes
    : freezeDeepArray([normalizeProviderApiHost(new URL(server.url).hostname)]);
}

/**
 * Route-level `vendor_mcp` rules. Shared rules that forbid platform_oauth-only
 * fields (`authorizationScopes`, `authorizationScopeCapabilities`, `oauthResources`)
 * stay in provider definition normalization.
 */
export function normalizeVendorMcpProviderFields(
  input: ProviderDefinitionInput,
  auth: ProviderAuthDefinition,
): {
  readonly apiHosts: readonly string[];
  readonly defaultScopes: readonly string[];
  readonly mcpServer: VendorMcpServerDefinition;
} {
  if (input.mcpServer === undefined) throw new Error("vendor_mcp providers require mcpServer.");
  const mcpServer = normalizeVendorMcpServerDefinition(input.mcpServer);
  if (auth.kind !== mcpServer.authorization.kind) {
    throw new Error(
      `vendor_mcp auth kind ${auth.kind} must match mcpServer authorization kind ${mcpServer.authorization.kind}.`,
    );
  }
  if (mcpServer.authorization.kind === "api_key") {
    const fieldKey = mcpServer.authorization.field;
    const field = auth.fields.find((entry) => entry.key === fieldKey);
    if (!field?.sensitive) {
      throw new Error(
        `vendor_mcp api_key authorization field ${fieldKey} must be a sensitive auth field.`,
      );
    }
  }
  if ((input.tools ?? []).length > 0) {
    throw new Error("vendor_mcp providers must not declare tools; tools are discovered.");
  }
  if (input.authorizationScopeMode !== undefined && input.authorizationScopeMode !== "manifest") {
    throw new Error("vendor_mcp providers use manifest authorizationScopeMode.");
  }
  const defaultScopes = normalizeProviderDefaultScopes(VENDOR_MCP_CAPABILITY_SCOPES);
  if (
    input.defaultScopes !== undefined &&
    JSON.stringify(normalizeProviderDefaultScopes(input.defaultScopes)) !==
      JSON.stringify(defaultScopes)
  ) {
    throw new Error(`vendor_mcp defaultScopes must be ${VENDOR_MCP_CAPABILITY_SCOPES.join(", ")}.`);
  }
  const apiHosts = vendorMcpApiHosts(mcpServer);
  if (
    input.apiHosts !== undefined &&
    JSON.stringify(normalizeProviderApiHosts(input.apiHosts)) !== JSON.stringify(apiHosts)
  ) {
    throw new Error(`vendor_mcp apiHosts must be ${apiHosts.join(", ")}.`);
  }
  return { apiHosts, defaultScopes, mcpServer };
}

/** `mcp_discovery` verification is exactly the vendor_mcp verification. */
export function assertVendorMcpVerification(
  route: ProviderRoute,
  verification: ProviderVerificationDefinition,
): void {
  if ((route === "vendor_mcp") !== (verification.method === "mcp_discovery")) {
    throw new Error(
      "vendor_mcp providers require mcp_discovery verification, and only they may use it.",
    );
  }
  if (verification.method === "mcp_discovery" && verification.probe) {
    throw new Error("mcp_discovery verification must not declare a probe.");
  }
}
