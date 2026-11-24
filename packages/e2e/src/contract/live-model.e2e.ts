import { expect, it } from "@effect/vitest";
import { parseLiveAgentModel } from "../harness/live-model.ts";

const INPUT = "DEPLOYMENTS_E2E_AGENT_MODEL_INPUT_TOKEN_BUDGET";
const OUTPUT = "DEPLOYMENTS_E2E_AGENT_MODEL_OUTPUT_TOKEN_RESERVE";

it("defaults to the curated model without runtime budgets", () => {
  expect(parseLiveAgentModel({ DEPLOYMENTS_E2E_AGENT_MODEL: " " })).toEqual({
    model: { id: "openrouter/qwen/qwen3.7-plus" },
    runtime: {},
  });
});

it("pairs a configured model with both runtime budgets", () => {
  expect(
    parseLiveAgentModel({
      DEPLOYMENTS_E2E_AGENT_MODEL: "openai/gpt-6-luna",
      [INPUT]: "120000",
      [OUTPUT]: " 8192 ",
    }),
  ).toEqual({
    model: { id: "openai/gpt-6-luna" },
    runtime: { modelInputTokenBudget: 120_000, modelOutputTokenReserve: 8_192 },
  });
});

it("rejects one budget without the other", () => {
  const message = `Set both ${INPUT} and ${OUTPUT}, or neither.`;
  expect(() => parseLiveAgentModel({ [INPUT]: "120000" })).toThrow(message);
  expect(() => parseLiveAgentModel({ [OUTPUT]: "8192" })).toThrow(message);
});

it.each(["0", "-1", "1.5", "1e5", "lots"])("rejects the budget value %j", (budget) => {
  expect(() => parseLiveAgentModel({ [INPUT]: budget, [OUTPUT]: "8192" })).toThrow(
    `${INPUT} must be a positive integer.`,
  );
});
