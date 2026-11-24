import { describe, expect, it } from "bun:test";
import type {
  OpenAiCompatibleChatCompletionMessage,
  ReasoningDetail,
} from "@deployments-ai/model-gateway";
import { replayReasoningForAttempt, validateGenerationReasoning } from "./generation-reasoning.ts";
import { estimatedMessageTokens } from "./model-context-budget.ts";
import { packRuntimeModelContext } from "./model-gateway.ts";
import { completedModelToolContext } from "./model-tool-context.ts";
import { id, request } from "./model-tool-context.fixture.ts";
import type { RuntimeCompletedToolCall, RuntimeModelToolCallSlot } from "./types.ts";

const OPUS = "openrouter/anthropic/claude-opus-5.5";
const aliases = [{ name: "runtime_tool_0", toolName: "provider.read" }];
const thinkZero = {
  format: "anthropic-claude-v1",
  index: 0,
  signature: "c2lnMA==",
  text: "Read zero first.",
  type: "reasoning.text",
} satisfies ReasoningDetail;
const thinkOne = {
  format: "anthropic-claude-v1",
  index: 0,
  signature: "c2lnMQ==",
  text: "Then read one.",
  type: "reasoning.text",
} satisfies ReasoningDetail;

interface CompletedRead {
  readonly slot: RuntimeModelToolCallSlot;
  readonly tool: RuntimeCompletedToolCall;
}

function read(modelCallIndex: number, resource: string, toolName = "provider.read"): CompletedRead {
  const idempotencyKey = `${id("7")}:model-tool:${modelCallIndex}:0`;
  return {
    slot: { idempotencyKey, modelCallIndex, toolCallIndex: 0 },
    tool: {
      effect: "read" as const,
      idempotencyKey,
      input: { resource },
      inputSummary: `Read ${resource}.`,
      outputSummary: `${resource} is active.`,
      policyAction: "allow" as const,
      policyReason: "Read is allowed.",
      requiredScopes: [],
      toolCallId: id(String(20 + modelCallIndex)),
      toolName,
    },
  };
}

function replayed(byGeneration: readonly (readonly ReasoningDetail[])[]) {
  return replayReasoningForAttempt({
    attempt: 0,
    history: validateGenerationReasoning(
      byGeneration.map((details, modelCallIndex) => ({
        details,
        modelCallIndex,
        producerAttemptId: `attempt-${modelCallIndex}`,
        producerModelId: OPUS,
      })),
      byGeneration.length,
    ),
    modelId: OPUS,
    modelToolProtocol: undefined,
  });
}

function render(
  reads: readonly CompletedRead[],
  reasoning: readonly (readonly ReasoningDetail[])[],
  maximumTokens = 100_000,
) {
  return completedModelToolContext(
    request({
      completedToolCalls: reads.map(({ tool }) => tool),
      modelId: OPUS,
      modelToolCallSlots: reads.map(({ slot }) => slot),
      replayReasoning: replayed(reasoning),
    }),
    aliases,
    { allowNativeMessages: true, maximumTokens, messageTokens: estimatedMessageTokens },
  );
}

const tokens = (messages: readonly OpenAiCompatibleChatCompletionMessage[]) =>
  messages.reduce((total, message) => total + estimatedMessageTokens(message), 0);

