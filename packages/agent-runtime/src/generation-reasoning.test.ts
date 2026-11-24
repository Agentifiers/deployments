import { describe, expect, test } from "bun:test";
import type { ReasoningDetail } from "@deployments-ai/model-gateway";
import {
  captureGenerationReasoning,
  replayReasoningForAttempt,
  validateGenerationReasoning,
} from "./generation-reasoning.ts";
import {
  validateRuntimeModelContinuation,
  validateRuntimeModelContinuationRecord,
} from "./sandbox-continuation.ts";

const OPUS = "openrouter/anthropic/claude-opus-5.5";
const GEMINI = "openrouter/google/gemini-3.6-flash";
const ATTEMPT = "run:execution:1:assistant:0:run-attempt:0:fallback:0";
const signedText = {
  format: "anthropic-claude-v1",
  index: 0,
  signature: "c2ln",
  text: "Check stock.",
  type: "reasoning.text",
} satisfies ReasoningDetail;

function capture(overrides: Partial<Parameters<typeof captureGenerationReasoning>[0]> = {}) {
  return captureGenerationReasoning({
    details: [signedText],
    modelCallIndex: 0,
    modelToolProtocol: undefined,
    producerAttemptId: ATTEMPT,
    producerModelId: OPUS,
    toolCalls: [{ modelToolCallId: "toolu_1", toolName: "provider.read" }],
    ...overrides,
  });
}

describe("generation reasoning capture", () => {
  test("rewrites a Gemini block id that names a provider tool call to its platform wire id", () => {
    expect<unknown>(
      capture({
        details: [
          {
            format: "google-gemini-v1",
            index: 0,
            text: "Plan the lookups.",
            type: "reasoning.text",
          },
          {
            data: "ZW5jcnlwdGVk",
            format: "google-gemini-v1",
            id: "call_92698",
            index: 0,
            type: "reasoning.encrypted",
          },
        ],
        modelCallIndex: 2,
        producerModelId: GEMINI,
        toolCalls: [
          { modelToolCallId: "call_92698", toolName: "provider.read" },
          { modelToolCallId: "call_92701", toolName: "provider.read" },
        ],
      }),
    ).toEqual({
      bytes: 200,
      kind: "captured",
      reasoning: {
        details: [
          {
            format: "google-gemini-v1",
            index: 0,
            text: "Plan the lookups.",
            type: "reasoning.text",
          },
          {
            data: "ZW5jcnlwdGVk",
            format: "google-gemini-v1",
            id: "mt0002000",
            index: 0,
            type: "reasoning.encrypted",
          },
        ],
        modelCallIndex: 2,
        producerAttemptId: ATTEMPT,
        producerModelId: GEMINI,
      },
    });
  });

  test("keeps an OpenAI encrypted id that names no tool call", () => {
    const captured = capture({
      details: [
        {
          data: "gAAAA",
          format: "openai-responses-v1",
          id: "rs_abc",
          index: 1,
          type: "reasoning.encrypted",
        },
      ],
      producerModelId: "openrouter/openai/gpt-5-nano",
      toolCalls: [{ modelToolCallId: "call_1", toolName: "provider.read" }],
    });
    expect<unknown>(captured.kind === "captured" ? captured.reasoning.details : captured).toEqual([
      {
        data: "gAAAA",
        format: "openai-responses-v1",
        id: "rs_abc",
        index: 1,
        type: "reasoning.encrypted",
      },
    ]);
  });

  test("names why a generation's reasoning cannot replay", () => {
    const { signature: _signature, ...withoutSignature } = signedText;
    const { format: _format, ...unformatted } = signedText;
    const outcome = (overrides: Parameters<typeof capture>[0]) => {
      const result = capture(overrides);
      return result.kind === "captured" ? `captured ${result.bytes}` : result.reason;
    };
    expect({
      absent: outcome({ details: undefined }),
      anthropic: outcome({}),
      atLimit: outcome({ details: [{ ...withoutSignature, text: "x".repeat(65_458) }] }),
      directOpenAi: outcome({ producerModelId: "openai/gpt-5-nano" }),
      gemma4: outcome({ modelToolProtocol: "gemma4" }),
      invalid: outcome({ details: [{ ...signedText, index: 2 ** 60 }] }),
      noToolCalls: outcome({ toolCalls: [] }),
      overLimit: outcome({ details: [{ ...withoutSignature, text: "x".repeat(65_459) }] }),
      unformatted: outcome({ details: [unformatted] }),
      unverifiedRoute: outcome({ producerModelId: "openrouter/qwen/qwen3.7-plus" }),
    }).toEqual({
      absent: "absent",
      anthropic: "captured 109",
      atLimit: "captured 65536",
      directOpenAi: "unsupported-route",
      gemma4: "gemma4",
      invalid: "invalid",
      noToolCalls: "no-tool-calls",
      overLimit: "oversize",
      unformatted: "unformatted",
      unverifiedRoute: "unsupported-route",
    });
  });
});

