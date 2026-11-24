import { describe, expect, it } from "bun:test";
import { DEFAULT_AGENT_MODEL_ID } from "./types.ts";
import { modelContextLimits } from "./context-limits.ts";

describe("model context limits", () => {
  it("uses known hosted model windows without widening unknown routes", () => {
    expect(modelContextLimits(DEFAULT_AGENT_MODEL_ID)).toMatchObject({
      contextWindowTokens: 128_000,
      maximumOutputTokens: 4_096,
      outputTokenReserve: 4_096,
    });
    expect(modelContextLimits("openai/gpt-4.1")).toMatchObject({
      contextWindowTokens: 1_000_000,
      maximumOutputTokens: 32_768,
    });
    expect(modelContextLimits("openai/gpt-4o").maximumOutputTokens).toBe(16_384);
    expect(modelContextLimits("openrouter/anthropic/claude-opus-5.5")).toMatchObject({
      contextWindowTokens: 1_000_000,
      maximumOutputTokens: 128_000,
    });
    expect(modelContextLimits("openrouter/z-ai/glm-5.3-flash")).toMatchObject({
      contextWindowTokens: 1_048_576,
      maximumOutputTokens: 131_072,
    });
    expect(() => modelContextLimits("openrouter/custom-unknown")).toThrow(
      "explicit modelInputTokenBudget and modelOutputTokenReserve",
    );
  });
});