describe("native tool history with replayed reasoning", () => {
  const reads = [read(0, "zero"), read(1, "one")];

  it("attaches each generation's reasoning to its own assistant turn and nothing else", () => {
    const withReasoning = render(reads, [[thinkZero], [thinkOne]]);
    const without = render(reads, []);

    expect(withReasoning.nativeHistory).toBe(true);
    expect<unknown>(
      withReasoning.postPromptMessages.map((message) => message.reasoning_details),
    ).toEqual([[thinkZero], undefined, [thinkOne], undefined]);
    expect(withReasoning.postPromptMessages.filter((message) => message.role === "tool")).toEqual(
      without.postPromptMessages.filter((message) => message.role === "tool"),
    );
  });

  it("renders reasoning with sorted keys, so a block rebuilt from DynamoDB keeps its bytes", () => {
    const reloaded = [
      {
        type: "reasoning.encrypted",
        metadata: { zone: "b", algorithm: "a" },
        id: "mt0000000",
        format: "google-gemini-v1",
        data: "ZW5j",
      },
    ] satisfies ReasoningDetail[];

    expect(JSON.stringify(render([read(0, "zero")], [reloaded]).postPromptMessages[0])).toBe(
      '{"content":"","reasoning_details":[{"data":"ZW5j","format":"google-gemini-v1","id":"mt0000000","metadata":{"algorithm":"a","zone":"b"},"type":"reasoning.encrypted"}],"role":"assistant","tool_calls":[{"function":{"arguments":"{\\"resource\\":\\"zero\\"}","name":"runtime_tool_0"},"id":"mt0000000","type":"function"}]}',
    );
  });

  it("drops reasoning from the whole history before leaving the native layout", () => {
    const without = render(reads, []);
    const withReasoning = render(reads, [[thinkZero], [thinkOne]]);
    const onlyWithout = render(
      reads,
      [[thinkZero], [thinkOne]],
      tokens(without.postPromptMessages),
    );
    const neither = render(
      reads,
      [[thinkZero], [thinkOne]],
      tokens(without.postPromptMessages) - 1,
    );

    expect(tokens(withReasoning.postPromptMessages)).toBeGreaterThan(
      tokens(without.postPromptMessages),
    );
    expect(onlyWithout.nativeHistory).toBe(true);
    expect(onlyWithout.postPromptMessages).toEqual(without.postPromptMessages);
    expect(neither.nativeHistory).toBe(false);
    expect(neither.postPromptMessages[0]?.tool_calls?.map((call) => call.id)).toEqual([
      "mt0001000",
    ]);
    expect(Object.keys(neither.postPromptMessages[0] ?? {})).toEqual([
      "content",
      "role",
      "tool_calls",
    ]);
  });

  it("never replays reasoning on the textual fallback", () => {
    const fallback = render(
      [read(0, "retired", "provider.retired"), read(1, "one")],
      [[thinkZero], [thinkOne]],
    );

    expect(fallback.nativeHistory).toBe(false);
    expect(fallback.postPromptMessages.map((message) => Object.keys(message))).toEqual([
      ["content", "role", "tool_calls"],
      ["content", "role", "tool_call_id"],
    ]);
  });

  it("keeps replaying reasoning when the context before the history changes", () => {
    const pack = (overrides: Parameters<typeof request>[0]) =>
      packRuntimeModelContext(
        request({
          completedToolCalls: [read(0, "zero").tool],
          modelId: OPUS,
          modelToolCallSlots: [read(0, "zero").slot],
          replayReasoning: replayed([[thinkZero]]),
          ...overrides,
        }),
        {
          gemma4: false,
          modelToolAliases: aliases,
          modelToolDefinitions: [{ function: { name: "runtime_tool_0" }, type: "function" }],
        },
      );
    const first = pack({});
    const changed = pack({
      recentMessages: [
        { content: "An earlier question.", messageId: id("30"), role: "user", threadId: id("8") },
      ],
      runContext: "Today is a new day.",
      sandboxArtifacts: [
        { content: "exitCode: 0", fileName: "run.txt", label: "Run output", type: "deploy_log" },
      ],
    });
    const assistantReasoning = (messages: readonly OpenAiCompatibleChatCompletionMessage[]) =>
      messages.find((message) => message.role === "assistant")?.reasoning_details;

    expect<unknown>(assistantReasoning(first.messages)).toEqual([thinkZero]);
    expect<unknown>(assistantReasoning(changed.messages)).toEqual([thinkZero]);
    expect(changed.metrics.replayedReasoningGenerations).toBe(1);
  });

  it("counts replayed reasoning against the input budget", () => {
    const turn = {
      content: "",
      role: "assistant",
      tool_calls: [
        {
          function: { arguments: "{}", name: "runtime_tool_0" },
          id: "mt0000000",
          type: "function",
        },
      ],
    } satisfies OpenAiCompatibleChatCompletionMessage;

    expect(
      estimatedMessageTokens({
        ...turn,
        reasoning_details: [{ data: "x".repeat(1_000), type: "reasoning.encrypted" }],
      }) - estimatedMessageTokens(turn),
    ).toBe(1_063);
  });
});
