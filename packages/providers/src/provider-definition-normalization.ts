import type { ProviderDefinitionInput, ProviderDefinition } from "./provider-definition-types.ts";
import {
  PROVIDER_ROUTES,
  PROVIDER_DEFINITION_STATUSES,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_CATEGORY_LENGTH,
  MAX_ALIAS_COUNT,
} from "./provider-definition-types.ts";
import {
  freezeDeepArray,
  requireNonEmptyText,
  isProviderRoute,
  isPlatformOAuthProviderRoute,
  isProviderDefinitionStatus,
  normalizeProviderDefinitionKey,
  normalizeProviderDefinitionAlias,
  normalizeProviderDefinitionOAuthProviderKey,
  normalizeProviderApiHosts,
  normalizeProviderDefaultScopes,
  normalizeProviderToolNames,
  normalizeProviderInputSchema,
  normalizeImmutableHttpsOrigin,
} from "./provider-key-schema-normalization.ts";
import { normalizeProviderAuthDefinition } from "./provider-auth-normalization.ts";
import {
  normalizeProviderOriginPolicy,
  normalizeProviderHostPolicy,
  normalizeProviderRateLimitPolicy,
  normalizeProviderRetryPolicy,
  normalizeProviderResourceMetadata,
  normalizeProviderEffectMetadata,
  normalizeProviderAuditMetadata,
  normalizeProviderConformanceMetadata,
  normalizeProviderVerificationDefinition,
} from "./provider-policy-normalization.ts";
import {
  assertVendorMcpVerification,
  normalizeVendorMcpProviderFields,
} from "./vendor-mcp-normalization.ts";

export function normalizeAliases(
  aliases: readonly string[] | undefined,
  canonicalKey: string,
): readonly string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const alias of aliases ?? []) {
    const value = normalizeProviderDefinitionAlias(alias);
    if (value === canonicalKey) {
      throw new Error(`Provider alias ${value} collides with the canonical key.`);
    }
    if (seen.has(value)) {
      throw new Error(`Duplicate provider alias: ${value}.`);
    }
    seen.add(value);
    normalized.push(value);
  }
  if (normalized.length > MAX_ALIAS_COUNT) {
    throw new Error(`Provider may declare at most ${MAX_ALIAS_COUNT} aliases.`);
  }
  return freezeDeepArray(normalized.toSorted((left, right) => left.localeCompare(right)));
}

/**
 * Normalize and validate a single provider definition.
 * Output is frozen and contains field metadata only (no secret values).
 */
