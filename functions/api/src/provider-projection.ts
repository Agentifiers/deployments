import type { ProviderDefinition, VendorMcpServerDefinition } from "@deployments-ai/providers";

/** Public, secret-free summary of a vendor-hosted MCP server pin. */
function vendorMcpServerProjection(server: VendorMcpServerDefinition) {
  return {
    authorization: server.authorization.kind,
    documentationUrl: server.documentationUrl,
    registrationMethods:
      server.authorization.kind === "oauth" ? [...server.authorization.registrationMethods] : [],
    url: server.url,
  };
}

export function providerProjection(
  definition: ProviderDefinition,
): Readonly<Record<string, unknown>> {
  return {
    authMethods: [definition.auth.kind],
    category: definition.category,
    displayName: definition.displayName,
    key: definition.key,
    metadata: {
      aliases: definition.aliases,
      authorizationScopes: definition.authorizationScopes,
      ...(definition.route === "vendor_mcp" && definition.mcpServer
        ? { mcpServer: vendorMcpServerProjection(definition.mcpServer) }
        : {}),
      supportsMultipleAccounts: definition.supportsMultipleAccounts,
    },
    route: definition.route,
    status: definition.status,
    supportedScopes: definition.defaultScopes,
    supportedTools: definition.tools,
    verification: definition.verification,
  };
}
