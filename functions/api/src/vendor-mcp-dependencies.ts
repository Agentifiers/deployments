import type {
  RemoteMcpAdministrationClient,
  discoverMcpAuthorization,
  registerDynamicOAuthClient,
} from "@deployments-ai/mcp-client";
import type { OAuthRefreshRequest, OAuthRefreshResponse } from "@deployments-ai/providers";

/**
 * Network ports used by vendor-hosted MCP connections: authorization discovery and client
 * registration at authorization begin, on-demand token refresh through the channel-provider
 * `oauth-refresh` Lambda, and tool discovery for verification and tool sync.
 */
export interface VendorMcpAdministrationDependencies {
  /** Exact channel API origin (`PLATFORM_OAUTH_PUBLIC_ORIGIN`) serving callbacks and the CIMD. */
  readonly publicOrigin: string;
  readonly discoverAuthorization: typeof discoverMcpAuthorization;
  readonly registerClient: typeof registerDynamicOAuthClient;
  readonly refreshConnection: (request: OAuthRefreshRequest) => Promise<OAuthRefreshResponse>;
  readonly mcpClient: RemoteMcpAdministrationClient;
}
