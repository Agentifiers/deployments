import type { ToolAdapterDefinition } from "./types.ts";

export const artifactLifecycleToolAdapterDefinitions: readonly ToolAdapterDefinition[] = [
  {
    toolName: "artifact.inspect",
    description: "Inspect a run artifact and mint a short-lived inline access URL.",
    effect: "read",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    status: "active",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string" },
        disposition: { type: "string", enum: ["attachment", "inline"] },
        expiresInSeconds: { type: "integer", minimum: 60, maximum: 3_600 },
        sourceRunId: { type: "string" },
      },
      required: ["artifactId"],
    },
    egress: "platform",
    execution: { type: "builtin", adapterKey: "artifact.inspect" },
  },
  {
    toolName: "artifact.share",
    description: "Mark a run artifact shared and mint a short-lived access URL.",
    effect: "write",
    requiredScopes: [],
    defaultPolicyAction: "require_approval",
    providerOutboundMutation: true,
    status: "active",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string" },
        disposition: { type: "string", enum: ["attachment", "inline"] },
        expiresInSeconds: { type: "integer", minimum: 60, maximum: 3_600 },
        sourceRunId: { type: "string" },
      },
      required: ["artifactId"],
    },
    egress: "public",
    execution: { type: "builtin", adapterKey: "artifact.share" },
  },
  {
    toolName: "artifact.source_run",
    description: "List a bounded page of compact artifacts produced by a source run.",
    effect: "read",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    status: "active",
    inputSchema: {
      type: "object",
      properties: {
        cursor: { type: "string", maxLength: 4_096 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        sourceRunId: { type: "string" },
      },
      required: ["sourceRunId"],
    },
    egress: "platform",
    execution: { type: "builtin", adapterKey: "artifact.source_run" },
  },
  {
    toolName: "artifact.archive",
    description: "Archive a run artifact after owner approval.",
    effect: "write",
    requiredScopes: [],
    defaultPolicyAction: "require_approval",
    providerOutboundMutation: true,
    status: "active",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string" },
        sourceRunId: { type: "string" },
      },
      required: ["artifactId"],
    },
    egress: "platform",
    execution: { type: "builtin", adapterKey: "artifact.archive" },
  },
] as const;
