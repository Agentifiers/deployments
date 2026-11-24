import { Schema, SchemaTransformation } from "effect";
import { isJsonValueWithinDepth } from "./json.ts";
import { AgentResponseFormat } from "./response-format.ts";

export const AGENT_MANIFEST_API_VERSION = "agents.deployments.ai/v1" as const;
export const AGENT_DEPLOYMENT_CONFIG_API_VERSION = "agents.deployments.ai/v1" as const;

export const MAX_AGENT_INSTRUCTIONS_CHARACTERS = 128 * 1_024;
export const MAX_AGENT_MODEL_FALLBACKS = 3;
export const MAX_AGENT_SANDBOX_MEMORY_MIB = 1_048_576;
export const MAX_AGENT_SANDBOX_VCPU = 4_096;
export const MAX_AGENT_SKILL_COUNT = 32;
export const MAX_AGENT_SKILL_CHARACTERS = 8 * 1_024;
export const MAX_AGENT_MODEL_TOOLS = 256;
export const MAX_AGENT_TOOL_IDEMPOTENCY_KEY_CHARACTERS = 256;
export const MAX_AGENT_TOOL_REQUESTS = 29;
export const DEFAULT_AGENT_MODEL_GENERATIONS = 16;
export const MAX_AGENT_MODEL_GENERATIONS = 32;
export const DEFAULT_AGENT_TOOL_CALLS = 29;
export const MAX_AGENT_TOOL_CALLS = 64;
export const MAX_AGENT_TOOL_INPUT_DEPTH = 16;
export const MAX_AGENT_TOOL_INPUT_UTF8_BYTES = 32 * 1_024;
export const MAX_AGENT_MANIFEST_UTF8_BYTES = 320 * 1_024;
export const MAX_RECENT_MESSAGE_CHARACTER_BUDGET = 1_000_000;
export const MAX_MODEL_INPUT_TOKEN_BUDGET = 1_000_000;
// Every currently supported model route has at least a 32K context window. Preserve the minimum
// 1,024-token input budget even when a release selects the largest portable output reserve.
export const MAX_MODEL_OUTPUT_TOKEN_RESERVE = 32_768 - 1_024;
export const MAX_AGENT_SUB_AGENTS = 16;
export const MAX_AGENT_SUB_AGENT_DESCRIPTION_CHARACTERS = 4_096;
/** Maximum number of delegation edges from a root run when a release declares sub-agents. */
export const MAX_AGENT_DELEGATION_DEPTH = 4;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function isBoundedJsonValue(input: unknown): input is JsonValue {
  return isJsonValueWithinDepth(input, MAX_AGENT_TOOL_INPUT_DEPTH + 1);
}

const JsonValueJson: Schema.Codec<JsonValue> = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.Number.pipe(
    Schema.check(
      Schema.isFinite(),
      Schema.isGreaterThanOrEqualTo(Number.MIN_SAFE_INTEGER),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
  ),
  Schema.String,
  Schema.Array(Schema.suspend(() => JsonValue)),
  Schema.Record(
    Schema.String,
    Schema.suspend(() => JsonValue),
  ),
]);

export const JsonValue = Schema.declare<JsonValue>(isBoundedJsonValue, {
  description: "A bounded JSON-compatible value.",
  title: "JsonValue",
  toCodecJson: () =>
    Schema.link<JsonValue>()(
      JsonValueJson,
      SchemaTransformation.transform({
        decode: (input) => input,
        encode: (input) => input,
      }),
    ),
});

const TrimmedNonEmptyString = Schema.String.pipe(
  Schema.check(
    Schema.isTrimmed({ message: "Values must not contain surrounding whitespace." }),
    Schema.isMinLength(1, { message: "Values must not be empty." }),
  ),
);

function hasControlCharacter(input: string): boolean {
  for (const character of input) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export const AgentManifestKey = TrimmedNonEmptyString.pipe(
  Schema.check(
    Schema.isMaxLength(128, { message: "Agent manifest keys must not exceed 128 characters." }),
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u, {
      message:
        "Agent manifest keys must use lowercase ASCII letters, numbers, dots, underscores, or hyphens.",
    }),
  ),
);

export const AgentManifestVersion = TrimmedNonEmptyString.pipe(
  Schema.check(
    Schema.isMaxLength(64, { message: "Agent manifest versions must not exceed 64 characters." }),
    Schema.isPattern(
      /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
      {
        message: "Agent manifest versions must use semantic version syntax.",
      },
    ),
  ),
);

