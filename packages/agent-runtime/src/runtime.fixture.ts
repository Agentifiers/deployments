import type { Ulid } from "@deployments-ai/db";
import { createAgentRuntime } from "./index.ts";
import type { AgentRunInput, AgentRuntimeDependencies, RuntimeToolDefinition } from "./types.ts";

export const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}` as Ulid;

const TEST_TOOL_DEFINITIONS: Readonly<Record<string, RuntimeToolDefinition>> = {
  "provider.async": {
    description: "Start asynchronous provider work.",
    effect: "write",
    inputSchema: { additionalProperties: false, type: "object" },
    requiredScopes: [],
    toolName: "provider.async",
  },
  "provider.first": {
    description: "Read the first provider resource.",
    effect: "read",
    inputSchema: { additionalProperties: false, type: "object" },
    requiredScopes: [],
    toolName: "provider.first",
  },
  "provider.read": {
    description: "Read a provider resource.",
    effect: "read",
    inputSchema: {
      additionalProperties: false,
      properties: { resource: { type: "string" } },
      type: "object",
    },
    requiredScopes: [],
    toolName: "provider.read",
  },
  "provider.fetch": {
    description: "Fetch a page.",
    effect: "read",
    inputSchema: {
      additionalProperties: false,
      properties: { url: { type: "string" } },
      type: "object",
    },
    requiredScopes: [],
    toolName: "provider.fetch",
  },
  "provider.second": {
    description: "Write the second provider resource.",
    effect: "write",
    inputSchema: { additionalProperties: false, type: "object" },
    requiredScopes: [],
    toolName: "provider.second",
  },
  "provider.write": {
    description: "Write a provider resource.",
    effect: "write",
    inputSchema: { additionalProperties: false, type: "object" },
    requiredScopes: [],
    toolName: "provider.write",
  },
};

export function createTestAgentRuntime(dependencies: AgentRuntimeDependencies) {
  return createAgentRuntime({
    recordArtifact: async () => undefined,
    recordSandboxLease: async () => undefined,
    reportSandboxLeaseMismatch: async () => undefined,
    resolveToolDefinition: async (toolName) => TEST_TOOL_DEFINITIONS[toolName],
    ...dependencies,
  });
}

export type CustomerAgentRunInput = Extract<
  AgentRunInput,
  { readonly executionPurpose?: "customer" }
>;

export function input(overrides: Partial<CustomerAgentRunInput> = {}): CustomerAgentRunInput {
  return {
    agentDefinitionId: id("1"),
    agentDeploymentId: id("2"),
    agentManifestHash: "sha256:test-manifest",
    agentReleaseId: id("3"),
    captureMode: "metadata-only",
    environmentId: id("4"),
    instructions: "Be concise.",
    modelFallbackIds: ["openrouter/fallback"],
    modelId: "openrouter/primary",
    organizationId: id("5"),
    projectId: id("6"),
    prompt: "Summarize the result.",
    runId: id("7"),
    runAttempt: 0,
    runExecutionVersion: 1,
    sandboxPolicy: { mode: "none", provider: "aws_lambda_microvm" },
    spanId: "0123456789abcdef",
    threadId: id("8"),
    traceId: "0123456789abcdef0123456789abcdef",
    workspaceId: id("9"),
    ...overrides,
  };
}
