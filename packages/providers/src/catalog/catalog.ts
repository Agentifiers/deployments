import type { ProviderDefinitionInput } from "../provider-definitions.ts";
import { MCP_GATEWAY_PROVIDER_DEFINITION_INPUTS } from "./mcp-gateway.ts";
import { MANUAL_BROWSER_PROVIDER_DEFINITION_INPUTS } from "./manual-browser.ts";
import { PLATFORM_API_CREDENTIAL_PROVIDER_DEFINITION_INPUTS } from "./platform-api-credential.ts";
import { PLATFORM_OAUTH_PROVIDER_DEFINITION_INPUTS } from "./platform-oauth.ts";
import { PLATFORM_WEBHOOK_PROVIDER_DEFINITION_INPUTS } from "./platform-webhook.ts";
import { SANDBOX_TOOL_PROVIDER_DEFINITION_INPUTS } from "./sandbox-tool.ts";
import { PLATFORM_OAUTH_CATALOG_PROVIDER_DEFINITION_INPUTS } from "./oauth-catalog.ts";
import { LEGACY_NATIVE_PROVIDER_DEFINITION_INPUTS } from "./legacy-native.ts";
import { VENDOR_MCP_PROVIDER_DEFINITION_INPUTS } from "./vendor-mcp/index.ts";

/**
 * Additive routed provider catalog data. The platform registry remains the
 * integration point for every code-owned provider definition.
 *
 * Vertical rollout plans may select from these definitions, but rollout phase,
 * product eligibility, and implementation evidence remain vertical-owned.
 */
export const ROUTED_PROVIDER_CATALOG_DEFINITION_INPUTS: readonly ProviderDefinitionInput[] =
  Object.freeze([
    ...PLATFORM_OAUTH_CATALOG_PROVIDER_DEFINITION_INPUTS,
    ...PLATFORM_API_CREDENTIAL_PROVIDER_DEFINITION_INPUTS,
    ...MCP_GATEWAY_PROVIDER_DEFINITION_INPUTS,
    ...MANUAL_BROWSER_PROVIDER_DEFINITION_INPUTS,
    ...PLATFORM_WEBHOOK_PROVIDER_DEFINITION_INPUTS,
    ...SANDBOX_TOOL_PROVIDER_DEFINITION_INPUTS,
    ...PLATFORM_OAUTH_PROVIDER_DEFINITION_INPUTS,
    ...LEGACY_NATIVE_PROVIDER_DEFINITION_INPUTS,
    ...VENDOR_MCP_PROVIDER_DEFINITION_INPUTS,
  ]);
