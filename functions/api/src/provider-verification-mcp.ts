import {
  RemoteMcpError,
  type RemoteMcpAdministrationClient,
  type RemoteMcpAllToolsDiscoveryResult,
} from "@deployments-ai/mcp-client";
import { VENDOR_MCP_CAPABILITY_SCOPES } from "@deployments-ai/providers";
import { assertNoCredentialLeak } from "@deployments-ai/tools";
import {
  AdministrationProviderVerificationError,
  type AdministrationProviderVerificationResult,
} from "./provider-verification.ts";
import type { VendorMcpConnectionCredential } from "./vendor-mcp-connection-credential.ts";

/** Upper bound for one vendor MCP initialize + full tools/list exchange from the API. */
export const VENDOR_MCP_DISCOVERY_TIMEOUT_MS = 25_000;

/**
 * `mcp_discovery` verification: initialize an MCP session with the connection credential and
 * list every tool. HTTP 401/403 is a definitive credential failure; every other failure is
 * non-definitive so the connection keeps its status.
 */
export async function verifyVendorMcpDiscovery(
  mcpClient: RemoteMcpAdministrationClient,
  credential: VendorMcpConnectionCredential,
): Promise<AdministrationProviderVerificationResult> {
  let discovered: RemoteMcpAllToolsDiscoveryResult;
  try {
    discovered = await mcpClient.discoverAllTools({
      endpointOrigin: credential.endpointOrigin,
      endpointPath: credential.endpointPath,
      headers: credential.headers,
      timeoutMs: VENDOR_MCP_DISCOVERY_TIMEOUT_MS,
    });
  } catch (cause) {
    if (
      cause instanceof RemoteMcpError &&
      cause.code === "http" &&
      (cause.statusCode === 401 || cause.statusCode === 403)
    ) {
      throw new AdministrationProviderVerificationError(
        `Vendor MCP server rejected the credential with HTTP ${cause.statusCode}.`,
        cause.statusCode,
      );
    }
    throw new AdministrationProviderVerificationError("Vendor MCP discovery failed.");
  }
  const metadata = {
    method: "mcp_discovery",
    ...(discovered.protocolVersion ? { protocolVersion: discovered.protocolVersion } : {}),
    ...(discovered.serverName ? { serverName: discovered.serverName } : {}),
    toolCount: discovered.tools.length,
  };
  try {
    assertNoCredentialLeak(JSON.stringify(metadata), credential.sensitiveMaterials, metadata);
  } catch {
    throw new AdministrationProviderVerificationError(
      "Vendor MCP discovery echoed credential material.",
    );
  }
  return {
    ...(credential.connection.data.externalAccountId
      ? { externalAccountId: credential.connection.data.externalAccountId }
      : {}),
    ...(credential.connection.data.externalAccountName
      ? { externalAccountName: credential.connection.data.externalAccountName }
      : {}),
    metadata,
    scopes: [...VENDOR_MCP_CAPABILITY_SCOPES],
  };
}
