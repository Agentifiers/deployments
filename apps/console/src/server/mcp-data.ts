import "@tanstack/react-start/server-only";
import type { GrantView, PinningDeploymentView } from "../connections/connection-state.ts";
import {
  serverRows,
  type Capped,
  type McpServerView,
  type ServerRows,
  type ServerView,
} from "../mcp/mcp-state.ts";
import { collectPagesUpTo } from "../overview/status-counts.ts";
import type { EnvironmentScope } from "../scope.ts";
import { pinningView } from "./connection-data.ts";
import { API_PAGE_LIMIT } from "./list-pages.ts";
import { callRoute } from "./platform-api.ts";
import { loadMcpDirectory } from "./tool-directory.ts";

const MAX_PIN_PAGES = 20;

export async function loadMcpServerRows(
  accessToken: string,
  scope: EnvironmentScope,
  view: ServerView,
): Promise<ServerRows> {
  return serverRows(await loadMcpDirectory(accessToken, scope), view);
}

export function loadMcpServer(
  accessToken: string,
  scope: EnvironmentScope,
  serverId: string,
): Promise<McpServerView> {
  return callRoute("getMcpServer", { path: { id: serverId }, scope }, accessToken);
}

export function loadCappedGrants(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<Capped<GrantView>> {
  return collectPagesUpTo(
    (cursor) =>
      callRoute(
        "listConnectionGrants",
        { query: { cursor, limit: API_PAGE_LIMIT }, scope },
        accessToken,
      ),
    MAX_PIN_PAGES,
  );
}

export async function loadCappedDeployments(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<Capped<PinningDeploymentView>> {
  const { complete, items } = await collectPagesUpTo(
    (cursor) =>
      callRoute(
        "listAgentDeployments",
        { query: { cursor, limit: API_PAGE_LIMIT }, scope },
        accessToken,
      ),
    MAX_PIN_PAGES,
  );
  return { complete, items: items.map(pinningView) };
}
