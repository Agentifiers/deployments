import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { requireAccessToken } from "../server/session.ts";
import {
  loadIdentityProvider,
  loadIdentityProviderLinkPage,
  loadLoginDomains,
  loadSamlServiceProvider,
} from "../server/sign-in-data.ts";
import { pageInputAt, type PageInputAt } from "./server-input.ts";

type OrganizationInput = PageInputAt<"organization">;

const fetchLoginDomains = createServerFn({ method: "GET" })
  .validator((input: OrganizationInput) => pageInputAt("organization", input))
  .handler(async ({ data }) => loadLoginDomains(await requireAccessToken(), data.scope));

const fetchIdentityProvider = createServerFn({ method: "GET" })
  .validator((input: OrganizationInput) => pageInputAt("organization", input))
  .handler(async ({ data }) => loadIdentityProvider(await requireAccessToken(), data.scope));

const fetchIdentityProviderLinkPage = createServerFn({ method: "GET" })
  .validator((input: OrganizationInput) => pageInputAt("organization", input))
  .handler(async ({ data }) =>
    loadIdentityProviderLinkPage(await requireAccessToken(), data.scope, data.cursor),
  );

const fetchSamlServiceProvider = createServerFn({ method: "GET" })
  .validator((input: OrganizationInput) => pageInputAt("organization", input))
  .handler(async ({ data }) => {
    await requireAccessToken();
    return loadSamlServiceProvider(data.scope);
  });

const signInKey = (organizationId: string) => ["sign-in", organizationId] as const;

export function invalidateSignIn(queryClient: QueryClient, organizationId: string) {
  return queryClient.invalidateQueries({ queryKey: signInKey(organizationId) });
}

export const loginDomainsQuery = (organizationId: string) =>
  queryOptions({
    queryFn: () => fetchLoginDomains({ data: { scope: { organizationId } } }),
    queryKey: [...signInKey(organizationId), "login-domains"],
  });

export const identityProviderQuery = (organizationId: string) =>
  queryOptions({
    queryFn: () => fetchIdentityProvider({ data: { scope: { organizationId } } }),
    queryKey: [...signInKey(organizationId), "identity-provider"],
  });

export const identityProviderLinksQuery = (organizationId: string) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchIdentityProviderLinkPage({
        data: {
          scope: { organizationId },
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...signInKey(organizationId), "links"],
  });

export const samlServiceProviderQuery = (organizationId: string) =>
  queryOptions({
    queryFn: () => fetchSamlServiceProvider({ data: { scope: { organizationId } } }),
    queryKey: [...signInKey(organizationId), "saml-service-provider"],
    staleTime: Number.POSITIVE_INFINITY,
  });
