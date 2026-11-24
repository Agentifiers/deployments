type MockModelProvider = "bedrock" | "openai" | "openrouter";

export interface MockModelCapabilities {
  readonly imageInput: boolean;
  readonly reasoning: boolean;
  readonly structuredOutputs: boolean;
  readonly toolCalling: boolean;
}

interface MockModelTokenPrices {
  readonly cacheReadUsdPerMillionTokens?: number;
  readonly cacheWriteUsdPerMillionTokens?: number;
  readonly inputUsdPerMillionTokens: number;
  readonly outputUsdPerMillionTokens: number;
}

export interface MockModelCatalogEntry {
  readonly capabilities?: MockModelCapabilities;
  readonly contextWindowTokens: number;
  readonly curated: boolean;
  readonly displayName: string;
  readonly maximumOutputTokens?: number;
  readonly modelId: string;
  readonly pricing?: MockModelTokenPrices & {
    readonly tiers?: readonly (MockModelTokenPrices & { readonly minPromptTokens: number })[];
  };
  readonly provider: MockModelProvider;
  readonly providerModelId: string;
}

function capabilities(
  toolCalling: boolean,
  structuredOutputs: boolean,
  imageInput: boolean,
  reasoning: boolean,
): MockModelCapabilities {
  return { imageInput, reasoning, structuredOutputs, toolCalling };
}

/**
 * Deterministic mock catalog: curated synchronized entries, one curated model that is absent from
 * the synchronized catalog (no pricing or capabilities), and non-curated hosted gateway entries.
 * Sorted by `modelId`, matching the public list order.
 */
export const MOCK_MODEL_CATALOG: readonly MockModelCatalogEntry[] = Object.freeze(
  [
    {
      capabilities: capabilities(true, true, true, false),
      contextWindowTokens: 1_047_576,
      curated: true,
      displayName: "OpenAI: GPT-4.1",
      maximumOutputTokens: 32_768,
      modelId: "openai/gpt-4.1",
      pricing: {
        cacheReadUsdPerMillionTokens: 0.5,
        inputUsdPerMillionTokens: 2,
        outputUsdPerMillionTokens: 8,
      },
      provider: "openai",
      providerModelId: "gpt-4.1",
    },
    {
      capabilities: capabilities(true, true, true, false),
      contextWindowTokens: 128_000,
      curated: true,
      displayName: "OpenAI: GPT-4o-mini",
      maximumOutputTokens: 16_384,
      modelId: "openai/gpt-4o-mini",
      pricing: { inputUsdPerMillionTokens: 0.15, outputUsdPerMillionTokens: 0.6 },
      provider: "openai",
      providerModelId: "gpt-4o-mini",
    },
    {
      capabilities: capabilities(true, true, true, true),
      contextWindowTokens: 200_000,
      curated: false,
      displayName: "OpenAI: o4-mini",
      maximumOutputTokens: 100_000,
      modelId: "openai/o4-mini",
      pricing: { inputUsdPerMillionTokens: 1.1, outputUsdPerMillionTokens: 4.4 },
      provider: "openai",
      providerModelId: "o4-mini",
    },
    {
      capabilities: capabilities(true, true, true, true),
      contextWindowTokens: 200_000,
      curated: true,
      displayName: "Anthropic: Claude Opus 5.5",
      maximumOutputTokens: 64_000,
      modelId: "openrouter/anthropic/claude-opus-5.5",
      pricing: {
        cacheReadUsdPerMillionTokens: 0.5,
        cacheWriteUsdPerMillionTokens: 6.25,
        inputUsdPerMillionTokens: 5,
        outputUsdPerMillionTokens: 25,
      },
      provider: "openrouter",
      providerModelId: "anthropic/claude-opus-5.5",
    },
    {
      capabilities: capabilities(true, false, false, true),
      contextWindowTokens: 163_840,
      curated: false,
      displayName: "DeepSeek: DeepSeek V3.2",
      modelId: "openrouter/deepseek/deepseek-v3.2",
      pricing: { inputUsdPerMillionTokens: 0.25, outputUsdPerMillionTokens: 0.38 },
      provider: "openrouter",
      providerModelId: "deepseek/deepseek-v3.2",
    },
    {
      capabilities: capabilities(true, true, true, true),
      contextWindowTokens: 1_048_576,
      curated: false,
      displayName: "Google: Gemini 2.5 Pro",
      maximumOutputTokens: 65_536,
      modelId: "openrouter/google/gemini-2.5-pro",
      pricing: {
        inputUsdPerMillionTokens: 1.25,
        outputUsdPerMillionTokens: 10,
        tiers: [
          {
            inputUsdPerMillionTokens: 2.5,
            minPromptTokens: 200_000,
            outputUsdPerMillionTokens: 15,
          },
        ],
      },
      provider: "openrouter",
      providerModelId: "google/gemini-2.5-pro",
    },
    {
      capabilities: capabilities(false, false, false, false),
      contextWindowTokens: 8_192,
      curated: false,
      displayName: "Gryphe: MythoMax 13B",
      maximumOutputTokens: 4_096,
      modelId: "openrouter/gryphe/mythomax-l2-13b",
      pricing: { inputUsdPerMillionTokens: 0.06, outputUsdPerMillionTokens: 0.06 },
      provider: "openrouter",
      providerModelId: "gryphe/mythomax-l2-13b",
    },
    {
      capabilities: capabilities(true, true, false, false),
      contextWindowTokens: 131_072,
      curated: false,
      displayName: "Mistral: Mistral Small 3.2 24B",
      maximumOutputTokens: 131_072,
      modelId: "openrouter/mistralai/mistral-small-3.2-24b-instruct",
      pricing: { inputUsdPerMillionTokens: 0.05, outputUsdPerMillionTokens: 0.1 },
      provider: "openrouter",
      providerModelId: "mistralai/mistral-small-3.2-24b-instruct",
    },
    {
      capabilities: capabilities(true, true, false, true),
      contextWindowTokens: 1_000_000,
      curated: true,
      displayName: "Qwen: Qwen3.7 Plus",
      maximumOutputTokens: 32_768,
      modelId: "openrouter/qwen/qwen3.7-plus",
      pricing: { inputUsdPerMillionTokens: 0.4, outputUsdPerMillionTokens: 1.2 },
      provider: "openrouter",
      providerModelId: "qwen/qwen3.7-plus",
    },
    {
      contextWindowTokens: 200_000,
      curated: true,
      displayName: "openrouter/z-ai/glm-5.2",
      modelId: "openrouter/z-ai/glm-5.2",
      provider: "openrouter",
      providerModelId: "z-ai/glm-5.2",
    },
  ].map((entry) => Object.freeze(entry as MockModelCatalogEntry)),
);

const MOCK_MODEL_IDS = new Set(MOCK_MODEL_CATALOG.map((entry) => entry.modelId));

/** Provider-wide policy entries accepted for synchronized hosted gateway catalogs. */
export const MOCK_MODEL_PROVIDER_WILDCARDS = ["openai/*", "openrouter/*"] as const;

export function mockModelCatalogHas(modelId: string): boolean {
  return MOCK_MODEL_IDS.has(modelId);
}
