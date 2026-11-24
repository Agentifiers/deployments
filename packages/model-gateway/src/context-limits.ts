import type { ModelCatalogRuntimeEntries } from "./model-catalog.ts";

export interface ModelContextLimits {
  readonly contextWindowTokens: number;
  /** Provider output ceiling, when known; a chat reserve is not a model capability. */
  readonly maximumOutputTokens?: number;
  readonly outputTokenReserve: number;
}

export interface ModelContextBudget {
  /** Admitted catalog metadata keyed by canonical platform model id. */
  readonly modelCatalog?: ModelCatalogRuntimeEntries | undefined;
  readonly modelInputTokenBudget?: number | undefined;
  readonly modelOutputTokenReserve?: number | undefined;
}

const CATALOG_OUTPUT_TOKEN_RESERVE = 4_096;

const HOSTED_CONTEXT_LIMITS: ModelContextLimits = {
  contextWindowTokens: 128_000,
  maximumOutputTokens: 4_096,
  outputTokenReserve: 4_096,
};

const MODEL_CONTEXT_LIMITS = new Map<string, ModelContextLimits>([
  ["openai/gpt-5.2", HOSTED_CONTEXT_LIMITS],
  [
    "openai/gpt-4.1",
    { contextWindowTokens: 1_000_000, maximumOutputTokens: 32_768, outputTokenReserve: 4_096 },
  ],
  [
    "openai/gpt-4o",
    { contextWindowTokens: 128_000, maximumOutputTokens: 16_384, outputTokenReserve: 4_096 },
  ],
  [
    "openai/gpt-4o-mini",
    { contextWindowTokens: 128_000, maximumOutputTokens: 16_384, outputTokenReserve: 4_096 },
  ],
  ["openrouter/qwen/qwen3.7-plus", HOSTED_CONTEXT_LIMITS],
  ["openrouter/z-ai/glm-5.2", HOSTED_CONTEXT_LIMITS],
  ["openrouter/xiaomi/mimo-v2.5", HOSTED_CONTEXT_LIMITS],
  [
    "openrouter/z-ai/glm-5.3-flash",
    { contextWindowTokens: 1_048_576, maximumOutputTokens: 131_072, outputTokenReserve: 4_096 },
  ],
  [
    "openrouter/anthropic/claude-opus-5.5",
    { contextWindowTokens: 1_000_000, maximumOutputTokens: 128_000, outputTokenReserve: 4_096 },
  ],
  [
    "openrouter/openai/gpt-4o",
    { contextWindowTokens: 128_000, maximumOutputTokens: 16_384, outputTokenReserve: 4_096 },
  ],
  [
    "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
    { contextWindowTokens: 200_000, maximumOutputTokens: 64_000, outputTokenReserve: 4_096 },
  ],
]);

/**
 * Resolves a model's context limits. Curated limits override catalog metadata; catalog metadata
 * covers every other admitted model; explicit manifest budgets remain the last resort.
 */
export function modelContextLimits(
  modelId: string,
  budget?: ModelContextBudget,
): ModelContextLimits {
  const normalized = modelId.trim();
  const limits = knownModelContextLimits(normalized);
  if (limits) return limits;
  const catalogEntry = budget?.modelCatalog?.[normalized];
  if (catalogEntry) {
    return {
      contextWindowTokens: catalogEntry.contextWindowTokens,
      ...(catalogEntry.maximumOutputTokens !== undefined
        ? { maximumOutputTokens: catalogEntry.maximumOutputTokens }
        : {}),
      outputTokenReserve: Math.min(
        CATALOG_OUTPUT_TOKEN_RESERVE,
        catalogEntry.maximumOutputTokens ?? CATALOG_OUTPUT_TOKEN_RESERVE,
        Math.floor(catalogEntry.contextWindowTokens / 2),
      ),
    };
  }
  if (budget?.modelInputTokenBudget !== undefined && budget.modelOutputTokenReserve !== undefined) {
    return {
      contextWindowTokens: budget.modelInputTokenBudget + budget.modelOutputTokenReserve,
      outputTokenReserve: budget.modelOutputTokenReserve,
    };
  }
  throw new TypeError(
    `Model ${normalized || "(empty)"} has no authoritative context limits; admit it through the model catalog or declare explicit modelInputTokenBudget and modelOutputTokenReserve.`,
  );
}

export function knownModelContextLimits(modelId: string): ModelContextLimits | undefined {
  return MODEL_CONTEXT_LIMITS.get(modelId.trim());
}