export function normalizeProviderDefinition(input: ProviderDefinitionInput): ProviderDefinition {
  const key = normalizeProviderDefinitionKey(input.key);
  const displayName = requireNonEmptyText(
    input.displayName,
    "Display name",
    MAX_DISPLAY_NAME_LENGTH,
  );
  const category = requireNonEmptyText(
    input.category,
    "Category",
    MAX_CATEGORY_LENGTH,
  ).toLowerCase();

  const routeRaw = requireNonEmptyText(input.route, "Provider route", 64);
  if (!isProviderRoute(routeRaw)) {
    throw new Error(
      `Unsupported provider route: ${routeRaw}. Allowed values are ${PROVIDER_ROUTES.join(", ")}.`,
    );
  }
  const route = routeRaw;

  const statusRaw = requireNonEmptyText(input.status, "Provider status", 64);
  if (!isProviderDefinitionStatus(statusRaw)) {
    throw new Error(
      `Unsupported provider status: ${statusRaw}. Allowed values are ${PROVIDER_DEFINITION_STATUSES.join(", ")}.`,
    );
  }
  const status = statusRaw;

  const aliases = normalizeAliases(input.aliases, key);
  const auth = normalizeProviderAuthDefinition(input.auth, route);
  if (route !== "vendor_mcp" && input.mcpServer !== undefined) {
    throw new Error("mcpServer is only valid for vendor_mcp providers.");
  }
  const vendorMcp =
    route === "vendor_mcp" ? normalizeVendorMcpProviderFields(input, auth) : undefined;
  const apiHosts = vendorMcp ? vendorMcp.apiHosts : normalizeProviderApiHosts(input.apiHosts);
  if (auth.tokenExchange) {
    const tokenHost = new URL(auth.tokenExchange.endpoint).hostname;
    if (!apiHosts.includes(tokenHost)) {
      throw new Error(
        `Auth tokenExchange endpoint host ${tokenHost} must be declared in provider apiHosts.`,
      );
    }
  }
  const authorizationScopes = normalizeProviderDefaultScopes(input.authorizationScopes);
  const authorizationScopeMode = vendorMcp
    ? "manifest"
    : (input.authorizationScopeMode ?? "oauth_request");
  if (authorizationScopeMode !== "oauth_request" && authorizationScopeMode !== "manifest") {
    throw new Error("authorizationScopeMode must be oauth_request or manifest.");
  }
  const oauthResources = Object.freeze(
    [
      ...new Set(
        (input.oauthResources ?? []).map((value) =>
          normalizeImmutableHttpsOrigin(value, "OAuth resource"),
        ),
      ),
    ].toSorted(),
  );
  const defaultScopes = vendorMcp
    ? vendorMcp.defaultScopes
    : normalizeProviderDefaultScopes(input.defaultScopes);
  const authorizationScopeCapabilities = Object.freeze(
    Object.fromEntries(
      Object.entries(input.authorizationScopeCapabilities ?? {}).map(
        ([authorizationScope, capabilities]) => {
          if (!authorizationScopes.includes(authorizationScope)) {
            throw new Error(
              `Authorization capability mapping references undeclared scope ${authorizationScope}.`,
            );
          }
          const normalized = normalizeProviderDefaultScopes(capabilities);
          if (normalized.some((scope) => !defaultScopes.includes(scope))) {
            throw new Error(
              `Authorization capability mapping for ${authorizationScope} references a non-default scope.`,
            );
          }
          return [authorizationScope, normalized] as const;
        },
      ),
    ),
  );
  const tools = normalizeProviderToolNames(input.tools);
  const verification = normalizeProviderVerificationDefinition(input.verification, apiHosts);
  assertVendorMcpVerification(route, verification);
  for (const fieldKey of verification.probe?.pathFieldKeys ?? []) {
    const authField = auth.fields.find((field) => field.key === fieldKey);
    if (!authField) {
      throw new Error(`Verification probe path field ${fieldKey} is not declared in auth fields.`);
    }
    if (authField.sensitive) {
      throw new Error(`Verification probe path field ${fieldKey} must be non-sensitive.`);
    }
    if (!auth.requestFieldKeys.includes(fieldKey)) {
      throw new Error(
        `Verification probe path field ${fieldKey} must be declared in auth requestFieldKeys.`,
      );
    }
  }
  const originPolicy = normalizeProviderOriginPolicy(input.originPolicy, auth);
  const hostPolicy = normalizeProviderHostPolicy(input.hostPolicy, apiHosts, originPolicy);
  const inputSchema = normalizeProviderInputSchema(input.inputSchema);
  const rateLimitPolicy = normalizeProviderRateLimitPolicy(input.rateLimitPolicy);
  const retryPolicy = normalizeProviderRetryPolicy(input.retryPolicy);
  const resourceMetadata = normalizeProviderResourceMetadata(input.resourceMetadata);
  const effectMetadata = normalizeProviderEffectMetadata(input.effectMetadata);
  const auditMetadata = normalizeProviderAuditMetadata(input.auditMetadata);
  const conformanceMetadata = normalizeProviderConformanceMetadata(input.conformanceMetadata);
  const supportsMultipleAccounts = input.supportsMultipleAccounts === true;

  let oauthProviderKey: string | undefined;
  if (input.oauthProviderKey !== undefined) {
    oauthProviderKey = normalizeProviderDefinitionOAuthProviderKey(input.oauthProviderKey);
  }
  if (isPlatformOAuthProviderRoute(route) && !oauthProviderKey) {
    throw new Error("platform_oauth requires oauthProviderKey.");
  }
  const vendorMcpOAuth = route === "vendor_mcp" && auth.kind === "oauth";
  if (vendorMcpOAuth && !oauthProviderKey) {
    throw new Error("vendor_mcp oauth providers require oauthProviderKey.");
  }
  if (
    isPlatformOAuthProviderRoute(route) &&
    (status === "configured" || status === "verified") &&
    input.authorizationScopes === undefined
  ) {
    throw new Error("Executable platform_oauth providers require explicit authorizationScopes.");
  }
  if (!isPlatformOAuthProviderRoute(route) && !vendorMcpOAuth && oauthProviderKey) {
    throw new Error(
      "oauthProviderKey is only valid for platform_oauth and vendor_mcp oauth providers.",
    );
  }
  if (!isPlatformOAuthProviderRoute(route) && input.authorizationScopes !== undefined) {
    throw new Error("authorizationScopes is only valid for platform_oauth providers.");
  }
  if (
    !isPlatformOAuthProviderRoute(route) &&
    !vendorMcp &&
    input.authorizationScopeMode !== undefined
  ) {
    throw new Error(
      "authorizationScopeMode is only valid for platform_oauth and vendor_mcp providers.",
    );
  }
  if (!isPlatformOAuthProviderRoute(route) && input.authorizationScopeCapabilities !== undefined) {
    throw new Error("authorizationScopeCapabilities is only valid for platform_oauth providers.");
  }
  if (!isPlatformOAuthProviderRoute(route) && input.oauthResources !== undefined) {
    throw new Error("oauthResources is only valid for platform_oauth providers.");
  }

  if (route === "platform_api_credential" && auth.fields.length === 0) {
    throw new Error("platform_api_credential requires at least one auth field.");
  }

  const definition: ProviderDefinition = Object.freeze({
    key,
    displayName,
    category,
    route,
    aliases,
    auth,
    apiHosts,
    authorizationScopes,
    authorizationScopeCapabilities,
    authorizationScopeMode,
    oauthResources,
    defaultScopes,
    supportsMultipleAccounts,
    verification,
    tools,
    status,
    hostPolicy,
    ...(inputSchema ? { inputSchema } : {}),
    ...(rateLimitPolicy ? { rateLimitPolicy } : {}),
    ...(retryPolicy ? { retryPolicy } : {}),
    ...(resourceMetadata ? { resourceMetadata } : {}),
    ...(effectMetadata ? { effectMetadata } : {}),
    ...(auditMetadata ? { auditMetadata } : {}),
    ...(conformanceMetadata ? { conformanceMetadata } : {}),
    ...(oauthProviderKey ? { oauthProviderKey } : {}),
    ...(vendorMcp ? { mcpServer: vendorMcp.mcpServer } : {}),
    ...(originPolicy ? { originPolicy } : {}),
  });

  return definition;
}

/**
 * Build a frozen registry of normalized provider definitions.
 *
 * Canonical keys and aliases are exclusive. An OAuth app key may be shared by
 * multiple capabilities (for example `google` for GA4 and Search Console).
 */
