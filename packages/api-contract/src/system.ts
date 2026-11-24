import { Schema } from "effect";
import type { PublicApiRouteContract } from "./route-contract.ts";
import { SYSTEM_OPERATOR_API_ROUTES, SYSTEM_OPERATOR_API_SCHEMAS } from "./system-operator.ts";

export * from "./organization-spend.ts";
export * from "./organization-standing.ts";
export * from "./operator-access.ts";
export * from "./principal-status.ts";
export * from "./system-operator.ts";
export * from "./system-principals.ts";

export const HealthResponse = Schema.Struct({
  service: Schema.String,
  status: Schema.Literal("ok"),
});

export const SYSTEM_API_SCHEMAS = {
  HealthResponse,
  ...SYSTEM_OPERATOR_API_SCHEMAS,
} as const;

export const SYSTEM_API_ROUTES = [
  {
    authentication: "none",
    errors: [500],
    idempotency: "none",
    method: "GET",
    name: "getHealth",
    path: "/health",
    responseBody: "HealthResponse",
    scopeHeaders: "none",
    successStatus: 200,
    tag: "System",
  },
  ...SYSTEM_OPERATOR_API_ROUTES,
] as const satisfies readonly PublicApiRouteContract[];
