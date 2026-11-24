import { describe, expect, it } from "bun:test";
import type {
  ModelGatewayChatCompletionRequest,
  ModelGatewayService,
} from "@deployments-ai/model-gateway";
import { Effect } from "effect";
import { modelGatewayGenerationPort } from "./model-gateway.ts";
import { createTestAgentRuntime, input } from "./runtime.fixture.ts";
import type { RuntimeModelInvocationAttempt } from "./model-generation-types.ts";

const conversation = input({
  modelFallbackIds: [],
  modelId: "openrouter/example/custom-gemma4",
  modelInputTokenBudget: 8_192,
  modelOutputTokenReserve: 512,
  modelToolProtocol: "gemma4",
  prompt: "How was your afternoon?",
  recentMessages: [
    { role: "assistant", content: "The coffee is ready lol" },
    { role: "user", content: "Thanks." },
    { role: "assistant", content: "The rain is easing haha" },
    { role: "user", content: "Anything else?" },
    { role: "assistant", content: "I can stay a little longer lmao" },
  ],
});

function recordedRuntime(replies: readonly string[]) {
  const invocations: RuntimeModelInvocationAttempt[] = [];
  let calls = 0;
  const gateway = {
    chatCompletion: (request: ModelGatewayChatCompletionRequest) => {
      const assistantMessage = replies[calls++];
      if (assistantMessage === undefined) throw new Error("Unexpected extra generation attempt");
      return Effect.succeed({
        assistantMessage,
        body: {},
        finishReason: "stop",
        inputTokens: 40,
        modelCallId: request.modelCallId,
        modelId: request.modelId,
        outputTokens: 10,
        route: {},
        totalTokens: 50,
        usage: {
          idempotencyKey: `${request.modelCallId}:usage`,
          inputTokens: 40,
          occurredAt: calls,
          outputTokens: 10,
          quantity: 50,
          source: "model-gateway",
          type: "model_tokens",
          unit: "tokens",
        },
      } as never);
    },
  } as unknown as ModelGatewayService;
  return {
    invocations,
    runtime: createTestAgentRuntime({
      generateAssistantMessage: modelGatewayGenerationPort(gateway),
      recordModelInvocation: async (attempt) => void invocations.push(attempt),
    }),
  };
}

describe("habitual response-ending recovery", () => {
  it("delivers a complete regeneration rather than trimming the rejected reply, metering both attempts", async () => {
    const replacement = "I took a walk before the rain started.";
    const { runtime, invocations } = recordedRuntime([
      "I stayed inside all afternoon lol",
      replacement,
    ]);

    const result = await runtime.execute(conversation);

    expect(result.assistantMessage).toBe(replacement);
    expect(invocations.map((attempt) => attempt.status)).toEqual(["failed", "succeeded"]);
    const modelUsage = result.usage.filter((entry) => entry.type === "model_tokens");
    expect(modelUsage.map((entry) => entry.quantity)).toEqual([50, 50]);
    expect(new Set(modelUsage.map((entry) => entry.idempotencyKey)).size).toBe(2);
    expect(invocations.map((attempt) => attempt.usageIdempotencyKey)).toEqual(
      modelUsage.map((entry) => entry.idempotencyKey),
    );
  });

  it("fails after the bounded correction also repeats the habit and retains both charged attempts", async () => {
    const { runtime, invocations } = recordedRuntime([
      "I stayed inside all afternoon lol",
      "The house was quiet lmao",
    ]);
    const delivered: string[] = [];

    expect(
      runtime.execute(conversation).then((result) => delivered.push(result.assistantMessage)),
    ).rejects.toBeInstanceOf(Error);

    expect(delivered).toEqual([]);
    expect(invocations.map((attempt) => attempt.status)).toEqual(["failed", "failed"]);
    expect(invocations.map((attempt) => attempt.usageEntry?.quantity)).toEqual([50, 50]);
    expect(new Set(invocations.map((attempt) => attempt.usageIdempotencyKey)).size).toBe(2);
  });
});
