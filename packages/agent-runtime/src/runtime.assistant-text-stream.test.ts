import { describe, expect, it } from "bun:test";
import type { AgentResponseFormat } from "@deployments-ai/agent-manifest";
import type { RuntimeModelInvocationAttempt } from "./model-generation-types.ts";
import { createTestAgentRuntime, input } from "./runtime.fixture.ts";
import type { RuntimeModelGenerationRequest } from "./types.ts";

const answer = "The mechanism transfers stored energy through a sequence of controlled movements.";

function streamingRuntime(options: { readonly failingStream?: boolean } = {}) {
  const timeline: string[] = [];
  const requests: RuntimeModelGenerationRequest[] = [];
  const invocations: RuntimeModelInvocationAttempt[] = [];
  const runtime = createTestAgentRuntime({
    appendProgress: async (event) => void timeline.push(`progress:${event.eventType}`),
    assistantTextStream: {
      append: ({ modelCallId, text }) => {
        if (options.failingStream) throw new Error("stream unavailable");
        timeline.push(`append:${modelCallId}:${text}`);
      },
      flush: async (modelCallId) => {
        if (options.failingStream) throw new Error("stream unavailable");
        timeline.push(`flush:${modelCallId}`);
      },
    },
    generateAssistantMessage: async (request) => {
      requests.push(request);
      const reply = request.modelCallId.includes(":response-depth:")
        ? "detailed"
        : request.responseFormat
          ? '{"answer":"ok"}'
          : answer;
      request.onTextDelta?.({ modelCallId: request.modelCallId, text: reply.slice(0, 14) });
      request.onTextDelta?.({ modelCallId: request.modelCallId, text: reply.slice(14) });
      return { assistantMessage: reply };
    },
    recordModelInvocation: async (attempt) => void invocations.push(attempt),
  });
  return { invocations, requests, runtime, timeline };
}

const depthPolicy = {
  classifierInstructions: "Select a response depth.",
  detailedInstructions: "Explain in detail.",
  maximumWords: 16,
  minimumWords: 8,
};

describe("live assistant text streaming", () => {
  it("streams only the answer generation and flushes it before its completed progress", async () => {
    const { invocations, requests, runtime, timeline } = streamingRuntime();

    const result = await runtime.execute(
      input({
        modelFallbackIds: [],
        modelInputTokenBudget: 31_744,
        modelOutputTokenReserve: 1_024,
        responseDepthPolicy: depthPolicy,
      }),
    );

    expect(result.assistantMessage).toBe(answer);
    const [classifier, generation] = requests.map((request) => request.modelCallId);
    expect(classifier).toContain(":response-depth:");
    expect(requests.map((request) => request.onTextDelta !== undefined)).toEqual([false, true]);
    expect(timeline.filter((entry) => !entry.startsWith("progress:"))).toEqual([
      `append:${generation}:${answer.slice(0, 14)}`,
      `append:${generation}:${answer.slice(14)}`,
      `flush:${generation}`,
    ]);
    expect(timeline.indexOf(`flush:${generation}`)).toBeLessThan(
      timeline.lastIndexOf("progress:model.generation.completed"),
    );
    expect(invocations.map((attempt) => attempt.streaming)).toEqual([false, true]);
  });

  it("never streams structured-output generations", async () => {
    const responseFormat: AgentResponseFormat = {
      name: "summary",
      schema: {
        additionalProperties: false,
        properties: { answer: { type: "string" } },
        required: ["answer"],
        type: "object",
      },
      type: "json_schema",
    };
    const { invocations, requests, runtime, timeline } = streamingRuntime();

    await runtime.execute(input({ modelFallbackIds: [], responseFormat }));

    expect(requests.every((request) => request.onTextDelta === undefined)).toBe(true);
    expect(timeline.filter((entry) => !entry.startsWith("progress:"))).toEqual([]);
    expect(invocations.map((attempt) => attempt.streaming)).toEqual([false]);
  });

  it("completes the run when live delivery fails", async () => {
    const { invocations, runtime } = streamingRuntime({ failingStream: true });

    const result = await runtime.execute(input({ modelFallbackIds: [] }));

    expect(result.assistantMessage).toBe(answer);
    expect(invocations.map((attempt) => attempt.status)).toEqual(["succeeded"]);
  });
});
