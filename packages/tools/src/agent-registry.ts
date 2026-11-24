import type { ToolAdapterDefinition } from "./types.ts";

export const agentRegistryToolAdapterDefinitions: readonly ToolAdapterDefinition[] = [
  {
    toolName: "agent.registry.search",
    description:
      "Search the deployments.ai platform agent registry for agents in the current run workspace.",
    effect: "read",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    status: "active",
    inputSchema: {
      type: "object",
      properties: {
        limit: { maximum: 100, minimum: 1, type: "integer" },
        query: { type: "string" },
        status: { enum: ["active", "paused", "archived"], type: "string" },
        workspaceId: { type: "string" },
      },
    },
    egress: "platform",
    execution: { type: "builtin", adapterKey: "agent.registry.search" },
  },
  {
    toolName: "agent.registry.get",
    description:
      "Get safe registry details for one deployments.ai platform agent in the current organization.",
    effect: "read",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    status: "active",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
      },
      required: ["agentId"],
    },
    egress: "platform",
    execution: { type: "builtin", adapterKey: "agent.registry.get" },
  },
] as const;
