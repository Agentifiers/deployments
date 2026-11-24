import "@tanstack/react-start/server-only";
import type { EnvironmentScope } from "../scope.ts";
import type { CatalogFilters } from "../tool-policies/catalog-state.ts";
import { PAGE_SIZE, type Page } from "./list-pages.ts";
import { callRoute, type RouteResponse } from "./platform-api.ts";

export type ToolCatalogItem = RouteResponse<"listTools">["items"][number];
export type ToolCatalogDetail = RouteResponse<"getTool">;

export async function loadToolPage(
  accessToken: string,
  scope: EnvironmentScope,
  filters: CatalogFilters,
  cursor: string | undefined,
): Promise<Page<ToolCatalogItem>> {
  const page = await callRoute(
    "listTools",
    { query: { ...filters, cursor, limit: PAGE_SIZE }, scope },
    accessToken,
  );
  return page.nextCursor === null
    ? { items: page.items }
    : { items: page.items, nextCursor: page.nextCursor };
}

export function loadTool(
  accessToken: string,
  scope: EnvironmentScope,
  toolName: string,
): Promise<ToolCatalogDetail> {
  return callRoute("getTool", { path: { toolName }, scope }, accessToken);
}
