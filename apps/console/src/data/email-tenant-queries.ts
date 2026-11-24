import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { scopeKey, type EnvironmentScope } from "../scope.ts";
import {
  loadTenant,
  loadTenantDomain,
  loadTenantDomains,
  loadTenantPage,
} from "../server/email-tenant-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { pageInput, scopedInput, type PageInput, type ScopedInput } from "./server-input.ts";

const fetchTenantPage = createServerFn({ method: "GET" })
  .validator((input: PageInput) => pageInput(input))
  .handler(async ({ data }) => loadTenantPage(await requireAccessToken(), data.scope, data.cursor));

const fetchTenant = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly tenantId: string }) =>
    scopedInput(input, ["tenantId"]),
  )
  .handler(async ({ data }) => loadTenant(await requireAccessToken(), data.scope, data.tenantId));

const fetchTenantDomains = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly tenantId: string }) =>
    scopedInput(input, ["tenantId"]),
  )
  .handler(async ({ data }) =>
    loadTenantDomains(await requireAccessToken(), data.scope, data.tenantId),
  );

const fetchTenantDomain = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly domainId: string }) =>
    scopedInput(input, ["domainId"]),
  )
  .handler(async ({ data }) =>
    loadTenantDomain(await requireAccessToken(), data.scope, data.domainId),
  );

const emailTenantsKey = (scope: EnvironmentScope) => ["email-tenants", ...scopeKey(scope)] as const;

export function invalidateEmailTenants(queryClient: QueryClient, scope: EnvironmentScope) {
  return queryClient.invalidateQueries({ queryKey: emailTenantsKey(scope) });
}

export const tenantPagesQuery = (scope: EnvironmentScope) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchTenantPage({
        data: { scope, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...emailTenantsKey(scope), "tenants"],
  });

export const tenantQuery = (scope: EnvironmentScope, tenantId: string) =>
  queryOptions({
    queryFn: () => fetchTenant({ data: { scope, tenantId } }),
    queryKey: [...emailTenantsKey(scope), "tenant", tenantId],
  });

export const tenantDomainsQuery = (scope: EnvironmentScope, tenantId: string) =>
  queryOptions({
    queryFn: () => fetchTenantDomains({ data: { scope, tenantId } }),
    queryKey: [...emailTenantsKey(scope), "domains", tenantId],
  });

export const tenantDomainQuery = (scope: EnvironmentScope, domainId: string) =>
  queryOptions({
    queryFn: () => fetchTenantDomain({ data: { domainId, scope } }),
    queryKey: [...emailTenantsKey(scope), "domain", domainId],
  });