export const AGENT_TOOL_NAME_PATTERN_SOURCE = "^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,254}[A-Za-z0-9])?$";

export const AgentToolName = TrimmedNonEmptyString.pipe(
  Schema.check(
    Schema.isMaxLength(256, { message: "Tool names must not exceed 256 characters." }),
    Schema.isPattern(new RegExp(AGENT_TOOL_NAME_PATTERN_SOURCE, "u"), {
      message:
        "Tool names must use ASCII letters, numbers, dots, underscores, slashes, or hyphens without edge separators.",
    }),
  ),
);

export const AgentScopeName = TrimmedNonEmptyString.pipe(
  Schema.check(
    Schema.isMaxLength(2_048, { message: "Scopes must not exceed 2048 characters." }),
    Schema.makeFilter<string>((input) =>
      hasControlCharacter(input) ? "Scopes must not contain control characters." : undefined,
    ),
  ),
);

export const AgentMemoryMode = Schema.Literals([
  "agent",
  "off",
  "organization",
  "thread",
  "workspace",
]);

export const AgentMemoryReviewMode = Schema.Literals(["auto-approve", "manual"]);
export type AgentMemoryReviewMode = typeof AgentMemoryReviewMode.Type;

export const AgentMemoryTranscriptPrivacy = Schema.Literals(["omit", "redact", "retain"]);
export type AgentMemoryTranscriptPrivacy = typeof AgentMemoryTranscriptPrivacy.Type;

export const AgentTrigger = Schema.Literals([
  "api",
  "chat",
  "email",
  "heartbeat",
  "schedule",
  "webhook",
  "workflow",
]);
export type AgentTrigger = typeof AgentTrigger.Type;

export const AgentSandboxProvider = Schema.Literal("aws_lambda_microvm");

function boundedPositiveNumber(maximum: number, field: string) {
  return Schema.Number.pipe(
    Schema.check(
      Schema.isFinite(),
      Schema.isGreaterThan(0, { message: "Resource reservations must be greater than zero." }),
      Schema.isLessThanOrEqualTo(maximum, {
        message: `${field} must not exceed ${maximum}.`,
      }),
    ),
  );
}

export const AgentSandboxPolicy = Schema.Struct({
  accessPolicyRef: Schema.optional(TrimmedNonEmptyString),
  imageRef: Schema.optional(TrimmedNonEmptyString),
  minMemoryMiB: Schema.optional(
    boundedPositiveNumber(MAX_AGENT_SANDBOX_MEMORY_MIB, "Sandbox minMemoryMiB"),
  ),
  minVcpu: Schema.optional(boundedPositiveNumber(MAX_AGENT_SANDBOX_VCPU, "Sandbox minVcpu")),
  mode: Schema.Literals(["none", "run-ephemeral", "thread-persistent"]),
  poolKey: Schema.optional(TrimmedNonEmptyString),
  provider: Schema.optional(AgentSandboxProvider),
});

export const AgentToolCapability = Schema.Struct({
  authorization: Schema.optional(Schema.Literals(["none", "workspace"])),
  name: AgentToolName,
  required: Schema.Boolean,
  requiredScopes: Schema.Array(AgentScopeName).pipe(
    Schema.check(Schema.isUnique({ message: "Tool scopes must not contain duplicates." })),
  ),
});
export type AgentToolCapability = typeof AgentToolCapability.Type;

export const AgentRuntimeToolRequest = Schema.Struct({
  effect: Schema.Literals(["execute", "read", "write"]),
  idempotencyKey: TrimmedNonEmptyString.pipe(
    Schema.check(
      Schema.isMaxLength(MAX_AGENT_TOOL_IDEMPOTENCY_KEY_CHARACTERS, {
        message: `Tool idempotency keys must not exceed ${MAX_AGENT_TOOL_IDEMPOTENCY_KEY_CHARACTERS} characters.`,
      }),
      Schema.makeFilter<string>((input) =>
        hasControlCharacter(input)
          ? "Tool idempotency keys must not contain control characters."
          : undefined,
      ),
    ),
  ),
  input: Schema.optional(Schema.Record(Schema.String, JsonValue)),
  inputSummary: TrimmedNonEmptyString.pipe(
    Schema.check(
      Schema.isMaxLength(8_192, {
        message: "Tool input summaries must not exceed 8192 characters.",
      }),
    ),
  ),
  requiredScopes: Schema.Array(AgentScopeName).pipe(
    Schema.check(Schema.isUnique({ message: "Tool request scopes must not contain duplicates." })),
  ),
  toolName: AgentToolName,
});
export type AgentRuntimeToolRequest = typeof AgentRuntimeToolRequest.Type;

