import type { AppDomainResponse } from "@deployments-ai/api-contract";
import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { nextFailedChecks } from "../apps/domains.ts";
import { scopeKey, type EnvironmentScope } from "../scope.ts";
import {
  loadApp,
  loadAppDomains,
  loadAppGrants,
  loadAppPage,
  loadAppReleasePage,
} from "../server/app-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { refreshAppDomainFn } from "./app-mutations.ts";
import { pageInput, scopedInput, type PageInput, type ScopedInput } from "./server-input.ts";

const fetchAppDomains = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly appId: string }) => scopedInput(input, ["appId"]))
  .handler(async ({ data }) => loadAppDomains(await requireAccessToken(), data.scope, data.appId));

const fetchAppPage = createServerFn({ method: "GET" })
  .validator((input: PageInput) => pageInput(input))
  .handler(async ({ data }) => loadAppPage(await requireAccessToken(), data.scope, data.cursor));

const fetchApp = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly appId: string }) => scopedInput(input, ["appId"]))
  .handler(async ({ data }) => loadApp(await requireAccessToken(), data.scope, data.appId));

const fetchAppGrants = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly appId: string }) => scopedInput(input, ["appId"]))
  .handler(async ({ data }) => loadAppGrants(await requireAccessToken(), data.scope, data.appId));

const fetchAppReleasePage = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly appId: string }) => pageInput(input, ["appId"]))
  .handler(async ({ data }) =>
    loadAppReleasePage(await requireAccessToken(), data.scope, data.appId, data.cursor),
  );

const appsKey = (scope: EnvironmentScope) => ["apps", ...scopeKey(scope)] as const;

export function invalidateApps(queryClient: QueryClient, scope: EnvironmentScope) {
  return queryClient.invalidateQueries({ queryKey: appsKey(scope) });
}

export const appPagesQuery = (scope: EnvironmentScope) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchAppPage({ data: { scope, ...(pageParam === undefined ? {} : { cursor: pageParam }) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...appsKey(scope), "list"],
  });

export const appQuery = (scope: EnvironmentScope, appId: string) =>
  queryOptions({
    queryFn: () => fetchApp({ data: { appId, scope } }),
    queryKey: [...appsKey(scope), "app", appId],
  });

export const appGrantsQuery = (scope: EnvironmentScope, appId: string) =>
  queryOptions({
    queryFn: () => fetchAppGrants({ data: { appId, scope } }),
    queryKey: [...appsKey(scope), "grants", appId],
  });

export const appReleasePagesQuery = (scope: EnvironmentScope, appId: string) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchAppReleasePage({
        data: { appId, scope, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...appsKey(scope), "releases", appId],
  });

export const appDomainsQuery = (scope: EnvironmentScope, appId: string) =>
  queryOptions({
    queryFn: () => fetchAppDomains({ data: { appId, scope } }),
    queryKey: [...appsKey(scope), "domains", appId],
  });

/**
 * Refreshes one domain, which verifies an unverified domain's TXT record, queues the domain's edge
 * setup without waiting for it, and writes the answer into the domain list. A POST, so its key sits
 * outside the app keys and invalidating apps never fires it. Each refusal updates `failedChecks`
 * before the query settles, so the next interval sees it. Only an unverified domain's check
 * repeats, and its query holds no answer until a success verifies the domain and ends the checks,
 * so Check now joins a check in flight instead of cancelling it, and each refusal counts once. Only
 * Check now and the interval run a check, so focus and reconnect cannot skip a stop or a back-off.
 */
export const appDomainCheckQuery = (
  queryClient: QueryClient,
  scope: EnvironmentScope,
  appId: string,
  domainId: string,
  failedChecks: { current: number },
) =>
  queryOptions({
    gcTime: 0,
    queryFn: async () => {
      try {
        const checked = await refreshAppDomainFn({ data: { appId, domainId, scope } });
        queryClient.setQueryData(appDomainsQuery(scope, appId).queryKey, (domains) =>
          domains?.map((domain: AppDomainResponse) =>
            domain.id === checked.id ? checked : domain,
          ),
        );
        return checked;
      } catch (error) {
        failedChecks.current = nextFailedChecks({ error, failedChecks: failedChecks.current });
        throw error;
      }
    },
    queryKey: ["app-domain-check", ...scopeKey(scope), appId, domainId],
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false,
  });
