import { isRecord, OPENAI_MODEL_PREFIX, OPENROUTER_MODEL_PREFIX } from "./types.ts";

/** Hosted providers whose model catalogs are synchronized into the platform catalog. */
export const MODEL_CATALOG_PROVIDERS = ["bedrock", "openai", "openrouter"] as const;

export type ModelCatalogProvider = (typeof MODEL_CATALOG_PROVIDERS)[number];

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

/** Token prices in USD per one million tokens. One USD per million tokens is one micro-USD per token. */
export interface ModelTokenPrices {
  readonly cacheReadUsdPerMillionTokens?: number;
  readonly cacheWriteUsdPerMillionTokens?: number;
  readonly inputUsdPerMillionTokens: number;
  readonly outputUsdPerMillionTokens: number;
}

/** Prices that replace the base prices once a request's prompt reaches `minPromptTokens`. */
export interface ModelPricingTier extends ModelTokenPrices {
  readonly minPromptTokens: number;
}

export interface ModelTokenPricing extends ModelTokenPrices {
  readonly tiers?: readonly ModelPricingTier[];
}

export interface ModelCatalogCapabilities {
  readonly imageInput: boolean;
  readonly reasoning: boolean;
  readonly structuredOutputs: boolean;
  readonly toolCalling: boolean;
}

export interface ModelCatalogEntry {
  readonly capabilities: ModelCatalogCapabilities;
  readonly contextWindowTokens: number;
  readonly displayName: string;
  readonly maximumOutputTokens?: number;
  /** Canonical platform model id, for example `openrouter/anthropic/claude-sonnet-4.5`. */
  readonly modelId: string;
  readonly pricing: ModelTokenPricing;
  readonly provider: ModelCatalogProvider;
  readonly providerModelId: string;
}

/** The subset of a catalog entry the runtime needs to pack context and meter cost. */
export interface ModelCatalogRuntimeEntry {
  readonly contextWindowTokens: number;
  readonly maximumOutputTokens?: number;
  readonly pricing: ModelTokenPricing;
}

export type ModelCatalogRuntimeEntries = Readonly<Record<string, ModelCatalogRuntimeEntry>>;

export interface ParsedModelCatalog {
  readonly entries: readonly ModelCatalogEntry[];
  /** Provider model ids that were present but unusable (no text output, no price, batch-only). */
  readonly skippedModelIds: readonly string[];
}

const MAX_PROVIDER_MODEL_ID_LENGTH = 200;
const PROVIDER_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u;
const MAX_DISPLAY_NAME_LENGTH = 200;
const MAX_CONTEXT_WINDOW_TOKENS = 100_000_000;
const MAX_USD_PER_MILLION_TOKENS = 1_000_000;

function positiveTokenCount(value: unknown, maximum = MAX_CONTEXT_WINDOW_TOKENS) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum
    ? value
    : undefined;
}

/**
 * Converts a provider USD-per-token decimal string (for example "0.0000025") to USD per million
 * tokens without accumulating binary floating-point noise (0.0000001 * 1e6 !== 0.1).
 */
export function usdPerTokenToUsdPerMillionTokens(value: unknown): number | undefined {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  const trimmed = text.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e-?\d+)?$/iu.test(trimmed)) return undefined;
  const perToken = Number(trimmed);
  if (!Number.isFinite(perToken) || perToken < 0) return undefined;
  const perMillion = Number((perToken * 1_000_000).toPrecision(12));
  return perMillion <= MAX_USD_PER_MILLION_TOKENS ? perMillion : undefined;
}

