import { AGENT_EMAIL_API_ROUTES } from "./agent-email.ts";
import { APPS_API_ROUTES } from "./apps-routes.ts";
import { EGRESS_ALLOWLIST_API_ROUTES } from "./egress-allowlist.ts";
import { EMAIL_API_ROUTES } from "./email.ts";
import { BRAIN_API_ROUTES } from "./brains.ts";
import { GOVERNANCE_API_ROUTES } from "./governance.ts";
import { IDENTITY_API_ROUTES } from "./identity.ts";
import { IDENTITY_FEDERATION_API_ROUTES } from "./identity-federation.ts";
import { DIRECTORY_API_ROUTES } from "./directory.ts";
import { MEMORY_API_ROUTES } from "./memory.ts";
import { OPERATIONS_API_ROUTES } from "./operations.ts";
import { MODEL_API_ROUTES } from "./model-routes.ts";
import { MODEL_CREDENTIAL_API_ROUTES } from "./model-credentials.ts";
import { OBSERVABILITY_API_ROUTES } from "./observability.ts";
import { ORGANIZATION_SPEND_API_ROUTES } from "./organization-spend.ts";
import { EVALUATION_API_ROUTES } from "./evaluation-routes.ts";
import type { PublicApiRouteContract } from "./route-contract.ts";
import { TENANCY_API_ROUTES } from "./routes.ts";
import { RUNTIME_API_ROUTES, STREAM_GATEWAY_API_ROUTES } from "./runtime.ts";
import { SYSTEM_API_ROUTES } from "./system.ts";
import { PROVIDER_API_ROUTES } from "./providers.ts";
import { CREDENTIAL_REFERENCE_API_ROUTES } from "./credential-references.ts";
import { BUDGET_API_ROUTES } from "./budgets.ts";
import { MONITOR_API_ROUTES } from "./monitors.ts";
import { TOOLING_API_ROUTES } from "./tooling.ts";
import { TOOL_CATALOG_API_ROUTES } from "./tool-catalog.ts";
import { WORKSPACE_SPEND_API_ROUTES } from "./workspace-spend.ts";

const tenancyListQueryParameters = [
  {
    name: "cursor",
    schema: { maxLength: 4_096, minLength: 1, type: "string" },
  },
  {
    name: "limit",
    schema: { maximum: 100, minimum: 1, type: "integer" },
  },
] as const;

function publicTenancyRoute<const Route extends (typeof TENANCY_API_ROUTES)[number]>(
  route: Route,
): PublicApiRouteContract & { readonly name: Route["name"] } {
  return {
    authentication: "platform-bearer",
    errors: route.errors,
    idempotency: "idempotent" in route && route.idempotent ? "required" : "none",
    method: route.method,
    name: route.name,
    path: route.path,
    ...(route.method === "GET" && route.name.startsWith("list")
      ? { queryParameters: tenancyListQueryParameters }
      : {}),
    ...("requestBody" in route && route.requestBody ? { requestBody: route.requestBody } : {}),
    ...(!("requestBodyRequired" in route) || route.requestBodyRequired === undefined
      ? {}
      : { requestBodyRequired: route.requestBodyRequired }),
    responseBody: route.responseBody,
    scopeHeaders: route.scope,
    ...("standing" in route ? { standing: route.standing } : {}),
    successStatus: route.successStatus,
    tag: ("tag" in route ? route.tag : undefined) ?? "Tenancy",
  };
}

export const PUBLIC_TENANCY_API_ROUTES = TENANCY_API_ROUTES.map(publicTenancyRoute);

export const PUBLIC_API_ROUTES = Object.freeze([
  ...PUBLIC_TENANCY_API_ROUTES,
  ...IDENTITY_API_ROUTES,
  ...IDENTITY_FEDERATION_API_ROUTES,
  ...DIRECTORY_API_ROUTES,
  ...AGENT_EMAIL_API_ROUTES,
  ...EMAIL_API_ROUTES,
  ...APPS_API_ROUTES,
  ...BRAIN_API_ROUTES,
  ...RUNTIME_API_ROUTES,
  ...STREAM_GATEWAY_API_ROUTES,
  ...MEMORY_API_ROUTES,
  ...OPERATIONS_API_ROUTES,
  ...OBSERVABILITY_API_ROUTES,
  ...EVALUATION_API_ROUTES,
  ...GOVERNANCE_API_ROUTES,
  ...SYSTEM_API_ROUTES,
  ...PROVIDER_API_ROUTES,
  ...TOOLING_API_ROUTES,
  ...CREDENTIAL_REFERENCE_API_ROUTES,
  ...BUDGET_API_ROUTES,
  ...TOOL_CATALOG_API_ROUTES,
  ...MODEL_API_ROUTES,
  ...MODEL_CREDENTIAL_API_ROUTES,
  ...EGRESS_ALLOWLIST_API_ROUTES,
  ...ORGANIZATION_SPEND_API_ROUTES,
  ...WORKSPACE_SPEND_API_ROUTES,
  ...MONITOR_API_ROUTES,
]) satisfies readonly PublicApiRouteContract[];

export type PublicRouteName = (typeof PUBLIC_API_ROUTES)[number]["name"];

function uniqueRouteIndex(): Readonly<Record<PublicRouteName, PublicApiRouteContract>> {
  const names = new Set<string>();
  const methodPaths = new Set<string>();
  const entries: [PublicRouteName, PublicApiRouteContract][] = [];

  for (const route of PUBLIC_API_ROUTES) {
    const methodPath = `${route.method} ${route.path.replaceAll(/:[^/]+/gu, "{}")}`;
    if (names.has(route.name)) throw new TypeError(`Duplicate public operation id: ${route.name}`);
    if (methodPaths.has(methodPath))
      throw new TypeError(`Duplicate public API route: ${methodPath}`);
    names.add(route.name);
    methodPaths.add(methodPath);
    entries.push([route.name, route]);
  }
  return Object.freeze(Object.fromEntries(entries)) as Readonly<
    Record<PublicRouteName, PublicApiRouteContract>
  >;
}

export const PUBLIC_ROUTE_BY_NAME = uniqueRouteIndex();

export function publicRouteContract(name: PublicRouteName): PublicApiRouteContract {
  return PUBLIC_ROUTE_BY_NAME[name];
}
