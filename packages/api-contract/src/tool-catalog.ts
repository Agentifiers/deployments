import { AgentToolName } from "@deployments-ai/agent-manifest/schema";
import { Schema } from "effect";
import { JsonValue, PublicId } from "./primitives.ts";
import type { PublicApiRouteContract } from "./route-contract.ts";

export const TOOL_CATALOG_STATUS_FILTERS = ["active", "archived", "all"] as const;
export const TOOL_POLICY_EVALUATION_MAX_TOOLS = 100;

const Action = Schema.Literals(["allow", "deny", "require_approval"]);
const ToolCatalogStatus = Schema.Literals(["active", "archived"]);

/**
 * `catalog` tools are decided by their catalog default alone; environment tool policies apply
 * only to `connection` tools (provider-native, MCP, and HTTP callback tools).
 */
const ToolPolicyBinding = Schema.Literals(["catalog", "connection"]);

const toolCatalogItemFields = {
  approvalRequired: Schema.Boolean,
  category: Schema.String,
  defaultPolicyAction: Action,
  description: Schema.String,
  effect: Schema.Literals(["execute", "read", "write"]),
  name: Schema.String,
  policyBinding: Schema.NullOr(ToolPolicyBinding),
  providerKey: Schema.optional(Schema.String),
  requiredScopes: Schema.Array(Schema.String),
  route: Schema.String,
  status: ToolCatalogStatus,
} as const;

export const ToolCatalogItem = Schema.Struct(toolCatalogItemFields);
export const ToolCatalogDetailResponse = Schema.Struct({
  ...toolCatalogItemFields,
  inputSchema: Schema.optional(Schema.Record(Schema.String, JsonValue)),
  outputSchema: Schema.optional(Schema.Record(Schema.String, JsonValue)),
});
export const ListToolsResponse = Schema.Struct({
  items: Schema.Array(ToolCatalogItem),
  nextCursor: Schema.NullOr(Schema.String),
});

const EvaluatedToolNames = Schema.Array(AgentToolName).pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(TOOL_POLICY_EVALUATION_MAX_TOOLS),
    Schema.isUnique({ message: "Tool names must not contain duplicates." }),
  ),
);
export const EvaluateToolPolicyRequest = Schema.Union([
  Schema.Struct({ toolNames: EvaluatedToolNames, toolPolicyId: PublicId }),
  Schema.Struct({ agentDeploymentId: PublicId, toolNames: Schema.optional(EvaluatedToolNames) }),
]);
export const ToolPolicyEvaluation = Schema.Struct({
  action: Action,
  /**
   * `rule`/`default`/`required_scopes` come from the policy evaluator; `unavailable` means the
   * runtime denies before policy evaluation (unknown or archived tool, missing binding).
   */
  basis: Schema.Literals(["default", "required_scopes", "rule", "unavailable"]),
  catalogStatus: Schema.Literals(["active", "archived", "unknown"]),
  matchedRuleIndex: Schema.NullOr(
    Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  ),
  policyApplies: Schema.Boolean,
  reason: Schema.String,
  toolName: Schema.String,
  toolPolicyId: Schema.NullOr(PublicId),
});
export const EvaluateToolPolicyResponse = Schema.Struct({
  agentDeploymentId: Schema.optional(PublicId),
  agentReleaseId: Schema.optional(PublicId),
  results: Schema.Array(ToolPolicyEvaluation),
  toolPolicyId: Schema.optional(PublicId),
});

export const TOOL_CATALOG_API_SCHEMAS = {
  EvaluateToolPolicyRequest,
  EvaluateToolPolicyResponse,
  ListToolsResponse,
  ToolCatalogDetailResponse,
  ToolCatalogItem,
  ToolPolicyEvaluation,
} as const;

type Input = Omit<
  PublicApiRouteContract,
  "authentication" | "errors" | "idempotency" | "requiredAuthorization" | "scopeHeaders" | "tag"
>;

/** Read-only routes: evaluation is a POST for its body but has no side effects. */
function toolCatalogRoute<const Route extends Input>(route: Route) {
  return {
    authentication: "platform-bearer" as const,
    errors: [400, 401, 403, 404, 422] as const,
    idempotency: "none" as const,
    requiredAuthorization: "tools:read" as const,
    scopeHeaders: "environment" as const,
    tag: "Tools" as const,
    ...route,
  };
}

export const TOOL_CATALOG_API_ROUTES = [
  toolCatalogRoute({
    method: "GET",
    name: "listTools",
    path: "/v1/tools",
    queryParameters: [
      { name: "cursor", schema: { maxLength: 4_096, minLength: 1, type: "string" } },
      { name: "limit", schema: { maximum: 100, minimum: 1, type: "integer" } },
      {
        description: "Only tools bound to this provider key.",
        name: "providerKey",
        schema: { maxLength: 128, minLength: 1, type: "string" },
      },
      {
        description: "Only tools whose name starts with this prefix.",
        name: "prefix",
        schema: { maxLength: 128, minLength: 1, type: "string" },
      },
      {
        description: "Catalog status; defaults to active.",
        name: "status",
        schema: { enum: TOOL_CATALOG_STATUS_FILTERS, type: "string" },
      },
      {
        description: "Case-insensitive substring of the tool name or description.",
        name: "search",
        schema: { maxLength: 100, minLength: 1, type: "string" },
      },
    ],
    responseBody: "ListToolsResponse",
    successStatus: 200,
  }),
  toolCatalogRoute({
    method: "GET",
    name: "getTool",
    path: "/v1/tools/:toolName",
    pathParameters: [
      { name: "toolName", schema: { maxLength: 128, minLength: 1, type: "string" } },
    ],
    responseBody: "ToolCatalogDetailResponse",
    successStatus: 200,
  }),
  toolCatalogRoute({
    method: "POST",
    name: "evaluateToolPolicy",
    path: "/v1/tool-policies/evaluate",
    requestBody: "EvaluateToolPolicyRequest",
    responseBody: "EvaluateToolPolicyResponse",
    successStatus: 200,
  }),
] as const satisfies readonly PublicApiRouteContract[];

export type ToolCatalogApiRouteName = (typeof TOOL_CATALOG_API_ROUTES)[number]["name"];