function tokenPrices(source: Readonly<Record<string, unknown>>): ModelTokenPrices | undefined {
  const inputUsdPerMillionTokens = usdPerTokenToUsdPerMillionTokens(source.prompt);
  const outputUsdPerMillionTokens = usdPerTokenToUsdPerMillionTokens(source.completion);
  if (inputUsdPerMillionTokens === undefined || outputUsdPerMillionTokens === undefined) {
    return undefined;
  }
  const cacheReadUsdPerMillionTokens = usdPerTokenToUsdPerMillionTokens(source.input_cache_read);
  const cacheWriteUsdPerMillionTokens = usdPerTokenToUsdPerMillionTokens(source.input_cache_write);
  return {
    ...(cacheReadUsdPerMillionTokens !== undefined ? { cacheReadUsdPerMillionTokens } : {}),
    ...(cacheWriteUsdPerMillionTokens !== undefined ? { cacheWriteUsdPerMillionTokens } : {}),
    inputUsdPerMillionTokens,
    outputUsdPerMillionTokens,
  };
}

function openRouterPricing(value: unknown): ModelTokenPricing | undefined {
  if (!isRecord(value)) return undefined;
  const base = tokenPrices(value);
  if (!base) return undefined;
  const tiers = (Array.isArray(value.overrides) ? value.overrides : [])
    .flatMap((override): ModelPricingTier[] => {
      if (!isRecord(override)) return [];
      const minPromptTokens = positiveTokenCount(override.min_prompt_tokens);
      if (minPromptTokens === undefined) return [];
      const prices = tokenPrices({ ...value, ...override });
      return prices ? [{ ...prices, minPromptTokens }] : [];
    })
    .toSorted((left, right) => left.minPromptTokens - right.minPromptTokens);
  return { ...base, ...(tiers.length > 0 ? { tiers } : {}) };
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function providerModelId(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > MAX_PROVIDER_MODEL_ID_LENGTH ||
    !PROVIDER_MODEL_ID_PATTERN.test(trimmed) ||
    trimmed.split("/").some((segment) => !segment)
  ) {
    return undefined;
  }
  return trimmed;
}

/**
 * Parses OpenRouter's public `GET /api/v1/models` response. Only synchronous text-output models
 * with a non-negative published token price are admitted; router aliases with dynamic pricing and
 * batch-only variants are skipped because the platform could neither meter nor serve them.
 */
export function parseOpenRouterModelCatalog(body: unknown): ParsedModelCatalog {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new TypeError("OpenRouter model catalog response must contain a data array.");
  }
  const entries = new Map<string, ModelCatalogEntry>();
  const skippedModelIds: string[] = [];
  for (const model of body.data) {
    if (!isRecord(model)) continue;
    const id = providerModelId(model.id);
    if (!id) continue;
    const architecture = isRecord(model.architecture) ? model.architecture : {};
    const outputModalities = stringList(architecture.output_modalities);
    const inputModalities = stringList(architecture.input_modalities);
    const topProvider = isRecord(model.top_provider) ? model.top_provider : {};
    const contextWindowTokens =
      positiveTokenCount(model.context_length) ?? positiveTokenCount(topProvider.context_length);
    const pricing = openRouterPricing(model.pricing);
    if (
      id.endsWith(":batch") ||
      !outputModalities.includes("text") ||
      contextWindowTokens === undefined ||
      !pricing
    ) {
      skippedModelIds.push(id);
      continue;
    }
    const maximumOutputTokens = positiveTokenCount(topProvider.max_completion_tokens);
    const parameters = new Set(stringList(model.supported_parameters));
    const modelId = `${OPENROUTER_MODEL_PREFIX}${id}`;
    entries.set(modelId.toLowerCase(), {
      capabilities: {
        imageInput: inputModalities.includes("image"),
        reasoning: parameters.has("reasoning") || parameters.has("include_reasoning"),
        structuredOutputs: parameters.has("structured_outputs"),
        toolCalling: parameters.has("tools"),
      },
      contextWindowTokens,
      displayName: ((typeof model.name === "string" ? model.name.trim() : "") || id).slice(
        0,
        MAX_DISPLAY_NAME_LENGTH,
      ),
      ...(maximumOutputTokens !== undefined ? { maximumOutputTokens } : {}),
      modelId,
      pricing,
      provider: "openrouter",
      providerModelId: id,
    });
  }
  return {
    entries: [...entries.values()].toSorted((left, right) =>
      left.modelId.localeCompare(right.modelId),
    ),
    skippedModelIds,
  };
}

