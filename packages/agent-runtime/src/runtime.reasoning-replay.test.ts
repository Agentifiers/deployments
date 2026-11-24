import { describe, expect, test } from "bun:test";
import {
  makeModelGateway,
  type ModelGatewayService,
  type OpenAiCompatibleChatCompletionMessage,
  type ReasoningDetail,
} from "@deployments-ai/model-gateway";
import type { RuntimeModelInvocationAttempt } from "./model-generation-types.ts";
import { modelGatewayGenerationPort } from "./model-gateway.ts";
import { createTestAgentRuntime, id, input } from "./runtime.fixture.ts";
import type {
  AgentRuntimeDependencies,
  RuntimeApprovedToolCall,
  RuntimeModelGenerationRequest,
  RuntimeModelGenerationResult,
  RuntimeProgressEvent,
} from "./types.ts";

const OPUS = "openrouter/anthropic/claude-opus-5.5";
const GEMINI = "openrouter/google/gemini-3.6-flash";
const opusThinking = {
  format: "anthropic-claude-v1",
  index: 0,
  signature: "c2ln",
  text: "Read the account first.",
  type: "reasoning.text",
} satisfies ReasoningDetail;

interface ChatBody {
  readonly messages: readonly OpenAiCompatibleChatCompletionMessage[];
}

function recordingGateway(respond: (body: ChatBody) => Response) {
  const bodies: ChatBody[] = [];
  const gateway = makeModelGateway({
    baseUrl: "https://gateway.invalid",
    credentials: async () => "test-token",
  });
  const service: ModelGatewayService = {
    ...gateway,
    chatCompletion: (request) =>
      gateway.chatCompletion({
        ...request,
        fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
          if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
          const body = JSON.parse(init.body) as ChatBody;
          bodies.push(body);
          return respond(body);
        }) as typeof fetch,
      }),
  };
  return { bodies, service };
}

const usage = { completion_tokens: 10, prompt_tokens: 100, total_tokens: 110 };

function toolCallResponse(
  model: string,
  toolCallId: string,
  reasoning: readonly ReasoningDetail[],
) {
  return Response.json({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: "",
          reasoning_details: reasoning,
          role: "assistant",
          tool_calls: [
            {
              function: { arguments: '{"resource":"account"}', name: "runtime_tool_0" },
              id: toolCallId,
              type: "function",
            },
          ],
        },
      },
    ],
    id: "response-tool",
    model,
    usage,
  });
}

function answerResponse(model: string, content: string) {
  return Response.json({
    choices: [{ finish_reason: "stop", message: { content, role: "assistant" } }],
    id: "response-answer",
    model,
    usage,
  });
}

const hasReasoning = (body: ChatBody) =>
  body.messages.some((message) => message.reasoning_details !== undefined);

function readingRuntime(dependencies: Partial<AgentRuntimeDependencies>) {
  let authorizations = 0;
  return createTestAgentRuntime({
    authorizeToolCall: async () => ({
      action: "allow",
      reason: "Read is allowed.",
      toolCallId: id(String(20 + authorizations++)),
    }),
    executeToolCall: async () => ({ outputSummary: "account is active", status: "completed" }),
    generateAssistantMessage: async () => ({ assistantMessage: "unused" }),
    ...dependencies,
  });
}

const routeInput = (modelId: string) =>
  input({
    modelFallbackIds: [],
    modelId,
    modelInputTokenBudget: 100_000,
    modelOutputTokenReserve: 1_024,
    modelToolNames: ["provider.read"],
  });

describe("reasoning replay within one execution", () => {
  test("sends generation 0's Gemini reasoning back on its assistant turn with the wire id", async () => {
    const { bodies, service } = recordingGateway((body) =>
      body.messages.some((message) => message.role === "tool")
        ? answerResponse("google/gemini-3.6-flash", "The account is active.")
        : toolCallResponse("google/gemini-3.6-flash", "call_92698", [
            {
              format: "google-gemini-v1",
              index: 0,
              text: "Plan the lookup.",
              type: "reasoning.text",
            },
            {
              data: "ZW5jcnlwdGVk",
              format: "google-gemini-v1",
              id: "call_92698",
              index: 0,
              type: "reasoning.encrypted",
            },
          ]),
    );
    const result = await readingRuntime({
      generateAssistantMessage: modelGatewayGenerationPort(service),
    }).execute(routeInput(GEMINI));

    expect(result.assistantMessage).toBe("The account is active.");
    expect(bodies.map(hasReasoning)).toEqual([false, true]);
    expect(bodies[1]?.messages.find((message) => message.role === "assistant")).toEqual({
      content: "",
      reasoning_details: [
        { format: "google-gemini-v1", index: 0, text: "Plan the lookup.", type: "reasoning.text" },
        {
          data: "ZW5jcnlwdGVk",
          format: "google-gemini-v1",
          id: "mt0000000",
          index: 0,
          type: "reasoning.encrypted",
        },
      ],
      role: "assistant",
      tool_calls: [
        {
          function: { arguments: '{"resource":"account"}', name: "runtime_tool_0" },
          id: "mt0000000",
          type: "function",
        },
      ],
    });
  });

  test("retries a generation whose replayed reasoning the provider rejects without that reasoning", async () => {
    const attempts: RuntimeModelInvocationAttempt[] = [];
    const failures: RuntimeProgressEvent[] = [];
    const { bodies, service } = recordingGateway((body) =>
      hasReasoning(body)
        ? Response.json(
            { error: { code: 400, message: "Invalid signature in thinking block" } },
            { status: 400 },
          )
        : body.messages.some((message) => message.role === "tool")
          ? answerResponse("anthropic/claude-opus-5.5", "The account is active.")
          : toolCallResponse("anthropic/claude-opus-5.5", "toolu_01", [opusThinking]),
    );
    const result = await readingRuntime({
      appendProgress: async (event) => {
        if (event.eventType === "model.generation.failed") failures.push(event);
      },
      generateAssistantMessage: modelGatewayGenerationPort(service),
      recordModelInvocation: async (attempt) => {
        attempts.push(attempt);
      },
    }).execute(routeInput(OPUS));

    expect(result.completionStatus).toBe("completed");
    expect(result.assistantMessage).toBe("The account is active.");
    expect(bodies.map(hasReasoning)).toEqual([false, true, false]);
    expect(
      attempts.map((attempt) => [attempt.attemptId.split(":assistant:")[1], attempt.status]),
    ).toEqual([
      ["0:run-attempt:0:fallback:0", "succeeded"],
      ["1:run-attempt:0:fallback:0", "failed"],
      ["1:run-attempt:0:fallback:1", "succeeded"],
    ]);
    expect(failures.map((event) => event.metadata?.error)).toEqual([
      "Model gateway chat completion failed with status 400 Provider message: Invalid signature in thinking block.",
    ]);
  });
});