describe("reasoning replay selection", () => {
  const QWEN = "openrouter/qwen/qwen3.7-plus";
  const history = validateGenerationReasoning(
    [OPUS, GEMINI, OPUS, QWEN].map((producerModelId, modelCallIndex) => ({
      details: [signedText],
      modelCallIndex,
      producerAttemptId: ATTEMPT,
      producerModelId,
    })),
    4,
  );
  const replayed = (overrides: Partial<Parameters<typeof replayReasoningForAttempt>[0]>) => [
    ...replayReasoningForAttempt({
      attempt: 0,
      history,
      modelId: OPUS,
      modelToolProtocol: undefined,
      ...overrides,
    }).keys(),
  ];

  test("replays a model's own reasoning only on the first attempt of a verified route", () => {
    expect({
      gemini: replayed({ modelId: GEMINI }),
      gemma4: replayed({ modelToolProtocol: "gemma4" }),
      opus: replayed({}),
      retry: replayed({ attempt: 1 }),
      unverifiedRoute: replayed({ modelId: QWEN }),
    }).toEqual({ gemini: [1], gemma4: [], opus: [0, 2], retry: [], unverifiedRoute: [] });
  });
});

describe("model continuation reasoning", () => {
  const requests = [0, 1].map((modelCallIndex) => ({
    effect: "read" as const,
    idempotencyKey: `run:model-tool:${modelCallIndex}:0`,
    inputSummary: "Model requested provider.read.",
    requiredScopes: [],
    toolName: "provider.read",
  }));
  const entry = (modelCallIndex: number) => ({
    details: [signedText],
    modelCallIndex,
    producerAttemptId: ATTEMPT,
    producerModelId: OPUS,
  });
  const continuation = (generationReasoning: unknown) => ({
    generationReasoning,
    modelCallCount: 2,
    toolRequests: requests,
  });

  test("rebuilds reasoning entries field by field", () => {
    expect<unknown>(
      validateRuntimeModelContinuation(
        continuation([{ ...entry(0), unexpected: "dropped" }, entry(1)]),
      ),
    ).toEqual({
      generationReasoning: [
        {
          details: [signedText],
          modelCallIndex: 0,
          producerAttemptId: ATTEMPT,
          producerModelId: OPUS,
        },
        {
          details: [signedText],
          modelCallIndex: 1,
          producerAttemptId: ATTEMPT,
          producerModelId: OPUS,
        },
      ],
      modelCallCount: 2,
      toolRequests: requests,
    });
  });

  test("rejects reasoning for a generation the continuation has not completed or names twice", () => {
    const ordering =
      "Runtime model continuation reasoning must name distinct completed generations in ascending order.";
    expect(() => validateRuntimeModelContinuation(continuation([entry(2)]))).toThrow(ordering);
    expect(() => validateRuntimeModelContinuation(continuation([entry(0), entry(0)]))).toThrow(
      ordering,
    );
    expect(() => validateRuntimeModelContinuation(continuation([entry(1), entry(0)]))).toThrow(
      ordering,
    );
    expect(() =>
      validateRuntimeModelContinuation(continuation([{ ...entry(0), details: [] }])),
    ).toThrow('Missing key\n  at [0]["details"][0]');
    expect(() => validateRuntimeModelContinuation(continuation(undefined))).toThrow(
      "Expected array, got undefined",
    );
  });

  test("keeps reasoning out of the half the run record stores", () => {
    expect(validateRuntimeModelContinuationRecord(continuation([entry(0)]))).toEqual({
      modelCallCount: 2,
      toolRequests: requests,
    });
  });
});
