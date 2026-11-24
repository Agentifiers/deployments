import type { ProviderDefinition } from "./provider-definition-types.ts";
import { TOOL_NAME_PATTERN } from "./provider-definition-types.ts";
import type { VendorMcpCapabilityScope, VendorMcpServerDefinition } from "./vendor-mcp-types.ts";
import { VendorMcpConfigurationError } from "./vendor-mcp-template.ts";

const MAX_PLATFORM_TOOL_NAME_LENGTH = 128;
const READ_SCOPES: readonly VendorMcpCapabilityScope[] = Object.freeze(["tools:read"]);
const WRITE_SCOPES: readonly VendorMcpCapabilityScope[] = Object.freeze(["tools:write"]);

export function vendorMcpServer(definition: ProviderDefinition): VendorMcpServerDefinition {
  if (definition.route !== "vendor_mcp" || !definition.mcpServer) {
    throw new VendorMcpConfigurationError(
      "invalid_mcp_definition",
      `Provider ${definition.key} is not a vendor MCP provider.`,
    );
  }
  return definition.mcpServer;
}

/**
 * Platform tool name for a discovered remote tool: camelCase boundaries become `_`,
 * everything is lowercased, other non `[a-z0-9]` runs become `_`, and a `t_` prefix
 * is added when the result does not start with a letter. Returns undefined when the
 * result is empty, does not match `TOOL_NAME_PATTERN`, or exceeds 128 characters.
 */
export function vendorMcpToolName(providerKey: string, remoteName: string): string | undefined {
  const normalized = remoteName
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  if (!normalized) return undefined;
  const toolName = `${providerKey}.${/^[a-z]/u.test(normalized) ? normalized : `t_${normalized}`}`;
  return toolName.length <= MAX_PLATFORM_TOOL_NAME_LENGTH && TOOL_NAME_PATTERN.test(toolName)
    ? toolName
    : undefined;
}

export type VendorMcpToolNameResolution =
  | { readonly remoteName: string; readonly toolName: string }
  | { readonly remoteName: string; readonly rejected: "invalid_name" | "name_collision" };

/**
 * Resolve platform names for one server's full tool list. Every remote tool whose
 * normalized name is shared with another listed tool is rejected (order-independent).
 */
export function vendorMcpResolveToolNames(
  providerKey: string,
  remoteNames: readonly string[],
): readonly VendorMcpToolNameResolution[] {
  const named = remoteNames.map((remoteName) => ({
    remoteName,
    toolName: vendorMcpToolName(providerKey, remoteName),
  }));
  const counts = new Map<string, number>();
  for (const { toolName } of named) {
    if (toolName) counts.set(toolName, (counts.get(toolName) ?? 0) + 1);
  }
  return Object.freeze(
    named.map(({ remoteName, toolName }) =>
      Object.freeze(
        toolName === undefined
          ? { remoteName, rejected: "invalid_name" as const }
          : counts.get(toolName) === 1
            ? { remoteName, toolName }
            : { remoteName, rejected: "name_collision" as const },
      ),
    ),
  );
}

/**
 * Effect from the code-owned classification only; MCP annotations are never trusted.
 * Unclassified tools are writes so they default to approval.
 */
export function vendorMcpToolEffect(
  definition: ProviderDefinition,
  remoteName: string,
): {
  readonly effect: "read" | "write";
  readonly destructive: boolean;
  readonly classified: boolean;
} {
  const { toolEffects } = vendorMcpServer(definition);
  if (!Object.hasOwn(toolEffects, remoteName)) {
    return { effect: "write", destructive: false, classified: false };
  }
  const effect = toolEffects[remoteName];
  return effect === "read"
    ? { effect: "read", destructive: false, classified: true }
    : { effect: "write", destructive: effect === "destructive", classified: true };
}

export function vendorMcpToolRequiredScopes(
  effect: "read" | "write",
): readonly VendorMcpCapabilityScope[] {
  return effect === "read" ? READ_SCOPES : WRITE_SCOPES;
}
