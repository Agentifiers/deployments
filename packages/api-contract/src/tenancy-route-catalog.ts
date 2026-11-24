import { archiveAgentDefinitionRoutes } from "./archive-agent-definition-routes.ts";
import { getProjectRoutes } from "./get-project-routes.ts";
import { listAgentDefinitionsRoutes } from "./list-agent-definitions-routes.ts";
import type { ApiRouteContract } from "./tenancy-route-definitions.ts";

export const TENANCY_API_ROUTES = [
  ...listAgentDefinitionsRoutes,
  ...archiveAgentDefinitionRoutes,
  ...getProjectRoutes,
] as const satisfies readonly ApiRouteContract[];
export type TenancyRouteName = (typeof TENANCY_API_ROUTES)[number]["name"];

export const TENANCY_ROUTE_BY_NAME: Readonly<Record<string, ApiRouteContract>> = Object.freeze(
  Object.fromEntries(TENANCY_API_ROUTES.map((contract) => [contract.name, contract])),
);

export function tenancyRouteContract(routeName: TenancyRouteName): ApiRouteContract {
  const route = TENANCY_ROUTE_BY_NAME[routeName];
  if (!route) throw new TypeError(`Unknown tenancy route: ${routeName}`);
  return route;
}
