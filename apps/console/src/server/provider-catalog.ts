import "@tanstack/react-start/server-only";
import { codeProviderDefinitionRegistry, type ProviderDefinition } from "@deployments-ai/providers";
import type { ProviderCatalogEntry, ProviderOAuthEntry } from "../connections/connection-state.ts";

/**
 * Verification methods the API can run. Credentialless providers verify `none` at creation, and
 * `manual` and `webhook_challenge` never produce a capability through verify.
 */
const EXECUTABLE_VERIFICATION = new Set(["api_probe", "mcp_discovery", "oauth_scopes"]);

function access(definition: ProviderDefinition): ProviderCatalogEntry["access"] | undefined {
  if (definition.auth.kind === "oauth") return "oauth";
  if (definition.auth.kind !== "none") return "credential";
  return definition.verification.method === "none" && !definition.verification.required
    ? "credentialless"
    : undefined;
}

/**
 * The API checks app scopes against the vendor MCP server's pinned scopes, or the definition's
 * for platform OAuth, and a vendor without client metadata documents or dynamic registration
 * refuses to begin until an app is registered.
 */
function oauthEntry(definition: ProviderDefinition): ProviderOAuthEntry {
  const callbackKey = definition.oauthProviderKey ?? definition.key;
  const authorization = definition.mcpServer?.authorization;
  if (authorization?.kind !== "oauth") {
    return { appScopes: definition.authorizationScopes, callbackKey, requiresApp: true };
  }
  return {
    appScopes: authorization.scopes,
    callbackKey,
    requiresApp: authorization.registrationMethods.every((method) => method === "pre_registered"),
    tokenEndpointAuthMethods: authorization.tokenEndpointAuthMethods,
  };
}

/**
 * How the console offers one provider, or `undefined` when the API cannot connect it
 * (`createProviderCredential` refuses providers with no credential and a verification
 * challenge). The console and the API ship in one release, so this reads the same registry the
 * API validates against.
 */
export function catalogEntry(definition: ProviderDefinition): ProviderCatalogEntry | undefined {
  const kind = access(definition);
  if (kind === undefined) return undefined;
  const server = definition.mcpServer;
  const base = {
    displayName: definition.displayName,
    fields: definition.auth.fields.map((field) => ({
      key: field.key,
      label: field.displayName,
      multiline: field.valueType === "json",
      required: field.required,
      sensitive: field.sensitive,
      ...(field.description === undefined ? {} : { description: field.description }),
      ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }),
    })),
    key: definition.key,
    route: definition.route,
    verifiable: EXECUTABLE_VERIFICATION.has(definition.verification.method),
    ...(server?.tenant ? { resource: { label: server.tenant.label, template: server.url } } : {}),
  };
  return kind === "oauth"
    ? { ...base, access: kind, oauth: oauthEntry(definition) }
    : { ...base, access: kind };
}

let catalog: readonly ProviderCatalogEntry[] | undefined;

/** Every configured provider the console can connect, by display name. */
export function providerCatalog(): readonly ProviderCatalogEntry[] {
  catalog ??= codeProviderDefinitionRegistry()
    .list()
    .filter((definition) => definition.status === "configured")
    .flatMap((definition) => {
      const entry = catalogEntry(definition);
      return entry ? [entry] : [];
    })
    .toSorted((left, right) => left.displayName.localeCompare(right.displayName));
  return catalog;
}
