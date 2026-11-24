import type { ProviderDefinitionInput } from "../../provider-definitions.ts";
import type {
  VendorMcpApiKeyAuthorization,
  VendorMcpOAuthAuthorization,
  VendorMcpServerDefinitionInput,
  VendorMcpToolEffect,
} from "../../vendor-mcp-types.ts";

/** Date the vendor pins below were last compared against live discovery. */
export const REVIEWED_AT = "2026-10-01";

const verification = Object.freeze({ method: "mcp_discovery", required: true });

interface VendorMcpProviderArgs<Authorization> {
  readonly aliases?: readonly string[];
  readonly category: string;
  readonly displayName: string;
  readonly key: string;
  readonly server: VendorMcpServerDefinitionInput & { readonly authorization: Authorization };
}

/** Vendor-hosted MCP server authorized through platform-run OAuth (callback key = kebab key). */
export function vendorMcpOAuthProvider(
  args: VendorMcpProviderArgs<VendorMcpOAuthAuthorization>,
): ProviderDefinitionInput {
  return Object.freeze({
    ...(args.aliases ? { aliases: Object.freeze([...args.aliases]) } : {}),
    auth: Object.freeze({ kind: "oauth" }),
    category: args.category,
    displayName: args.displayName,
    key: args.key,
    mcpServer: args.server,
    oauthProviderKey: args.key.replaceAll("_", "-"),
    route: "vendor_mcp",
    status: "configured",
    supportsMultipleAccounts: true,
    verification,
  });
}

/** Vendor-hosted MCP server authorized with a subscriber-supplied API key. */
export function vendorMcpApiKeyProvider(
  args: VendorMcpProviderArgs<VendorMcpApiKeyAuthorization>,
): ProviderDefinitionInput {
  return Object.freeze({
    auth: Object.freeze({
      fields: Object.freeze([
        Object.freeze({
          displayName: "API key",
          key: args.server.authorization.field,
          sensitive: true,
        }),
      ]),
      kind: "api_key",
    }),
    category: args.category,
    displayName: args.displayName,
    key: args.key,
    mcpServer: args.server,
    route: "vendor_mcp",
    status: "configured",
    supportsMultipleAccounts: true,
    verification,
  });
}

/**
 * Reviewed effect classification for advertised tool names (whitespace-separated).
 * Unlisted tools are treated as side-effecting writes that require approval; only list a
 * tool as `read` when it has no side effects.
 */
export function vendorMcpToolEffects(input: {
  readonly destructive?: string;
  readonly read?: string;
}): Readonly<Record<string, VendorMcpToolEffect>> {
  const effects: Record<string, VendorMcpToolEffect> = {};
  for (const [effect, names] of [
    ["read", input.read],
    ["destructive", input.destructive],
  ] as const) {
    for (const name of names?.split(/\s+/u) ?? []) {
      if (!name) continue;
      if (effects[name]) throw new Error(`Vendor MCP tool ${name} is classified twice.`);
      effects[name] = effect;
    }
  }
  return Object.freeze(effects);
}
