import "@tanstack/react-start/server-only";
import type { EnvironmentScope } from "../scope.ts";
import { PlatformApiError } from "../errors.ts";
import {
  sendingReadiness,
  type AgentEmailDomain,
  type AgentEmailPlacement,
  type PolicyState,
  type ReadinessCheck,
} from "../email/setup-state.ts";
import {
  usageWindow,
  type UsageBucket,
  type UsageFormat,
  type UsageRange,
} from "../email/usage-state.ts";
import { API_PAGE_LIMIT, fillPage, PAGE_SIZE, type Page } from "./list-pages.ts";
import { callRoute, collectPages, type RouteResponse } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

export type EmailSetup =
  | { readonly kind: "not_installed" }
  | { readonly kind: "installed"; readonly checks: readonly ReadinessCheck[] };

function isNotInstalled(error: unknown) {
  return (
    error instanceof PlatformApiError &&
    error.problem.status === 404 &&
    error.problem.code === "route_not_found"
  );
}

function listDomains(accessToken: string, scope: EnvironmentScope): Promise<AgentEmailDomain[]> {
  return collectPages((cursor) =>
    callRoute(
      "listAgentEmailDomains",
      { query: { cursor, limit: API_PAGE_LIMIT }, scope },
      accessToken,
    ),
  );
}

export function loadPlacements(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<AgentEmailPlacement[]> {
  return collectPages((cursor) =>
    callRoute(
      "listAgentEmailPlacements",
      { query: { cursor, limit: API_PAGE_LIMIT }, scope },
      accessToken,
    ),
  );
}

export async function loadPolicyState(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<PolicyState> {
  try {
    return {
      kind: "saved",
      policy: await callRoute("getAgentEmailPolicy", { scope }, accessToken),
    };
  } catch (error) {
    if (
      error instanceof PlatformApiError &&
      error.problem.status === 404 &&
      error.problem.code === "policy_not_found"
    ) {
      return { kind: "defaults" };
    }
    throw error;
  }
}

export async function loadEmailSetup(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<EmailSetup> {
  try {
    const [domains, placements, policy] = await Promise.all([
      listDomains(accessToken, scope),
      loadPlacements(accessToken, scope),
      loadPolicyState(accessToken, scope),
    ]);
    return { checks: sendingReadiness({ domains, placements, policy }), kind: "installed" };
  } catch (error) {
    if (isNotInstalled(error)) return { kind: "not_installed" };
    throw error;
  }
}

export async function loadVerifiedDomains(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<readonly Pick<AgentEmailDomain, "domain" | "id" | "providerManaged">[]> {
  return (await listDomains(accessToken, scope))
    .filter((domain) => domain.status === "verified")
    .map(({ domain, id, providerManaged }) => ({ domain, id, providerManaged }));
}

export async function loadDomainPage(
  accessToken: string,
  scope: EnvironmentScope,
  cursor: string | undefined,
): Promise<Page<AgentEmailDomain>> {
  return callRoute(
    "listAgentEmailDomains",
    { query: { cursor, limit: PAGE_SIZE }, scope },
    accessToken,
  );
}

export function loadDomain(
  accessToken: string,
  scope: EnvironmentScope,
  domainId: string,
): Promise<AgentEmailDomain> {
  return callRoute("getAgentEmailDomain", { path: { domainId }, scope }, accessToken);
}

/** Suppressions are filtered after the API pages them, so short pages are filled. */
export function loadSuppressionPage(
  accessToken: string,
  scope: EnvironmentScope,
  cursor: string | undefined,
): Promise<Page<RouteResponse<"listAgentEmailSuppressions">["items"][number]>> {
  return fillPage(
    (pageCursor, limit) =>
      callRoute(
        "listAgentEmailSuppressions",
        { query: { cursor: pageCursor, limit }, scope },
        accessToken,
      ),
    cursor,
    PAGE_SIZE,
  );
}

export function loadUsageSummary(
  accessToken: string,
  scope: EnvironmentScope,
  { inboxId, range }: { readonly inboxId: string | undefined; readonly range: UsageRange },
): Promise<RouteResponse<"getAgentEmailUsage">> {
  return callRoute(
    "getAgentEmailUsage",
    { query: { ...usageWindow(range, new Date()), inboxId }, scope },
    accessToken,
  );
}

export function exportUsage(
  accessToken: string,
  scope: EnvironmentScope,
  {
    bucket,
    format,
    inboxId,
    range,
  }: {
    readonly bucket: UsageBucket;
    readonly format: UsageFormat;
    readonly inboxId: string | undefined;
    readonly range: UsageRange;
  },
): Promise<RouteResponse<"exportAgentEmailUsage">> {
  return callRoute(
    "exportAgentEmailUsage",
    {
      body: decodeRequestBody("exportAgentEmailUsage", "ExportAgentEmailUsageRequest", {
        ...usageWindow(range, new Date()),
        bucket,
        format,
        ...(inboxId === undefined ? {} : { inboxId }),
      }),
      scope,
    },
    accessToken,
  );
}
