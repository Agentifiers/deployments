import type { Ulid } from "@deployments-ai/db";
import { DEFAULT_AGENT_MODEL_ID } from "@deployments-ai/model-gateway";
import type { RuntimeModelGenerationRequest } from "./types.ts";

export type CustomerRuntimeModelGenerationRequest = Extract<
  RuntimeModelGenerationRequest,
  { readonly executionPurpose?: "customer" }
>;

export const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}` as Ulid;
export const gemma4Route = {
  modelId: "openrouter/example/custom-gemma4",
  modelInputTokenBudget: 8_192,
  modelOutputTokenReserve: 512,
  modelToolProtocol: "gemma4",
} as const;

export function request(
  overrides: Partial<CustomerRuntimeModelGenerationRequest> = {},
): CustomerRuntimeModelGenerationRequest {
  return {
    agentDefinitionId: id("1"),
    agentDeploymentId: id("2"),
    agentManifestHash: "sha256:test-manifest",
    agentReleaseId: id("3"),
    brainEvidence: [],
    captureMode: "metadata-only",
    completedToolCalls: [],
    environmentId: id("4"),
    instructions: "Use the run evidence.",
    memories: [],
    modelCallId: "model-call-1",
    modelToolCallSlots: [],
    modelId: DEFAULT_AGENT_MODEL_ID,
    organizationId: id("5"),
    projectId: id("6"),
    prompt: "Report the artifact result.",
    recentMessages: [],
    runId: id("7"),
    sandboxArtifacts: [],
    spanId: "0123456789abcdef",
    skills: [],
    threadId: id("8"),
    traceId: "0123456789abcdef0123456789abcdef",
    tools: [],
    ...overrides,
  };
}