/** Skills bundled with the platform in packages/tools/skills; a manifest pins them by name. */
export const AgentPlatformSkillName = Schema.Literals([
  "app-builder",
  "app-publication",
  "computer-use",
]);
export type AgentPlatformSkillName = typeof AgentPlatformSkillName.Type;

const AgentSkill = TrimmedNonEmptyString.pipe(
  Schema.check(
    Schema.isMaxLength(MAX_AGENT_SKILL_CHARACTERS, {
      message: `Agent skills must not exceed ${MAX_AGENT_SKILL_CHARACTERS} characters.`,
    }),
  ),
);

const AgentInstructions = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((input) =>
      input.trim().length > 0 ? undefined : "Agent instructions must not be empty.",
    ),
    Schema.isMaxLength(MAX_AGENT_INSTRUCTIONS_CHARACTERS, {
      message: `Agent instructions must not exceed ${MAX_AGENT_INSTRUCTIONS_CHARACTERS} characters.`,
    }),
  ),
);

const AgentModelId = TrimmedNonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(256, { message: "Model IDs must not exceed 256 characters." })),
);

const RecentMessageCharacterBudget = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "Recent message character budgets must be integers." }),
    Schema.isGreaterThanOrEqualTo(1, {
      message: "Recent message character budgets must be at least 1.",
    }),
    Schema.isLessThanOrEqualTo(MAX_RECENT_MESSAGE_CHARACTER_BUDGET, {
      message: `Recent message character budgets must not exceed ${MAX_RECENT_MESSAGE_CHARACTER_BUDGET}.`,
    }),
  ),
);

const ModelInputTokenBudget = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "Model input token budgets must be integers." }),
    Schema.isGreaterThanOrEqualTo(1_024, {
      message: "Model input token budgets must be at least 1024.",
    }),
    Schema.isLessThanOrEqualTo(MAX_MODEL_INPUT_TOKEN_BUDGET, {
      message: `Model input token budgets must not exceed ${MAX_MODEL_INPUT_TOKEN_BUDGET}.`,
    }),
  ),
);

const MaxModelGenerations = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "Model generation limits must be integers." }),
    Schema.isGreaterThanOrEqualTo(1, { message: "Model generation limits must be at least 1." }),
    Schema.isLessThanOrEqualTo(MAX_AGENT_MODEL_GENERATIONS, {
      message: `Model generation limits must not exceed ${MAX_AGENT_MODEL_GENERATIONS}.`,
    }),
  ),
);

const MaxToolCalls = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "Tool call limits must be integers." }),
    Schema.isGreaterThanOrEqualTo(1, { message: "Tool call limits must be at least 1." }),
    Schema.isLessThanOrEqualTo(MAX_AGENT_TOOL_CALLS, {
      message: `Tool call limits must not exceed ${MAX_AGENT_TOOL_CALLS}.`,
    }),
  ),
);

const OpenRouterProviderSlug = TrimmedNonEmptyString.pipe(
  Schema.check(
    Schema.isPattern(/^[a-z0-9][a-z0-9._/-]{0,63}$/u, {
      message: "OpenRouter provider slugs must be lowercase provider identifiers.",
    }),
  ),
);

const OpenRouterProviderSlugs = Schema.Array(OpenRouterProviderSlug).pipe(
  Schema.check(
    Schema.isMinLength(1, { message: "OpenRouter provider lists must not be empty." }),
    Schema.isMaxLength(8, { message: "OpenRouter provider lists support at most 8 providers." }),
    Schema.isUnique({ message: "OpenRouter provider lists must not contain duplicates." }),
  ),
);

export const AgentModelOptions = Schema.Struct({
  /**
   * Anthropic-style prompt caching on OpenRouter routes: `system` marks the stable system prefix;
   * `conversation` also caches the append-only tool conversation.
   */
  promptCache: Schema.optional(Schema.Literals(["system", "conversation"])),
  /** OpenRouter provider routing preferences for every generation of the release. */
  provider: Schema.optional(
    Schema.Struct({
      allowFallbacks: Schema.optional(Schema.Boolean),
      only: Schema.optional(OpenRouterProviderSlugs),
      order: Schema.optional(OpenRouterProviderSlugs),
    }),
  ),
  reasoningEffort: Schema.optional(Schema.Literals(["low", "medium", "high"])),
});
export type AgentModelOptions = typeof AgentModelOptions.Type;

