import { describe, expect, it } from "bun:test";
import {
  modelCatalogCostUsdNanoDollars,
  openAiModelCatalogEntries,
  parseOpenAiModelIds,
  parseOpenRouterModelCatalog,
  usdPerTokenToUsdPerMillionTokens,
} from "./model-catalog.ts";
import { modelContextLimits } from "./context-limits.ts";
import { modelUsageLedgerEntry } from "./usage.ts";

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";

const openRouterBody = {
  data: [
    {
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      context_length: 400_000,
      id: "openai/gpt-5.4",
      name: "OpenAI: GPT-5.4",
      pricing: {
        completion: "0.00001",
        input_cache_read: "0.0000001",
        overrides: [{ completion: "0.000015", min_prompt_tokens: 272_000, prompt: "0.000004" }],
        prompt: "0.0000025",
      },
      supported_parameters: ["max_tokens", "reasoning", "structured_outputs", "tools"],
      top_provider: { context_length: 400_000, max_completion_tokens: 128_000 },
    },
    {
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      context_length: 200_000,
      id: "anthropic/claude-sonnet-4.6",
      name: "Anthropic: Claude Sonnet 4.6",
      pricing: { completion: "0.000015", prompt: "0.000003" },
      supported_parameters: ["tools"],
      top_provider: {},
    },
    {
      architecture: { output_modalities: ["text"] },
      context_length: 2_000_000,
      id: "openrouter/auto",
      pricing: { completion: "-1", prompt: "-1" },
    },
    {
      architecture: { output_modalities: ["text"] },
      context_length: 400_000,
      id: "openai/gpt-5.4:batch",
      pricing: { completion: "0.000005", prompt: "0.00000125" },
    },
    {
      architecture: { output_modalities: ["image"] },
      context_length: 32_000,
      id: "vendor/image-only",
      pricing: { completion: "0", prompt: "0" },
    },
    { id: "../escape", pricing: { completion: "0", prompt: "0" } },
  ],
};

describe("model catalog parsing", () => {
  it("admits priced text models with capabilities and skips unusable entries", () => {
    const parsed = parseOpenRouterModelCatalog(openRouterBody);
    expect(parsed.entries.map((entry) => entry.modelId)).toEqual([
      "openrouter/anthropic/claude-sonnet-4.6",
      "openrouter/openai/gpt-5.4",
    ]);
    expect(parsed.skippedModelIds).toEqual([
      "openrouter/auto",
      "openai/gpt-5.4:batch",
      "vendor/image-only",
    ]);
    expect(parsed.entries[1]).toEqual({
      capabilities: {
        imageInput: true,
        reasoning: true,
        structuredOutputs: true,
        toolCalling: true,
      },
      contextWindowTokens: 400_000,
      displayName: "OpenAI: GPT-5.4",
      maximumOutputTokens: 128_000,
      modelId: "openrouter/openai/gpt-5.4",
      pricing: {
        cacheReadUsdPerMillionTokens: 0.1,
        inputUsdPerMillionTokens: 2.5,
        outputUsdPerMillionTokens: 10,
        tiers: [
          {
            cacheReadUsdPerMillionTokens: 0.1,
            inputUsdPerMillionTokens: 4,
            minPromptTokens: 272_000,
            outputUsdPerMillionTokens: 15,
          },
        ],
      },
      provider: "openrouter",
      providerModelId: "openai/gpt-5.4",
    });
    expect(parsed.entries[0]).not.toHaveProperty("maximumOutputTokens");
    expect(() => parseOpenRouterModelCatalog({ models: [] })).toThrow("data array");
  });

  it("converts per-token decimal prices without binary floating-point drift", () => {
    expect(usdPerTokenToUsdPerMillionTokens("0.0000001")).toBe(0.1);
    expect(usdPerTokenToUsdPerMillionTokens("0.000000075")).toBe(0.075);
    expect(usdPerTokenToUsdPerMillionTokens("1e-7")).toBe(0.1);
    expect(usdPerTokenToUsdPerMillionTokens("-1")).toBeUndefined();
    expect(usdPerTokenToUsdPerMillionTokens("free")).toBeUndefined();
  });

  it("admits OpenAI models only when the key lists them and first-party metadata exists", () => {
    const openRouter = parseOpenRouterModelCatalog(openRouterBody).entries;
    const ids = parseOpenAiModelIds({
      data: [{ id: "gpt-5.4" }, { id: "whisper-1" }, { id: "gpt-5.4" }, { id: "org/nested" }],
      object: "list",
    });
    expect(ids).toEqual(["gpt-5.4", "whisper-1"]);
    const parsed = openAiModelCatalogEntries(ids, openRouter);
    expect(parsed.skippedModelIds).toEqual(["whisper-1"]);
    expect(parsed.entries).toEqual([
      expect.objectContaining({
        contextWindowTokens: 400_000,
        modelId: "openai/gpt-5.4",
        provider: "openai",
        providerModelId: "gpt-5.4",
      }),
    ]);
  });
});

