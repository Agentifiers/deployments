import { expect, test } from "bun:test";
import { runEvaluator } from "./run-evaluator.ts";
import type { EvaluationEvidence, JudgeModelResponse } from "./types.ts";

const evidence: EvaluationEvidence = { output: "done", toolCalls: [], expectations: {} };

test.each([
  [{ kind: "human" } as const],
  [{ kind: "imported", source: "external-grader" } as const],
])("%p evaluators never run automatically", async (config) => {
  expect(await runEvaluator(config, evidence, { now: () => 0 })).toMatchObject({
    status: "error",
    errorClass: "invalid_configuration",
    durationMs: 0,
  });
});

test("an unexpected evaluator exception is evaluator_failed with a measured duration", async () => {
  const times = [100, 140];
  const outcome = await runEvaluator(
    { kind: "model_judge", modelId: "provider/judge", prompt: "{{output}}" },
    evidence,
    {
      judge: { complete: async () => ({ text: null }) as unknown as JudgeModelResponse },
      now: () => times.shift()!,
    },
  );
  expect(outcome).toEqual({
    status: "error",
    errorClass: "evaluator_failed",
    message: "The evaluator failed unexpectedly.",
    durationMs: 40,
  });
});