const ModelOutputTokenReserve = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "Model output token reserves must be integers." }),
    Schema.isGreaterThanOrEqualTo(1, {
      message: "Model output token reserves must be at least 1.",
    }),
    Schema.isLessThanOrEqualTo(MAX_MODEL_OUTPUT_TOKEN_RESERVE, {
      message: `Model output token reserves must not exceed ${MAX_MODEL_OUTPUT_TOKEN_RESERVE}.`,
    }),
  ),
);

const ResponseDepthInstructions = TrimmedNonEmptyString.pipe(
  Schema.check(
    Schema.isMaxLength(4_096, {
      message: "Response depth instructions must not exceed 4096 characters.",
    }),
  ),
);

const ResponseDepthWordBound = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "Response depth word bounds must be integers." }),
    Schema.isGreaterThanOrEqualTo(1, {
      message: "Response depth word bounds must be at least 1.",
    }),
    Schema.isLessThanOrEqualTo(8_192, {
      message: "Response depth word bounds must not exceed 8192.",
    }),
  ),
);

export const AgentResponseDepthPolicy = Schema.Struct({
  classifierInstructions: ResponseDepthInstructions,
  defaultInstructions: Schema.optional(ResponseDepthInstructions),
  defaultMaximumWords: Schema.optional(ResponseDepthWordBound),
  detailedInstructions: ResponseDepthInstructions,
  minimumWords: ResponseDepthWordBound,
  maximumWords: ResponseDepthWordBound,
}).pipe(
  Schema.check(
    Schema.makeFilter<{ readonly minimumWords: number; readonly maximumWords: number }>((policy) =>
      policy.minimumWords <= policy.maximumWords
        ? undefined
        : "Response depth minimumWords must not exceed maximumWords.",
    ),
  ),
);
export type AgentResponseDepthPolicy = typeof AgentResponseDepthPolicy.Type;

const UlidString = TrimmedNonEmptyString.pipe(
  Schema.check(
    Schema.isPattern(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u, {
      message: "Identifiers must be canonical uppercase ULIDs.",
    }),
  ),
);

export const AgentSubAgentEdgeKind = Schema.Literals(["delegation", "handoff"]);
export type AgentSubAgentEdgeKind = typeof AgentSubAgentEdgeKind.Type;

export const AgentSubAgent = Schema.Struct({
  agentKey: AgentManifestKey,
  awaitResult: Schema.optional(Schema.Boolean),
  description: TrimmedNonEmptyString.pipe(
    Schema.check(
      Schema.isMaxLength(MAX_AGENT_SUB_AGENT_DESCRIPTION_CHARACTERS, {
        message: `Sub-agent descriptions must not exceed ${MAX_AGENT_SUB_AGENT_DESCRIPTION_CHARACTERS} characters.`,
      }),
    ),
  ),
  edgeKind: Schema.optional(AgentSubAgentEdgeKind),
  key: AgentManifestKey,
  required: Schema.Boolean,
});
export type AgentSubAgent = typeof AgentSubAgent.Type;

