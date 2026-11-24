import type {
  PublicApiRouteContract,
  PublicApiStanding,
} from "@deployments-ai/api-contract/route-contract";
import type { ApiActivity } from "./activity-policy.ts";

const ACTIVITY_BY_STANDING = {
  distribution: "api.distribute",
  erasure: "api.erase",
  read: "api.read",
  remediation: "api.remediate",
} as const satisfies Record<PublicApiStanding, ApiActivity>;

type ClassifiedRoute = Pick<PublicApiRouteContract, "method" | "path" | "standing"> &
  Partial<Pick<PublicApiRouteContract, "tag">>;

/** For an edge that already matched its request to a route contract. */
export function routeActivity(route: ClassifiedRoute): ApiActivity {
  if (route.method === "GET") return "api.read";
  if (route.tag === "System") return "api.operate";
  return route.standing ? ACTIVITY_BY_STANDING[route.standing] : "api.write";
}

/**
 * Classifies requests by the route contract they match, so an edge that routes by hand classifies
 * the same way as one that matched a contract. A literal segment wins over a path parameter, so
 * `/v1/runs/search` is never read as `/v1/runs/:runId`. A mutation that matches no route is a write.
 */
export function apiRequestClassifier(routes: readonly ClassifiedRoute[]) {
  const mutations = routes
    .filter((route) => route.method !== "GET")
    .map((route) => {
      const segments = route.path.split("/");
      const pattern = segments
        .map((segment) =>
          segment.startsWith(":") ? "[^/]+" : segment.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
        )
        .join("/");
      return {
        parameters: segments.filter((segment) => segment.startsWith(":")).length,
        pattern: new RegExp(`^${pattern}/?$`, "u"),
        route,
      };
    })
    .toSorted((left, right) => left.parameters - right.parameters);
  return (method: string, pathname: string): ApiActivity => {
    if (method === "GET" || method === "HEAD") return "api.read";
    const matched = mutations.find(
      (candidate) => candidate.route.method === method && candidate.pattern.test(pathname),
    );
    return matched ? routeActivity(matched.route) : "api.write";
  };
}
