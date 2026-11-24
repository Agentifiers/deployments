import "@tanstack/react-start/server-only";
import type { EmailDomain, EmailTenant } from "../email/tenant-state.ts";
import type { EnvironmentScope } from "../scope.ts";
import { API_PAGE_LIMIT, type Page } from "./list-pages.ts";
import { callRoute, collectPages } from "./platform-api.ts";

/** Each tenant read is a live provider call, so pages stay small. */
const TENANT_PAGE_SIZE = 25;

export function loadTenantPage(
  accessToken: string,
  scope: EnvironmentScope,
  cursor: string | undefined,
): Promise<Page<EmailTenant>> {
  return callRoute(
    "listEmailTenants",
    { query: { cursor, limit: TENANT_PAGE_SIZE }, scope },
    accessToken,
  );
}

export function loadTenant(
  accessToken: string,
  scope: EnvironmentScope,
  tenantId: string,
): Promise<EmailTenant> {
  return callRoute("getEmailTenant", { path: { tenantId }, scope }, accessToken);
}

export function loadTenantDomains(
  accessToken: string,
  scope: EnvironmentScope,
  tenantId: string,
): Promise<EmailDomain[]> {
  return collectPages((cursor) =>
    callRoute(
      "listEmailDomains",
      { path: { tenantId }, query: { cursor, limit: API_PAGE_LIMIT }, scope },
      accessToken,
    ),
  );
}

export function loadTenantDomain(
  accessToken: string,
  scope: EnvironmentScope,
  domainId: string,
): Promise<EmailDomain> {
  return callRoute("getEmailDomain", { path: { domainId }, scope }, accessToken);
}
