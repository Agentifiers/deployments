import { describe, expect, test } from "bun:test";
import {
  DEFAULT_JUDGE_MAX_OUTPUT_TOKENS,
  DEFAULT_JUDGE_TIMEOUT_MS,
  JUDGE_RESPONSE_SCHEMA,
  JUDGE_SYSTEM_PROMPT,
} from "./model-judge.ts";
import { runEvaluator, validateEvaluatorConfig } from "./run-evaluator.ts";
import {
  JudgeModelTimeoutError,
  type EvaluationEvidence,
  type JudgeModelPort,
  type JudgeModelRequest,
  type JudgeModelResponse,
} from "./types.ts";

const config = {
  kind: "model_judge",
  modelId: "provider/judge-model",
  prompt: "Input: {{input}}\nResponse: {{output}}\nExpected: {{expectations}}",
} as const;

const evidence: EvaluationEvidence = {
  input: "What is 2+2?",
  output: "4 {{input}}",
  toolCalls: [],
  expectations: { mustInclude: ["4"], constraints: { b: 1, a: 2 } },
};

function judge(respond: (request: JudgeModelRequest) => Promise<JudgeModelResponse>) {
  const requests: JudgeModelRequest[] = [];
  const port: JudgeModelPort = {
    complete: (request) => {
      requests.push(request);
      return respond(request);
    },
  };
  return { port, requests };
}

let clock = 0;
const now = () => (clock += 25);

describe("model_judge", () => {
  test("sends an internal request with the substituted prompt and reports usage", async () => {
    const { port, requests } = judge(async () => ({
      text: '{"value": 0.8, "rationale": "Correct but terse.", "label": "good"}',
      modelId: "provider/judge-model-2026",
      inputTokens: 120,
      outputTokens: 30,
      costUsdMicros: 42,
    }));
    const outcome = await runEvaluator(config, evidence, { judge: port, now });
    expect(outcome).toEqual({
      status: "succeeded",
      value: 0.8,
      rationale: "Correct but terse.",
      label: "good",
      durationMs: 25,
      usage: {
        modelId: "provider/judge-model-2026",
        inputTokens: 120,
        outputTokens: 30,
        costUsdMicros: 42,
        internalEvaluator: true,
      },
    });
    expect(requests).toEqual([
      {
        modelId: "provider/judge-model",
        system: JUDGE_SYSTEM_PROMPT,
        user: 'Input: What is 2+2?\nResponse: 4 {{input}}\nExpected: {"constraints":{"a":2,"b":1},"mustInclude":["4"]}',
        maxOutputTokens: DEFAULT_JUDGE_MAX_OUTPUT_TOKENS,
        timeoutMs: DEFAULT_JUDGE_TIMEOUT_MS,
        internalEvaluator: true,
        responseSchema: JUDGE_RESPONSE_SCHEMA,
      },
    ]);
  });

  test("uses configured limits, substitutes missing input as empty, and accepts fenced JSON", async () => {
    const { port, requests } = judge(async () => ({
      text: '```json\n{"value": 1, "rationale": "ok"}\n```',
    }));
    const outcome = await runEvaluator(
      { ...config, maxOutputTokens: 64, timeoutMs: 5_000 },
      { output: "4", toolCalls: [], expectations: {} },
      { judge: port, now },
    );
    expect(outcome).toMatchObject({
      status: "succeeded",
      value: 1,
      usage: { modelId: "provider/judge-model", internalEvaluator: true },
    });
    expect(requests[0]).toMatchObject({
      user: "Input: \nResponse: 4\nExpected: {}",
      maxOutputTokens: 64,
      timeoutMs: 5_000,
    });
  });

  test.each([
    ['{"value": 1.5, "rationale": "too high"}'],
    ['{"value": -0.1, "rationale": "too low"}'],
    ['{"value": "0.5", "rationale": "string value"}'],
    ['{"value": 0.5}'],
    ['{"value": 0.5, "rationale": 7}'],
    ["[0.5]"],
    ["The response looks great, 9/10."],
  ])("invalid judge output %p is judge_invalid_output, never a value", async (text) => {
    const { port } = judge(async () => ({ text, inputTokens: 10, outputTokens: 5 }));
    const outcome = await runEvaluator(config, evidence, { judge: port, now });
    expect(outcome).toMatchObject({
      status: "error",
      errorClass: "judge_invalid_output",
      usage: {
        modelId: "provider/judge-model",
        inputTokens: 10,
        outputTokens: 5,
        internalEvaluator: true,
      },
    });
    expect(outcome).not.toHaveProperty("value");
    expect(JSON.stringify(outcome)).not.toContain(text);
  });

  test("a port failure is judge_unavailable", async () => {
    const { port } = judge(async () => {
      throw new Error("upstream 503 with private details");
    });
    const outcome = await runEvaluator(config, evidence, { judge: port, now });
    expect(outcome).toMatchObject({ status: "error", errorClass: "judge_unavailable" });
    expect(JSON.stringify(outcome)).not.toContain("private details");
  });

  test("a port timeout is judge_timeout", async () => {
    const { port } = judge(async () => {
      throw new JudgeModelTimeoutError("timed out");
    });
    expect(await runEvaluator(config, evidence, { judge: port, now })).toMatchObject({
      status: "error",
      errorClass: "judge_timeout",
    });
  });

  test("no configured judge is judge_unavailable", async () => {
    expect(await runEvaluator(config, evidence, { now })).toMatchObject({
      status: "error",
      errorClass: "judge_unavailable",
    });
  });

  test("a missing response is missing_evidence and the judge is never called", async () => {
    const { port, requests } = judge(async () => ({ text: "{}" }));
    expect(
      await runEvaluator(config, { toolCalls: [], expectations: {} }, { judge: port, now }),
    ).toMatchObject({ status: "error", errorClass: "missing_evidence" });
    expect(requests).toHaveLength(0);
  });

  test("validateEvaluatorConfig rejects blank judge settings", () => {
    expect(validateEvaluatorConfig(config)).toBeUndefined();
    expect(validateEvaluatorConfig({ ...config, modelId: "  " })).toBe(
      "Judge model IDs must not be empty.",
    );
    expect(validateEvaluatorConfig({ ...config, prompt: " " })).toBe(
      "Judge prompts must not be empty.",
    );
    expect(validateEvaluatorConfig({ ...config, prompt: "x".repeat(8_193) })).toContain(
      "must not exceed 8192",
    );
  });
});