/** A trimmed OpenAI-native model id such as `gpt-4.1`, or undefined when the value is not one. */
export function bareOpenAiModelId(value: unknown) {
  const id = providerModelId(value);
  return id && !id.includes("/") ? id : undefined;
}

/** Parses OpenAI's authenticated `GET /v1/models` response into the model ids the key can use. */
export function parseOpenAiModelIds(body: unknown): readonly string[] {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new TypeError("OpenAI model list response must contain a data array.");
  }
  return [
    ...new Set(
      body.data.flatMap((model) => {
        const id = isRecord(model) ? bareOpenAiModelId(model.id) : undefined;
        return id ? [id] : [];
      }),
    ),
  ].toSorted();
}

/**
 * OpenAI's model list exposes availability but no context window, price, or capability metadata.
 * OpenRouter republishes OpenAI's first-party metadata under `openai/<id>`, so a directly
 * available OpenAI model enters the catalog only when that authoritative metadata exists.
 */
export function openAiModelCatalogEntries(
  availableOpenAiModelIds: readonly string[],
  openRouterEntries: readonly ModelCatalogEntry[],
): ParsedModelCatalog {
  const metadata = new Map(
    openRouterEntries.map((entry) => [entry.providerModelId.toLowerCase(), entry]),
  );
  const entries: ModelCatalogEntry[] = [];
  const skippedModelIds: string[] = [];
  for (const id of availableOpenAiModelIds) {
    const source = metadata.get(`openai/${id}`.toLowerCase());
    if (!source) {
      skippedModelIds.push(id);
      continue;
    }
    entries.push({
      capabilities: source.capabilities,
      contextWindowTokens: source.contextWindowTokens,
      displayName: source.displayName,
      ...(source.maximumOutputTokens !== undefined
        ? { maximumOutputTokens: source.maximumOutputTokens }
        : {}),
      modelId: `${OPENAI_MODEL_PREFIX}${id}`,
      pricing: source.pricing,
      provider: "openai",
      providerModelId: id,
    });
  }
  return {
    entries: entries.toSorted((left, right) => left.modelId.localeCompare(right.modelId)),
    skippedModelIds,
  };
}

/** Selects the price tier that applies to a request with `promptTokens` input tokens. */
export function modelTokenPricesForPrompt(
  pricing: ModelTokenPricing,
  promptTokens: number,
): ModelTokenPrices {
  let selected: ModelTokenPrices = pricing;
  for (const tier of pricing.tiers ?? []) {
    if (promptTokens >= tier.minPromptTokens) selected = tier;
  }
  return selected;
}

export interface ModelTokenUsage {
  readonly cacheWriteInputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Computes a request's cost from catalog prices. Cached reads and cache writes are billed at their
 * published rates when the catalog lists them and otherwise at the uncached input rate.
 */
export function modelCatalogCostUsdNanoDollars(
  pricing: ModelTokenPricing,
  usage: ModelTokenUsage,
): number | undefined {
  const prices = modelTokenPricesForPrompt(pricing, usage.inputTokens);
  const cachedInputTokens = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const cacheWriteInputTokens = Math.min(
    usage.cacheWriteInputTokens ?? 0,
    usage.inputTokens - cachedInputTokens,
  );
  const uncachedInputTokens = usage.inputTokens - cachedInputTokens - cacheWriteInputTokens;
  // USD per million tokens equals micro-USD per token, so *1000 yields nano-USD per token.
  const nanoDollars =
    uncachedInputTokens * prices.inputUsdPerMillionTokens * 1_000 +
    cachedInputTokens *
      (prices.cacheReadUsdPerMillionTokens ?? prices.inputUsdPerMillionTokens) *
      1_000 +
    cacheWriteInputTokens *
      (prices.cacheWriteUsdPerMillionTokens ?? prices.inputUsdPerMillionTokens) *
      1_000 +
    usage.outputTokens * prices.outputUsdPerMillionTokens * 1_000;
  const rounded = Math.round(nanoDollars);
  return Number.isSafeInteger(rounded) && rounded >= 0 ? rounded : undefined;
}
