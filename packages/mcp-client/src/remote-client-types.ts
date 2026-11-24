import type { DnsLookup, ExecutePinnedHttpRequestOptions } from "@deployments-ai/net-security";

export const DEFAULT_REMOTE_MCP_TIMEOUT_MS = 60_000;
export const DEFAULT_REMOTE_MCP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_REMOTE_MCP_TOOL_PAGES = 100;
export const MAX_REMOTE_MCP_TOOLS = 5_000;

export type RemoteMcpPinnedRequest = (args: ExecutePinnedHttpRequestOptions) => Promise<Response>;

export type RemoteMcpErrorCode =
  | "configuration"
  | "http"
  | "protocol"
  | "remote-tool-error"
  | "timeout"
  | "tool-drift"
  | "tool-not-allowed"
  | "tool-not-found"
  | "transport";

export class RemoteMcpError extends Error {
  readonly statusCode?: number;

  constructor(
    readonly code: RemoteMcpErrorCode,
    message: string,
    options?: ErrorOptions & { readonly statusCode?: number },
  ) {
    super(message, options);
    this.name = "RemoteMcpError";
    if (options?.statusCode !== undefined) this.statusCode = options.statusCode;
  }
}

export interface RemoteMcpClientOptions {
  readonly clientInfo?: { readonly name: string; readonly version: string };
  readonly dnsLookup?: DnsLookup;
  readonly maxResponseBytes?: number;
  readonly pinnedRequest?: RemoteMcpPinnedRequest;
}

export interface RemoteMcpEndpointRequest {
  readonly endpointOrigin: string;
  readonly endpointPath: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface RemoteMcpToolCall extends RemoteMcpEndpointRequest {
  readonly arguments?: Readonly<Record<string, unknown>>;
  /**
   * `mcpToolDefinitionHash` of the tool definition the caller approved. When set, the
   * advertised definition is verified before `tools/call` and drift fails closed.
   */
  readonly expectedToolHash?: string;
  /**
   * Invoked synchronously immediately before the `tools/call` request is sent (after
   * initialize, tools/list and the expectedToolHash check).
   */
  readonly onToolCallDispatch?: () => void;
  readonly toolAllowlist: readonly string[];
  readonly toolName: string;
}

export interface RemoteMcpServerMetadata {
  readonly protocolVersion?: string;
  readonly serverName?: string;
  readonly serverVersion?: string;
}

export interface RemoteMcpToolCallResult extends RemoteMcpServerMetadata {
  readonly isError: boolean;
  readonly result: Readonly<Record<string, unknown>>;
}

export interface RemoteMcpDiscovery extends RemoteMcpEndpointRequest {
  readonly toolAllowlist: readonly string[];
}

export interface RemoteMcpDiscoveredTool {
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly remoteName: string;
}

export interface RemoteMcpDiscoveryResult {
  readonly tools: readonly RemoteMcpDiscoveredTool[];
}

export type RemoteMcpAllToolsDiscovery = RemoteMcpEndpointRequest;

export interface RemoteMcpAdvertisedTool {
  readonly annotations?: Readonly<Record<string, unknown>>;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly title?: string;
}

export interface RemoteMcpAllToolsDiscoveryResult extends RemoteMcpServerMetadata {
  readonly tools: readonly RemoteMcpAdvertisedTool[];
}

export interface RemoteMcpClient {
  readonly callTool: (input: RemoteMcpToolCall) => Promise<RemoteMcpToolCallResult>;
}

export interface RemoteMcpAdministrationClient extends RemoteMcpClient {
  readonly discoverAllTools: (
    input: RemoteMcpAllToolsDiscovery,
  ) => Promise<RemoteMcpAllToolsDiscoveryResult>;
  readonly discoverTools: (input: RemoteMcpDiscovery) => Promise<RemoteMcpDiscoveryResult>;
}
