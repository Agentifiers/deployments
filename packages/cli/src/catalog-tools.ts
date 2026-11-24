import { TOOL_CATALOG_STATUS_FILTERS } from "@deployments-ai/api-contract/tool-catalog";
import type { CommandCatalog } from "./types.ts";
import {
  action,
  create,
  description,
  id,
  json,
  list,
  mutate,
  name,
  repeatable,
  requiredText,
  requiredJson,
  show,
  text,
} from "./catalog-helpers.ts";
import { expectedVersion } from "./catalog-agent-deployments.ts";

const TOOL_POLICIES_PATH = "/v1/tool-policies";
const pagination = { limitField: "limit", maxLimit: 100, target: "query" } as const;

export const toolCommandCatalog: CommandCatalog = {
  tool: {
    summary: "Platform tool catalog and hosted code tools",
    actions: {
      list: {
        ...list(
          "/v1/tools",
          "environment",
          "List code-owned platform tools with their default policy",
          pagination,
        ),
        args: {
          "provider-key": text("Only tools bound to this provider", "query"),
          prefix: text("Only tools whose name starts with this prefix", "query"),
          status: {
            definition: {
              type: "enum",
              description: "Catalog status (default active)",
              options: [...TOOL_CATALOG_STATUS_FILTERS],
            },
            target: "query",
          },
          search: text("Case-insensitive substring of the tool name or description", "query"),
        },
        columns: [
          "name",
          "providerKey",
          "effect",
          "defaultPolicyAction",
          "policyBinding",
          "status",
        ],
      },
      get: action({
        summary: "Show a platform tool with its input schema",
        method: "GET",
        path: "/v1/tools/:toolName",
        scope: "environment",
        output: "detail",
        args: { name: { ...requiredText("Tool name"), field: "toolName", target: "path" } },
      }),
    },
  },
  "tool-policy": {
    summary: "Tool permissions and approval policy",
    actions: {
      create: create(
        TOOL_POLICIES_PATH,
        "environment",
        { name, description, policy: requiredJson("Tool policy document") },
        "Create a tool policy",
      ),
      list: list(TOOL_POLICIES_PATH, "environment", "List tool policies", pagination),
      show: show(TOOL_POLICIES_PATH, "environment", "Show a tool policy"),
      update: mutate("PATCH", TOOL_POLICIES_PATH, "environment", "Update a tool policy", {
        id,
        policy: json("Tool policy document"),
        "expected-version": expectedVersion,
      }),
      archive: mutate("DELETE", TOOL_POLICIES_PATH, "environment", "Archive a tool policy"),
      evaluate: action({
        summary:
          "Show what a tool policy or an agent deployment's pinned policies decide for tools (no side effects)",
        method: "POST",
        path: `${TOOL_POLICIES_PATH}/evaluate`,
        scope: "environment",
        output: "list",
        listField: "results",
        pagination: false,
        args: {
          "tool-policy-id": text("Tool policy to evaluate (requires --tool)"),
          "agent-deployment-id": text("Agent deployment whose pinned tool policies to evaluate"),
          tool: { ...repeatable("Tool name to evaluate"), bodyField: "toolNames" },
        },
        columns: ["toolName", "action", "basis", "matchedRuleIndex", "catalogStatus", "reason"],
      }),
    },
  },
};
