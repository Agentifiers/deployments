import type { ToolAdapterDefinition } from "./types.ts";

export const agentDelegationToolAdapterDefinitions: readonly ToolAdapterDefinition[] = [
  {
    toolName: "agent.delegate",
    description:
      "Delegate a structured work request to another deployments.ai platform agent and create a parent-child run edge. When the calling release declares sub-agents, targetAgentId must be a declared sub-agent key (or the deployment ID bound to it); sub-agents declared with awaitResult pause this run until the child run finishes and return its final answer.",
    effect: "execute",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    providerOutboundMutation: true,
    status: "active",
    inputSchema: {
      type: "object",
      properties: {
        constraints: { type: "array", items: { type: "string" }, maxItems: 50 },
        edgeKind: {
          type: "string",
          enum: ["delegation", "handoff", "approval_followup", "scheduled_child"],
        },
        idempotencyKey: { type: "string" },
        input: { type: "object" },
        metadata: { type: "object" },
        priority: { type: "integer", maximum: 99_999_999, minimum: 0 },
        prompt: { type: "string" },
        requestedOutcome: { type: "string" },
        targetAgentId: { type: "string" },
        title: { type: "string" },
      },
      required: ["prompt", "targetAgentId"],
    },
    egress: "platform",
    execution: { type: "builtin", adapterKey: "agent.delegate" },
  },
] as const;