describe("catalog-backed runtime metadata", () => {
  const catalog = parseOpenRouterModelCatalog(openRouterBody).entries;
  const runtimeEntries = Object.fromEntries(
    catalog.map((entry) => [
      entry.modelId,
      {
        contextWindowTokens: entry.contextWindowTokens,
        ...(entry.maximumOutputTokens ? { maximumOutputTokens: entry.maximumOutputTokens } : {}),
        pricing: entry.pricing,
      },
    ]),
  );

  it("uses catalog windows for non-curated models and keeps curated overrides", () => {
    expect(
      modelContextLimits("openrouter/openai/gpt-5.4", { modelCatalog: runtimeEntries }),
    ).toEqual({
      contextWindowTokens: 400_000,
      maximumOutputTokens: 128_000,
      outputTokenReserve: 4_096,
    });
    expect(
      modelContextLimits("openrouter/anthropic/claude-opus-5.5", {
        modelCatalog: {
          "openrouter/anthropic/claude-opus-5.5": {
            contextWindowTokens: 1,
            pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
          },
        },
      }).contextWindowTokens,
    ).toBe(1_000_000);
    expect(() => modelContextLimits("openrouter/anthropic/claude-sonnet-4.6")).toThrow(
      "model catalog",
    );
  });

  it("prices tiers, cached reads, and output tokens in nano-dollars", () => {
    const pricing = runtimeEntries["openrouter/openai/gpt-5.4"]!.pricing;
    expect(
      modelCatalogCostUsdNanoDollars(pricing, {
        cachedInputTokens: 400,
        inputTokens: 1_000,
        outputTokens: 100,
      }),
    ).toBe(600 * 2_500 + 400 * 100 + 100 * 10_000);
    expect(
      modelCatalogCostUsdNanoDollars(pricing, { inputTokens: 300_000, outputTokens: 10 }),
    ).toBe(300_000 * 4_000 + 10 * 15_000);
  });

  it("meters catalog prices only when the gateway reports no cost", () => {
    const pricing = runtimeEntries["openrouter/anthropic/claude-sonnet-4.6"]!.pricing;
    const base = {
      payer: { kind: "operator" as const },
      catalogPricing: pricing,
      modelCallId: "call-1",
      modelId: "openrouter/anthropic/claude-sonnet-4.6",
      provider: "openrouter" as const,
      runId: RUN_ID,
    };
    expect(
      modelUsageLedgerEntry({
        ...base,
        response: {
          usage: { completion_tokens: 1_000, prompt_tokens: 2_000, total_tokens: 3_000 },
        },
      }),
    ).toMatchObject({ costUsdMicros: 21_000, costUsdNanoDollars: 21_000_000 });
    const reported = modelUsageLedgerEntry({
      ...base,
      response: {
        usage: { completion_tokens: 1_000, cost: 0.5, prompt_tokens: 2_000, total_tokens: 3_000 },
      },
    });
    expect(reported).toMatchObject({ costUsdMicros: 500_000 });
    expect(reported).not.toHaveProperty("costUsdNanoDollars");
  });
});
