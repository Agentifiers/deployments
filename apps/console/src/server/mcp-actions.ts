import "@tanstack/react-start/server-only";
import type { McpConnectionView, McpDiscovery, McpServerView } from "../mcp/mcp-state.ts";
import type { EnvironmentScope } from "../scope.ts";
import { callRoute } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

export interface McpMutation {
  readonly accessToken: string;
  readonly idempotencyKey: string;
  readonly scope: EnvironmentScope;
}

interface ServerMutation extends McpMutation {
  readonly serverId: string;
}

export function createMcpServer({
  accessToken,
  body,
  idempotencyKey,
  scope,
}: McpMutation & { readonly body: unknown }): Promise<McpServerView> {
  return callRoute(
    "createMcpServer",
    {
      body: decodeRequestBody("createMcpServer", "CreateMcpServerRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
}

export function updateMcpServer({
  accessToken,
  body,
  idempotencyKey,
  scope,
  serverId,
}: ServerMutation & { readonly body: unknown }): Promise<McpServerView> {
  return callRoute(
    "updateMcpServer",
    {
      body: decodeRequestBody("updateMcpServer", "UpdateMcpServerRequest", body),
      idempotencyKey,
      path: { id: serverId },
      scope,
    },
    accessToken,
  );
}

export function discoverMcpServer({
  accessToken,
  idempotencyKey,
  scope,
  serverId,
}: ServerMutation): Promise<McpDiscovery> {
  return callRoute(
    "discoverMcpServer",
    { idempotencyKey, path: { id: serverId }, scope },
    accessToken,
  );
}

export function archiveMcpServer({
  accessToken,
  expectedVersion,
  idempotencyKey,
  scope,
  serverId,
}: ServerMutation & { readonly expectedVersion: number }): Promise<McpServerView> {
  return callRoute(
    "archiveMcpServer",
    { body: { expectedVersion }, idempotencyKey, path: { id: serverId }, scope },
    accessToken,
  );
}

export function createMcpConnection({
  accessToken,
  idempotencyKey,
  scope,
  serverId,
}: ServerMutation): Promise<McpConnectionView> {
  return callRoute(
    "createMcpConnection",
    {
      body: decodeRequestBody("createMcpConnection", "CreateMcpConnectionRequest", {
        mcpServerId: serverId,
      }),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
}

/**
 * Revokes at the connection's current version. A retry after a lost response finds it already
 * revoked and returns it, instead of resending the key with a newer version the API would refuse.
 */
export async function revokeMcpConnection({
  accessToken,
  connectionId,
  idempotencyKey,
  scope,
}: McpMutation & { readonly connectionId: string }): Promise<McpConnectionView> {
  const current = await callRoute(
    "getMcpConnection",
    { path: { id: connectionId }, scope },
    accessToken,
  );
  if (current.status === "revoked") return current;
  return callRoute(
    "revokeMcpConnection",
    {
      body: { expectedVersion: current.version },
      idempotencyKey,
      path: { id: connectionId },
      scope,
    },
    accessToken,
  );
}
