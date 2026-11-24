import type { ToolEgress } from "@deployments-ai/db";
import type { ToolAdapterDefinition } from "./types.ts";

/** Where a tool can send organization data. An unclassified tool counts as public. */
export function toolEgress(definition: ToolAdapterDefinition): ToolEgress {
  const execution = definition.execution;
  if (!execution) return "public";
  switch (execution.type) {
    case "builtin":
      return definition.egress ?? "public";
    case "client":
      return "platform";
    case "hosted_code":
      return execution.network === "none" ? "platform" : "public";
    case "http_callback":
    case "mcp":
    case "vendor_mcp":
      return "configured";
    default:
      return execution satisfies never;
  }
}
