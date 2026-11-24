import { describe, expect, test } from "bun:test";
import type { ModelCatalogItem } from "@deployments-ai/api-contract/models";
import { formatModelPrice, modelCapabilities, parseModelSearch } from "./model-catalog-state.ts";

describe("parseModelSearch", () => {
  test("keeps known filters and drops the rest", () => {
    expect(
      parseModelSearch({
        allowed: "false",
        capability: "reasoning",
        curated: true,
        provider: "anthropic",
        search: "  gpt ",
      }),
    ).toEqual({ allowed: false, capability: "reasoning", curated: true, search: "gpt" });
  });

  test("an empty search is no filter", () => {
    expect(parseModelSearch({ allowed: "maybe", search: "   " })).toEqual({});
  });
});

describe("catalog item display", () => {
  const unpriced: ModelCatalogItem = {
    allowed: true,
    capabilities: {
      imageInput: true,
      reasoning: false,
      structuredOutputs: true,
      toolCalling: true,
    },
    contextWindowTokens: 400_000,
    curated: false,
    displayName: "GPT-5.4 mini",
    modelId: "openai/gpt-5.4-mini",
    provider: "openai",
    providerModelId: "gpt-5.4-mini",
  };

  test("lists advertised capabilities in label order", () => {
    expect(modelCapabilities(unpriced)).toEqual([
      "tool_calling",
      "structured_outputs",
      "image_input",
    ]);
  });

  test("formats input and output prices per million tokens", () => {
    expect(
      formatModelPrice({
        ...unpriced,
        pricing: { inputUsdPerMillionTokens: 0.25, outputUsdPerMillionTokens: 2 },
      }),
    ).toBe("$0.25 / $2.00");
    expect(formatModelPrice(unpriced)).toBeUndefined();
  });
});
