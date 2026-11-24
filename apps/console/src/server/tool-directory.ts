import "@tanstack/react-start/server-only";
import { collectPagesUpTo, type FetchPage } from "../overview/status-counts.ts";
import type { EnvironmentScope } from "../scope.ts";
import { callRoute, type RouteResponse } from "./platform-api.ts";

const PAGE_LIMIT = 100;
const MAX_DIRECTORY_PAGES = 20;

type ExtensionTool = RouteResponse<"listExtensionTools">["items"][number];
type McpServer = RouteResponse<"listMcpServers">["items"][number];
type McpConnection = RouteResponse<"listMcpConnections">["items"][number];

export interface ExtensionSummary extends Pick<
  ExtensionTool,
  | "defaultPolicyAction"
  | "effect"
  | "id"
  | "name"
  | "providerKey"
  | "requiredScopes"
  | "status"
  | "version"
> {
  readonly execution:
    | {
        readonly type: "mcp";
        readonly mcpServerId: string;
        readonly remoteToolName: string;
      }
    | {
        readonly type: "vendor_mcp";
        readonly providerKey: string;
        readonly remoteToolName: string;
      }
    | {
        readonly type: "http_callback";
        readonly endpointOrigin: string;
        readonly endpointPath: string;
      }
    | { readonly type: "client" }
    | {
        readonly type: "hosted_code";
        readonly contentHash: string;
        readonly secretNames: readonly string[];
      };
}

export interface ExtensionDirectory {
  readonly complete: boolean;
  readonly extensions: readonly ExtensionSummary[];
}

export interface McpDirectory {
  readonly complete: boolean;
  readonly connections: readonly Pick<
    McpConnection,
    "id" | "mcpServerId" | "status" | "updatedAt" | "version"
  >[];
  readonly servers: readonly Pick<
    McpServer,
    "endpointOrigin" | "hasAuth" | "id" | "name" | "status" | "toolAllowlist" | "version"
  >[];
}

function extensionExecution(execution: ExtensionTool["execution"]): ExtensionSummary["execution"] {
  switch (execution.type) {
    case "mcp":
      return {
        mcpServerId: execution.mcpServerId,
        remoteToolName: execution.remoteToolName,
        type: "mcp",
      };
    case "vendor_mcp":
      return {
        providerKey: execution.providerKey,
        remoteToolName: execution.remoteToolName,
        type: "vendor_mcp",
      };
    case "http_callback":
      return {
        endpointOrigin: execution.endpointOrigin,
        endpointPath: execution.endpointPath,
        type: "http_callback",
      };
    case "client":
      return { type: "client" };
    case "hosted_code":
      return {
        contentHash: execution.contentHash,
        secretNames: execution.secretNames,
        type: "hosted_code",
      };
  }
}

export function extensionSummary(tool: ExtensionTool): ExtensionSummary {
  return {
    defaultPolicyAction: tool.defaultPolicyAction,
    effect: tool.effect,
    execution: extensionExecution(tool.execution),
    id: tool.id,
    name: tool.name,
    ...(tool.providerKey === undefined ? {} : { providerKey: tool.providerKey }),
    requiredScopes: tool.requiredScopes,
    status: tool.status,
    version: tool.version,
  };
}

export async function extensionDirectory(
  fetchPage: FetchPage<ExtensionTool>,
): Promise<ExtensionDirectory> {
  const { complete, items } = await collectPagesUpTo(fetchPage, MAX_DIRECTORY_PAGES);
  return { complete, extensions: items.map(extensionSummary) };
}

export async function mcpDirectory(
  fetchServers: FetchPage<McpServer>,
  fetchConnections: FetchPage<McpConnection>,
): Promise<McpDirectory> {
  const [servers, connections] = await Promise.all([
    collectPagesUpTo(fetchServers, MAX_DIRECTORY_PAGES),
    collectPagesUpTo(fetchConnections, MAX_DIRECTORY_PAGES),
  ]);
  return {
    complete: servers.complete && connections.complete,
    connections: connections.items.map(({ id, mcpServerId, status, updatedAt, version }) => ({
      id,
      mcpServerId,
      status,
      updatedAt,
      version,
    })),
    servers: servers.items.map(
      ({ endpointOrigin, hasAuth, id, name, status, toolAllowlist, version }) => ({
        endpointOrigin,
        hasAuth,
        id,
        name,
        status,
        toolAllowlist,
        version,
      }),
    ),
  };
}

export function loadExtensionDirectory(accessToken: string, scope: EnvironmentScope) {
  return extensionDirectory((cursor) =>
    callRoute("listExtensionTools", { query: { cursor, limit: PAGE_LIMIT }, scope }, accessToken),
  );
}

export function loadMcpDirectory(accessToken: string, scope: EnvironmentScope) {
  return mcpDirectory(
    (cursor) =>
      callRoute("listMcpServers", { query: { cursor, limit: PAGE_LIMIT }, scope }, accessToken),
    (cursor) =>
      callRoute("listMcpConnections", { query: { cursor, limit: PAGE_LIMIT }, scope }, accessToken),
  );
}
