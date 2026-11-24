import type { ProviderDefinitionInput } from "../provider-definitions.ts";
import { manualVerification, mcpGatewayDefinition } from "./shared.ts";

/** Explicit MCP gateway routes; these are not platform credential systems of record. */
export const MCP_GATEWAY_PROVIDER_DEFINITION_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([
    mcpGatewayDefinition({
      key: "composio",
      displayName: "Composio",
      category: "integration_layer",
      supportsMultipleAccounts: true,
      status: "unsupported",
      verification: manualVerification(
        "Unsupported managed MCP gateway for AWS-only custody: Composio stores and refreshes downstream connected-account credentials outside the platform AWS account.",
      ),
      tools: Object.freeze(["composio.mcp"]),
    }),
    mcpGatewayDefinition({
      key: "cogny",
      displayName: "Cogny",
      category: "integration_layer",
      supportsMultipleAccounts: true,
      status: "unsupported",
      verification: manualVerification(
        "Unsupported managed MCP gateway for AWS-only custody: Cogny performs downstream OAuth and token refresh outside the platform AWS account.",
      ),
      tools: Object.freeze(["cogny.mcp"]),
    }),
  ]);
