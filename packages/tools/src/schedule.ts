import type { ToolAdapterDefinition } from "./types.ts";

export const scheduleToolAdapterDefinitions: readonly ToolAdapterDefinition[] = [
  {
    toolName: "agent.schedule.remind",
    description:
      "Create one proactive follow-up in the current conversation after a relative delay. Use this when the user asks to be contacted later. This tool cannot create recurring schedules.",
    effect: "write",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    providerOutboundMutation: true,
    status: "active",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        delayMinutes: { type: "integer", minimum: 1, maximum: 43_200 },
        name: { type: "string", minLength: 1, maxLength: 120 },
        prompt: { type: "string", minLength: 1, maxLength: 40_000 },
      },
      required: ["delayMinutes", "name", "prompt"],
    },
    egress: "platform",
    execution: { type: "builtin", adapterKey: "agent.schedule.remind" },
  },
  {
    toolName: "agent.schedule.create",
    description: "Create a scheduled proactive agent run.",
    effect: "write",
    requiredScopes: [],
    defaultPolicyAction: "require_approval",
    providerOutboundMutation: true,
    status: "active",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string" },
        kind: { type: "string", enum: ["cron", "interval"] },
        name: { type: "string" },
        prompt: { type: "string" },
        timezone: { type: "string" },
      },
      required: ["expression", "kind", "name", "prompt"],
    },
    egress: "platform",
    execution: { type: "builtin", adapterKey: "agent.schedule.create" },
  },
  {
    toolName: "agent.schedule.list",
    description: "List a bounded page of scheduled proactive runs for the current agent.",
    effect: "read",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    status: "active",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cursor: { type: "string", maxLength: 1_024 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    egress: "platform",
    execution: { type: "builtin", adapterKey: "agent.schedule.list" },
  },
  {
    toolName: "agent.schedule.archive",
    description: "Archive an existing scheduled proactive agent run.",
    effect: "write",
    requiredScopes: [],
    defaultPolicyAction: "require_approval",
    providerOutboundMutation: true,
    status: "active",
    inputSchema: {
      type: "object",
      properties: { scheduledJobId: { type: "string" } },
      required: ["scheduledJobId"],
    },
    egress: "platform",
    execution: { type: "builtin", adapterKey: "agent.schedule.archive" },
  },
] as const;
