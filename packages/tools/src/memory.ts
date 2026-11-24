import type { ToolAdapterDefinition } from "./types.ts";
const MAX_MEMORY_SEARCH_LIMIT = 20;

export const memoryToolAdapterDefinitions: readonly ToolAdapterDefinition[] = [
  {
    toolName: "agent.memory.search",
    description: "Search approved durable memory through governed retrieval.",
    effect: "read",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    status: "active",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: MAX_MEMORY_SEARCH_LIMIT },
        query: { type: "string" },
      },
      required: ["query"],
    },
    egress: "platform",
    execution: { type: "builtin", adapterKey: "agent.memory.search" },
  },
  {
    toolName: "agent.memory.save",
    description: "Save canonical durable memory for governed search indexing.",
    effect: "write",
    requiredScopes: [],
    defaultPolicyAction: "require_approval",
    providerOutboundMutation: true,
    status: "active",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        memorySpaceId: { type: "string" },
        scope: {
          type: "string",
          enum: ["thread", "agent", "workspace", "organization"],
        },
      },
      required: ["content"],
    },
    egress: "platform",
    execution: { type: "builtin", adapterKey: "agent.memory.save" },
  },
] as const;