export const AgentManifestV1 = Schema.Struct({
  apiVersion: Schema.Literal(AGENT_MANIFEST_API_VERSION),
  kind: Schema.Literal("Agent"),
  metadata: Schema.Struct({
    key: AgentManifestKey,
    name: TrimmedNonEmptyString.pipe(
      Schema.check(
        Schema.isMaxLength(120, { message: "Agent names must not exceed 120 characters." }),
      ),
    ),
    version: AgentManifestVersion,
  }),
  spec: Schema.Struct({
    agents: Schema.optional(
      Schema.Array(AgentSubAgent).pipe(
        Schema.check(
          Schema.isMaxLength(MAX_AGENT_SUB_AGENTS, {
            message: `Agents support at most ${MAX_AGENT_SUB_AGENTS} declared sub-agents.`,
          }),
        ),
      ),
    ),
    capabilities: Schema.optional(
      Schema.Struct({
        tools: Schema.Array(AgentToolCapability).pipe(
          Schema.check(Schema.isMaxLength(256, { message: "Agents support at most 256 tools." })),
        ),
      }),
    ),
    instructions: AgentInstructions,
    memory: Schema.optional(
      Schema.Struct({
        mode: AgentMemoryMode,
        reviewMode: Schema.optional(AgentMemoryReviewMode),
        transcriptPrivacy: Schema.optional(AgentMemoryTranscriptPrivacy),
      }),
    ),
    model: Schema.Struct({
      fallbackIds: Schema.optional(
        Schema.Array(AgentModelId).pipe(
          Schema.check(
            Schema.isMaxLength(MAX_AGENT_MODEL_FALLBACKS, {
              message: `Agents support at most ${MAX_AGENT_MODEL_FALLBACKS} model fallbacks.`,
            }),
            Schema.isUnique({ message: "Model fallback IDs must not contain duplicates." }),
          ),
        ),
      ),
      id: AgentModelId,
      options: Schema.optional(AgentModelOptions),
    }),
    runtime: Schema.optional(
      Schema.Struct({
        modelTools: Schema.optional(
          Schema.Array(AgentToolName).pipe(
            Schema.check(
              Schema.isMaxLength(MAX_AGENT_MODEL_TOOLS, {
                message: `Agents support at most ${MAX_AGENT_MODEL_TOOLS} model-native tools.`,
              }),
              Schema.isUnique({
                message: "Model-native tool names must not contain duplicates.",
              }),
            ),
          ),
        ),
        contextCheckpointMode: Schema.optional(Schema.Literals(["auto", "off"])),
        ingressAttachments: Schema.optional(Schema.Literal("attach")),
        maxModelGenerations: Schema.optional(MaxModelGenerations),
        maxToolCalls: Schema.optional(MaxToolCalls),
        modelInputTokenBudget: Schema.optional(ModelInputTokenBudget),
        modelOutputTokenReserve: Schema.optional(ModelOutputTokenReserve),
        modelToolProtocol: Schema.optional(Schema.Literal("gemma4")),
        recentMessageCharacterBudget: Schema.optional(RecentMessageCharacterBudget),
        responseDepthPolicy: Schema.optional(AgentResponseDepthPolicy),
        responseFormat: Schema.optional(AgentResponseFormat),
        toolRequests: Schema.optional(
          Schema.Array(AgentRuntimeToolRequest).pipe(
            Schema.check(
              Schema.isMaxLength(MAX_AGENT_TOOL_REQUESTS, {
                message: `Agents support at most ${MAX_AGENT_TOOL_REQUESTS} preconfigured tool requests.`,
              }),
            ),
          ),
        ),
        toolResultImages: Schema.optional(Schema.Literal("screenshots")),
      }),
    ),
    platformSkills: Schema.optional(
      Schema.Array(AgentPlatformSkillName).pipe(
        Schema.check(
          Schema.isUnique({ message: "Platform skill names must not contain duplicates." }),
        ),
      ),
    ),
    sandbox: AgentSandboxPolicy,
    skills: Schema.optional(
      Schema.Array(AgentSkill).pipe(
        Schema.check(
          Schema.isMaxLength(MAX_AGENT_SKILL_COUNT, {
            message: `Agents support at most ${MAX_AGENT_SKILL_COUNT} pinned skills.`,
          }),
        ),
      ),
    ),
    triggers: Schema.optional(
      Schema.Array(AgentTrigger).pipe(
        Schema.check(Schema.isUnique({ message: "Agent triggers must not contain duplicates." })),
      ),
    ),
  }),
});
export type AgentManifestV1 = typeof AgentManifestV1.Type;

export const AgentToolAuthorizationBinding = Schema.Struct({
  authorizationId: TrimmedNonEmptyString.pipe(
    Schema.check(
      Schema.isPattern(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u, {
        message: "Authorization IDs must be canonical uppercase ULIDs.",
      }),
    ),
  ),
  toolPolicyId: Schema.optional(
    TrimmedNonEmptyString.pipe(
      Schema.check(
        Schema.isPattern(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u, {
          message: "Tool policy IDs must be canonical uppercase ULIDs.",
        }),
      ),
    ),
  ),
});
export type AgentToolAuthorizationBinding = typeof AgentToolAuthorizationBinding.Type;

export const AgentSubAgentBinding = Schema.Struct({
  agentDeploymentId: UlidString,
});
export type AgentSubAgentBinding = typeof AgentSubAgentBinding.Type;

export const AgentDeploymentConfigV1 = Schema.Struct({
  agentBindings: Schema.optional(Schema.Record(AgentManifestKey, AgentSubAgentBinding)),
  apiVersion: Schema.Literal(AGENT_DEPLOYMENT_CONFIG_API_VERSION),
  brainRetrievalMode: Schema.optional(
    Schema.Literals(["brain-first", "explicit", "hybrid", "memory-first", "off"]),
  ),
  kind: Schema.Literal("AgentDeploymentConfig"),
  toolAuthorizations: Schema.optional(Schema.Record(AgentToolName, AgentToolAuthorizationBinding)),
});
export type AgentDeploymentConfigV1 = typeof AgentDeploymentConfigV1.Type;
