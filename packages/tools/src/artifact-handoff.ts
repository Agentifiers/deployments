import type { ToolAdapterDefinition } from "./types.ts";

const MAX_HANDOFF_LIST_LIMIT = 100;

export const ARTIFACT_HANDOFF_CONTENT_TYPE_PLACEHOLDER = "{{artifact.contentType}}";
export const ARTIFACT_HANDOFF_FILE_NAME_PLACEHOLDER = "{{artifact.fileName}}";
export const ARTIFACT_HANDOFF_URL_PLACEHOLDER = "{{artifact.url}}";

export const artifactHandoffToolAdapterDefinitions: readonly ToolAdapterDefinition[] = [
  {
    toolName: "artifact.provider_handoffs.list",
    description:
      "List current-run artifacts that are ready to hand off into first-class provider write tools.",
    effect: "read",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    status: "active",
    inputSchema: {
      type: "object",
      properties: {
        cursor: { type: "string", maxLength: 4_096 },
        limit: { type: "integer", minimum: 1, maximum: MAX_HANDOFF_LIST_LIMIT },
        provider: { type: "string" },
        toolName: { type: "string" },
      },
    },
    egress: "platform",
    execution: { type: "builtin", adapterKey: "artifact.provider_handoffs.list" },
  },
  {
    toolName: "artifact.provider_handoffs.prepare",
    description:
      "Prepare a current-run artifact for provider write handoff by minting a short-lived access URL.",
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
      },
      required: ["artifactId"],
    },
    egress: "platform",
    execution: { type: "builtin", adapterKey: "artifact.provider_handoffs.prepare" },
  },
  {
    toolName: "artifact.provider_handoffs.plan_write",
    description: "Plan the approval-gated provider write input for a current-run artifact handoff.",
    effect: "write",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    providerOutboundMutation: true,
    status: "active",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string" },
        artifactStatus: { type: "string", enum: ["approved", "published"] },
        disposition: { type: "string", enum: ["attachment", "inline"] },
        expiresInSeconds: { type: "integer", minimum: 60, maximum: 3_600 },
        provider: { type: "string" },
        providerInput: {
          type: "object",
          description:
            "Exact provider-tool input. At least one string field must contain {{artifact.url}}; the runtime replaces artifact placeholders before approval and execution.",
        },
        toolName: { type: "string" },
      },
      required: ["artifactId", "provider", "providerInput", "toolName"],
    },
    egress: "platform",
    execution: { type: "builtin", adapterKey: "artifact.provider_handoffs.plan_write" },
  },
  {
    toolName: "artifact.provider_handoffs.record_result",
    description:
      "Record the external provider id, URL, or status produced by a first-class provider write tool.",
    effect: "write",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    providerOutboundMutation: true,
    status: "active",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string" },
        handoffIntentId: { type: "string" },
        idempotencyKey: { type: "string" },
        provider: { type: "string" },
        sourceToolCallId: { type: "string" },
        toolName: { type: "string" },
      },
      required: ["artifactId", "handoffIntentId", "provider", "sourceToolCallId", "toolName"],
    },
    egress: "platform",
    execution: { type: "builtin", adapterKey: "artifact.provider_handoffs.record_result" },
  },
] as const;
