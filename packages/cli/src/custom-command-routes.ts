import type { PublicApiRouteContract } from "@deployments-ai/api-contract/route-contract";

export type CustomCommandRoute = Pick<PublicApiRouteContract, "method" | "path">;

export const customCommandRoutes: Readonly<
  Record<string, readonly [CustomCommandRoute, ...CustomCommandRoute[]]>
> = {
  "auth login": [
    { method: "POST", path: "/v1/device-authorizations" },
    { method: "POST", path: "/v1/device-authorizations/token" },
    { method: "GET", path: "/v1/whoami" },
  ],
  "auth logout": [{ method: "POST", path: "/v1/device-authorizations/revoke" }],
  whoami: [{ method: "GET", path: "/v1/whoami" }],
  chat: [
    { method: "POST", path: "/v1/threads" },
    { method: "POST", path: "/v1/artifacts" },
    { method: "POST", path: "/v1/artifacts/:artifactId/complete" },
    { method: "POST", path: "/v1/agent-deployments/:agentDeploymentId/runs" },
  ],
  health: [{ method: "GET", path: "/health" }],
};
