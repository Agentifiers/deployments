import type { ToolAdapterDefinition } from "./types.ts";

export const providerApiToolAdapterDefinitions: readonly ToolAdapterDefinition[] = [
  {
    toolName: "provider.api.read",
    description: "Read from a connected provider API using the selected connector token.",
    effect: "read",
    requiredScopes: [],
    defaultPolicyAction: "deny",
    status: "archived",
    inputSchema: {
      type: "object",
      properties: {
        headers: { type: "object" },
        method: { type: "string", enum: ["GET"] },
        query: { type: "object" },
        url: { type: "string" },
      },
      required: ["url"],
    },
    egress: "configured",
    execution: { type: "builtin", adapterKey: "provider.api.read" },
  },
  {
    toolName: "provider.api.write",
    description: "Write to a connected provider API using the selected connector token.",
    effect: "write",
    requiredScopes: [],
    defaultPolicyAction: "deny",
    status: "archived",
    providerOutboundMutation: true,
    inputSchema: {
      type: "object",
      properties: {
        body: {},
        contentType: { type: "string" },
        headers: { type: "object" },
        method: { type: "string", enum: ["POST", "PUT", "PATCH", "DELETE"] },
        query: { type: "object" },
        url: { type: "string" },
      },
      required: ["url"],
    },
    egress: "configured",
    execution: { type: "builtin", adapterKey: "provider.api.write" },
  },
] as const;
