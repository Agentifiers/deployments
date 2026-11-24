import {
  AGENT_DELEGATE_TOOL_NAME,
  assertValidAgentManifest,
  type AgentManifestV1,
  type AgentMemoryReviewMode,
  type AgentModelOptions,
  type AgentResponseDepthPolicy,
  type AgentSubAgent,
} from "@deployments-ai/agent-manifest";
import { PLATFORM_SKILLS } from "@deployments-ai/tools/platform-skills";
import type {
  RuntimeMemoryMode,
  RuntimeSandboxPolicy,
  RuntimeToolRequest,
} from "@deployments-ai/agent-runtime";

const DEFAULT_RECENT_MESSAGE_CHARACTER_BUDGET = 64 * 1_024;
const DEFAULT_CONTEXT_CHECKPOINT_MODE = "off" as const;

export interface CompiledAgentManifestRuntime {
  readonly contextCheckpointMode: "auto" | "off";
  readonly instructions: string;
  readonly maxModelGenerations?: number;
  readonly maxToolCalls?: number;
  readonly memoryMode: RuntimeMemoryMode;
  /** Unset unless the manifest sets it, so the memory platform can apply its own default. */
  readonly memoryReviewMode?: AgentMemoryReviewMode;
  readonly modelFallbackIds: readonly string[];
  readonly modelId: string;
  readonly modelInputTokenBudget?: number;
  readonly modelOptions?: AgentModelOptions;
  readonly modelOutputTokenReserve?: number;
  readonly modelToolProtocol?: "gemma4";
  readonly modelToolNames: readonly string[];
  readonly recentMessageCharacterBudget: number;
  readonly responseDepthPolicy?: AgentResponseDepthPolicy;
  readonly sandboxPolicy: RuntimeSandboxPolicy;
  readonly skills: readonly string[];
  readonly toolRequests: readonly RuntimeToolRequest[];
  readonly toolResultImages?: "screenshots";
}

/** Lists release-declared sub-agents so the model can choose a delegate target by key. */
function instructionsWithSubAgents(instructions: string, agents: readonly AgentSubAgent[]) {
  if (agents.length === 0) return instructions;
  const entries = agents.map(
    (agent) =>
      `- ${agent.key} (${agent.awaitResult ? "returns its final answer to you" : "runs independently; only its run ID is returned"}): ${agent.description}`,
  );
  return [
    instructions,
    "",
    `Declared sub-agents. Call ${AGENT_DELEGATE_TOOL_NAME} with targetAgentId set to one of these keys:`,
    ...entries,
  ].join("\n");
}

export function compileAgentManifestRuntime(input: AgentManifestV1): CompiledAgentManifestRuntime {
  const manifest = assertValidAgentManifest(input);
  const sandbox = manifest.spec.sandbox;
  return {
    contextCheckpointMode:
      manifest.spec.runtime?.contextCheckpointMode ?? DEFAULT_CONTEXT_CHECKPOINT_MODE,
    instructions: instructionsWithSubAgents(manifest.spec.instructions, manifest.spec.agents ?? []),
    ...(manifest.spec.runtime?.maxModelGenerations !== undefined
      ? { maxModelGenerations: manifest.spec.runtime.maxModelGenerations }
      : {}),
    ...(manifest.spec.runtime?.maxToolCalls !== undefined
      ? { maxToolCalls: manifest.spec.runtime.maxToolCalls }
      : {}),
    memoryMode: manifest.spec.memory?.mode ?? "off",
    ...(manifest.spec.memory?.reviewMode
      ? { memoryReviewMode: manifest.spec.memory.reviewMode }
      : {}),
    modelFallbackIds: manifest.spec.model.fallbackIds ?? [],
    modelId: manifest.spec.model.id,
    ...(manifest.spec.runtime?.modelInputTokenBudget !== undefined
      ? { modelInputTokenBudget: manifest.spec.runtime.modelInputTokenBudget }
      : {}),
    ...(manifest.spec.model.options !== undefined
      ? { modelOptions: manifest.spec.model.options }
      : {}),
    ...(manifest.spec.runtime?.modelOutputTokenReserve !== undefined
      ? { modelOutputTokenReserve: manifest.spec.runtime.modelOutputTokenReserve }
      : {}),
    ...(manifest.spec.runtime?.modelToolProtocol !== undefined
      ? { modelToolProtocol: manifest.spec.runtime.modelToolProtocol }
      : {}),
    modelToolNames: manifest.spec.runtime?.modelTools ?? [],
    recentMessageCharacterBudget:
      manifest.spec.runtime?.recentMessageCharacterBudget ??
      DEFAULT_RECENT_MESSAGE_CHARACTER_BUDGET,
    ...(manifest.spec.runtime?.responseDepthPolicy !== undefined
      ? { responseDepthPolicy: manifest.spec.runtime.responseDepthPolicy }
      : {}),
    sandboxPolicy: {
      mode: sandbox.mode,
      provider: sandbox.provider ?? "aws_lambda_microvm",
      ...(sandbox.accessPolicyRef ? { accessPolicyRef: sandbox.accessPolicyRef } : {}),
      ...(sandbox.imageRef ? { imageRef: sandbox.imageRef } : {}),
      ...(sandbox.minMemoryMiB !== undefined ? { minMemoryMiB: sandbox.minMemoryMiB } : {}),
      ...(sandbox.minVcpu !== undefined ? { minVcpu: sandbox.minVcpu } : {}),
      ...(sandbox.poolKey ? { poolKey: sandbox.poolKey } : {}),
    },
    // Platform skills come first, so the release's own skills can refine them.
    skills: [
      ...(manifest.spec.platformSkills ?? []).map((name) => PLATFORM_SKILLS[name]),
      ...(manifest.spec.skills ?? []),
    ],
    toolRequests: (manifest.spec.runtime?.toolRequests ?? []).map((request) => ({
      effect: request.effect,
      idempotencyKey: request.idempotencyKey,
      ...(request.input ? { input: request.input } : {}),
      inputSummary: request.inputSummary,
      requiredScopes: request.requiredScopes,
      toolName: request.toolName,
    })),
    ...(manifest.spec.runtime?.toolResultImages !== undefined
      ? { toolResultImages: manifest.spec.runtime.toolResultImages }
      : {}),
  };
}
