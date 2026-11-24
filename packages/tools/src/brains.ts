import type { ToolAdapterDefinition } from "./types.ts";

const brainIds = {
  type: "array",
  minItems: 1,
  maxItems: 20,
  uniqueItems: true,
  items: { type: "string" },
} as const;

export const brainToolAdapterDefinitions: readonly ToolAdapterDefinition[] = [
  {
    toolName: "agent.brain.capture",
    description:
      "Capture an attributable text note as a new immutable version in one explicitly mounted Brain source.",
    effect: "write",
    requiredScopes: [],
    defaultPolicyAction: "require_approval",
    status: "active",
    inputSchema: {
      type: "object",
      properties: {
        brainId: { type: "string" },
        content: { type: "string", minLength: 1, maxLength: 1_000_000 },
        externalItemIdentity: { type: "string", minLength: 1, maxLength: 1_024 },
        mediaType: { type: "string", enum: ["application/json", "text/markdown", "text/plain"] },
        sourceId: { type: "string" },
        sourceRevision: { type: "string", minLength: 1, maxLength: 1_024 },
        title: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["brainId", "content", "externalItemIdentity", "sourceId", "title"],
    },
    egress: "platform",
    execution: { type: "builtin", adapterKey: "agent.brain.capture" },
  },
  {
    toolName: "agent.brain.get_document",
    description:
      "Read a bounded byte range from the current immutable text evidence for one authorized Brain document.",
    effect: "read",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    status: "active",
    inputSchema: {
      type: "object",
      properties: {
        brainId: { type: "string" },
        documentId: { type: "string" },
        maxBytes: { type: "integer", minimum: 1, maximum: 65_536 },
        startByte: { type: "integer", minimum: 0 },
      },
      required: ["brainId", "documentId"],
    },
    egress: "platform",
    execution: { type: "builtin", adapterKey: "agent.brain.get_document" },
  },
  {
    toolName: "agent.brain.get_entity",
    description:
      "Read one canonical Brain entity and its bounded, source-provenance relationships.",
    effect: "read",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    status: "active",
    inputSchema: {
      type: "object",
      properties: {
        brainId: { type: "string" },
        edgeLimit: { type: "integer", minimum: 1, maximum: 50 },
        entityId: { type: "string" },
      },
      required: ["brainId", "entityId"],
    },
    egress: "platform",
    execution: { type: "builtin", adapterKey: "agent.brain.get_entity" },
  },
  {
    toolName: "agent.brain.search",
    description:
      "Search explicitly selected, deployment-mounted Brains and return source-grounded evidence with stable citations.",
    effect: "read",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    status: "active",
    inputSchema: {
      type: "object",
      properties: {
        brainIds,
        limit: { type: "integer", minimum: 1, maximum: 20 },
        query: { type: "string" },
      },
      required: ["brainIds", "query"],
    },
    egress: "platform",
    execution: { type: "builtin", adapterKey: "agent.brain.search" },
  },
  {
    toolName: "agent.brain.ask",
    description:
      "Synthesize a cited answer from explicitly selected, deployment-mounted Brains while reporting authorization-safe evidence gaps.",
    effect: "read",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    status: "active",
    inputSchema: {
      type: "object",
      properties: {
        brainIds,
        evidenceLimit: { type: "integer", minimum: 1, maximum: 20 },
        question: { type: "string" },
      },
      required: ["brainIds", "question"],
    },
    egress: "platform",
    execution: { type: "builtin", adapterKey: "agent.brain.ask" },
  },
] as const;
