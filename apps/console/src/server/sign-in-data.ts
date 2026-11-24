import "@tanstack/react-start/server-only";
import type {
  IdentityProviderLinkResponse,
  IdentityProviderResponse,
  LoginDomainResponse,
} from "@deployments-ai/api-contract";
import { samlServiceProvider, type SamlServiceProvider } from "@deployments-ai/identity/saml";
import { PlatformApiError } from "../errors.ts";
import { consoleConfig } from "./config.ts";
import { API_PAGE_LIMIT, fillPage, PAGE_SIZE, type Page } from "./list-pages.ts";
import { callRoute, collectPages, type PlatformApiClient } from "./platform-api.ts";

export type SignInPlatform = Pick<PlatformApiClient, "callRoute">;

export const signInPlatform: SignInPlatform = { callRoute };

export interface OrganizationScope {
  readonly organizationId: string;
}

export function loadLoginDomains(
  accessToken: string,
  scope: OrganizationScope,
  client: SignInPlatform = signInPlatform,
): Promise<LoginDomainResponse[]> {
  return collectPages((cursor) =>
    client.callRoute(
      "listLoginDomains",
      { query: { cursor, limit: API_PAGE_LIMIT }, scope },
      accessToken,
    ),
  );
}

export async function loadIdentityProvider(
  accessToken: string,
  scope: OrganizationScope,
  client: SignInPlatform = signInPlatform,
): Promise<IdentityProviderResponse | null> {
  try {
    return await client.callRoute("getIdentityProvider", { scope }, accessToken);
  } catch (error) {
    if (error instanceof PlatformApiError && error.problem.status === 404) return null;
    throw error;
  }
}

/** The values a SAML provider will get, from the derivation the API uses for `serviceProvider`. */
export function loadSamlServiceProvider(scope: OrganizationScope): SamlServiceProvider {
  return samlServiceProvider({
    issuer: consoleConfig().identityIssuer,
    organizationId: scope.organizationId,
  });
}

export function loadIdentityProviderLinkPage(
  accessToken: string,
  scope: OrganizationScope,
  cursor: string | undefined,
  client: SignInPlatform = signInPlatform,
): Promise<Page<IdentityProviderLinkResponse>> {
  return fillPage(
    async (pageCursor, limit) => {
      const page = await client.callRoute(
        "listIdentityProviderLinks",
        { query: { cursor: pageCursor, limit }, scope },
        accessToken,
      );
      return { items: page.items, nextCursor: page.nextCursor ?? undefined };
    },
    cursor,
    PAGE_SIZE,
  );
}