describe("reasoning replay gating in a run", () => {
  const readAccount = (modelToolCallId: string, details: readonly ReasoningDetail[]) =>
    ({
      assistantMessage: "",
      reasoningDetails: details,
      toolCalls: [{ input: { resource: "account" }, modelToolCallId, toolName: "provider.read" }],
    }) satisfies RuntimeModelGenerationResult;
  const replayedIndexes = (requests: readonly RuntimeModelGenerationRequest[]) =>
    requests.map((request) => [request.modelId, [...(request.replayReasoning?.keys() ?? [])]]);

  test("replays reasoning only into the model that produced it after a fallback", async () => {
    const geminiThinking = { ...opusThinking, format: "google-gemini-v1" };
    const requests: RuntimeModelGenerationRequest[] = [];
    const result = await readingRuntime({
      generateAssistantMessage: async (request) => {
        requests.push(request);
        if (requests.length === 1) throw new Error("Opus is unavailable.");
        if (requests.length === 2) return readAccount("gemini-call", [geminiThinking]);
        if (requests.length === 3) return readAccount("toolu_02", [opusThinking]);
        return { assistantMessage: "The account is active." };
      },
    }).execute(
      input({ modelFallbackIds: [GEMINI], modelId: OPUS, modelToolNames: ["provider.read"] }),
    );

    expect(result.assistantMessage).toBe("The account is active.");
    expect(replayedIndexes(requests)).toEqual([
      [OPUS, []],
      [GEMINI, []],
      [OPUS, []],
      [OPUS, [1]],
    ]);
  });

  test("never captures or replays reasoning on the Gemma 4 protocol", async () => {
    const progress: RuntimeProgressEvent[] = [];
    const requests: RuntimeModelGenerationRequest[] = [];
    await readingRuntime({
      appendProgress: async (event) => {
        progress.push(event);
      },
      generateAssistantMessage: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? readAccount("gemma-call", [{ ...opusThinking, format: "google-gemini-v1" }])
          : { assistantMessage: "The account is active." };
      },
    }).execute(
      input({
        modelFallbackIds: [],
        modelId: GEMINI,
        modelToolNames: ["provider.read"],
        modelToolProtocol: "gemma4",
      }),
    );

    expect(replayedIndexes(requests)).toEqual([
      [GEMINI, []],
      [GEMINI, []],
    ]);
    expect(
      progress
        .filter((event) => event.eventType === "model.generation.completed")
        .map((event) => event.metadata?.reasoningCapture),
    ).toEqual([
      { kind: "skipped", reason: "gemma4" },
      { kind: "skipped", reason: "gemma4" },
    ]);
  });

  test("replays reasoning kept across an approval pause in the resumed generation", async () => {
    const paused = await readingRuntime({
      authorizeToolCall: async () => ({
        action: "require-approval",
        approvalId: id("21"),
        reason: "Approval is required.",
        toolCallId: id("20"),
      }),
      generateAssistantMessage: async () => readAccount("toolu_01", [opusThinking]),
    }).execute(input({ modelFallbackIds: [], modelId: OPUS, modelToolNames: ["provider.read"] }));
    const pending = paused.pendingAction;
    if (pending?.kind !== "approval" || !paused.modelContinuation) {
      throw new Error("Expected an approval pause with a model continuation.");
    }
    const approved: RuntimeApprovedToolCall = {
      approvalId: pending.approvalId,
      effect: pending.effect,
      idempotencyKey: pending.idempotencyKey,
      ...(pending.input ? { input: pending.input } : {}),
      inputSummary: pending.inputSummary,
      policyReason: pending.policyReason,
      requiredScopes: pending.requiredScopes,
      toolCallId: pending.toolCallId,
      toolName: pending.toolName,
    };
    const requests: RuntimeModelGenerationRequest[] = [];

    await readingRuntime({
      generateAssistantMessage: async (request) => {
        requests.push(request);
        return { assistantMessage: "The account is active." };
      },
    }).execute(
      input({
        approvedToolCalls: [approved],
        artifactContinuation: paused.artifactContinuation,
        completedToolCalls: paused.completedToolCalls,
        modelContinuation: paused.modelContinuation,
        modelFallbackIds: [],
        modelId: OPUS,
        modelToolNames: ["provider.read"],
      }),
    );

    expect<unknown>(requests.map((request) => [...(request.replayReasoning ?? [])])).toEqual([
      [[0, [opusThinking]]],
    ]);
  });
});
