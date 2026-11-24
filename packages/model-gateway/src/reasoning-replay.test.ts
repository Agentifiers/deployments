import { expect, test as it } from "bun:test";
import { reasoningReplaySupported } from "./index.ts";

it("allows reasoning replay only on the verified OpenRouter model families", () => {
  const expected = {
    "openrouter/anthropic/claude-opus-5.5": true,
    "openrouter/anthropic/claude-haiku-5.5": true,
    "openrouter/google/gemini-3.6-flash": true,
    "openrouter/openai/gpt-5-nano": true,
    "openrouter/openai/gpt-5.2": true,
    "openrouter/google/gemini-2.5-pro": false,
    "openrouter/google/gemma-4-31b-it": false,
    "openrouter/openai/gpt-4o": false,
    "openrouter/qwen/qwen3.7-plus": false,
    "openai/gpt-5-nano": false,
    "bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0": false,
  };

  expect(
    Object.fromEntries(Object.keys(expected).map((id) => [id, reasoningReplaySupported(id)])),
  ).toEqual(expected);
});
