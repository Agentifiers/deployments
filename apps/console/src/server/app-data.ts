import "@tanstack/react-start/server-only";
import type {
  AppDomainResponse,
  AppReleaseResponse,
  AppResponse,
} from "@deployments-ai/api-contract";
import { grantDirectory, type GrantDirectory } from "../apps/app-state.ts";
import type { EnvironmentScope } from "../scope.ts";
import { API_PAGE_LIMIT, fillPage, PAGE_SIZE, type Page } from "./list-pages.ts";
import { memberView } from "./membership-data.ts";
import { callRoute, collectPages, type PlatformApiClient } from "./platform-api.ts";

export type AppsPlatform = Pick<PlatformApiClient, "callRoute">;

export const appsPlatform: AppsPlatform = { callRoute };

export function loadAppPage(
  accessToken: string,
  scope: EnvironmentScope,
  cursor: string | undefined,
  client: AppsPlatform = appsPlatform,
): Promise<Page<AppResponse>> {
  return fillPage(
    async (pageCursor, limit) => {
      const page = await client.callRoute(
        "listApps",
        { query: { cursor: pageCursor, limit }, scope },
        accessToken,
      );
      return { items: page.items, nextCursor: page.nextCursor ?? undefined };
    },
    cursor,
    PAGE_SIZE,
  );
}

export function loadApp(
  accessToken: string,
  scope: EnvironmentScope,
  appId: string,
  client: AppsPlatform = appsPlatform,
): Promise<AppResponse> {
  return client.callRoute("getApp", { path: { appId }, scope }, accessToken);
}

export async function loadAppGrants(
  accessToken: string,
  scope: EnvironmentScope,
  appId: string,
  client: AppsPlatform = appsPlatform,
): Promise<GrantDirectory> {
  const [grants, members] = await Promise.all([
    collectPages((cursor) =>
      client.callRoute(
        "listAppGrants",
        { path: { appId }, query: { cursor, limit: API_PAGE_LIMIT }, scope },
        accessToken,
      ),
    ),
    collectPages((cursor) =>
      client.callRoute(
        "listOrganizationMembers",
        {
          query: { cursor, limit: API_PAGE_LIMIT },
          scope: { organizationId: scope.organizationId },
        },
        accessToken,
      ),
    ),
  ]);
  return grantDirectory(grants, members.map(memberView));
}

export function loadAppReleasePage(
  accessToken: string,
  scope: EnvironmentScope,
  appId: string,
  cursor: string | undefined,
  client: AppsPlatform = appsPlatform,
): Promise<Page<AppReleaseResponse>> {
  return fillPage(
    async (pageCursor, limit) => {
      const page = await client.callRoute(
        "listAppReleases",
        { path: { appId }, query: { cursor: pageCursor, limit }, scope },
        accessToken,
      );
      return { items: page.items, nextCursor: page.nextCursor ?? undefined };
    },
    cursor,
    PAGE_SIZE,
  );
}

export function loadAppDomains(
  accessToken: string,
  scope: EnvironmentScope,
  appId: string,
  client: AppsPlatform = appsPlatform,
): Promise<AppDomainResponse[]> {
  return collectPages((cursor) =>
    client.callRoute(
      "listAppDomains",
      { path: { appId }, query: { cursor, limit: API_PAGE_LIMIT }, scope },
      accessToken,
    ),
  );
}
