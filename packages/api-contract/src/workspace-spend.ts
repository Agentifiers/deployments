import { Schema } from "effect";
import { monthSpendFields, spendMonthParameter } from "./organization-spend.ts";
import { PublicId } from "./primitives.ts";
import type { PublicApiRouteContract } from "./route-contract.ts";

export const WorkspaceSpendResponse = Schema.Struct({
  ...monthSpendFields,
  environmentId: PublicId,
  workspaceId: PublicId,
});

export const WORKSPACE_SPEND_API_SCHEMAS = { WorkspaceSpendResponse } as const;

export const WORKSPACE_SPEND_API_ROUTES = [
  {
    authentication: "platform-bearer",
    errors: [400, 401, 403, 404],
    idempotency: "none",
    method: "GET",
    name: "getWorkspaceSpend",
    path: "/v1/workspaces/:id/spend",
    queryParameters: [spendMonthParameter],
    requiredAuthorization: "spend:read",
    responseBody: "WorkspaceSpendResponse",
    scopeHeaders: "environment",
    successStatus: 200,
    tag: "Tenancy",
  },
] as const satisfies readonly PublicApiRouteContract[];
