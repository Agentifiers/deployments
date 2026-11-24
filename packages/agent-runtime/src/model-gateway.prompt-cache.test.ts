import { describe, expect, it } from "bun:test";
import type {
  ModelGatewayChatCompletionRequest,
  ModelGatewayService,
  OpenAiCompatibleChatCompletionMessage,
} from "@deployments-ai/model-gateway";
import { Effect } from "effect";
import { replayReasoningForAttempt, validateGenerationReasoning } from "./generation-reasoning.ts";
import { modelGatewayGenerationPort } from "./model-gateway.ts";
import {
  id,
  request,
  type CustomerRuntimeModelGenerationRequest,
} from "./model-tool-context.fixture.ts";
import type {
  RuntimeArtifact,
  RuntimeCompletedToolCall,
  RuntimeModelToolCallSlot,
  RuntimeToolDefinition,
} from "./types.ts";

const OPUS = "openrouter/anthropic/claude-opus-5.5";
const breakpoint = { cache_control: { type: "ephemeral" } };
const tools: readonly RuntimeToolDefinition[] = [
  {
    description: "Read a resource.",
    effect: "read",
    inputSchema: { properties: { resource: { type: "string" } }, type: "object" },
    requiredScopes: [],
    toolName: "provider.read",
  },
];

function read(generation: number, call: number, resource: string) {
  const idempotencyKey = `${id("7")}:model-tool:${generation}:${call}`;
  return {
    slot: { idempotencyKey, modelCallIndex: generation, toolCallIndex: call },
    tool: {
      effect: "read" as const,
      idempotencyKey,
      input: { resource },
      inputSummary: `Read ${resource}.`,
      outputSummary: `${resource} is active.`,
      policyAction: "allow" as const,
      policyReason: "Read is allowed.",
      requiredScopes: [],
      toolCallId: id(String(20 + generation * 8 + call)),
      toolName: "provider.read",
    },
  } satisfies { slot: RuntimeModelToolCallSlot; tool: RuntimeCompletedToolCall };
}

async function send(overrides: Partial<CustomerRuntimeModelGenerationRequest>) {
  let captured: ModelGatewayChatCompletionRequest | undefined;
  const gateway = {
    chatCompletion: (input: ModelGatewayChatCompletionRequest) => {
      captured = input;
      return Effect.succeed({
        assistantMessage: "Done.",
        body: {},
        modelCallId: "model-call-1",
        route: {},
      } as never);
    },
  } as unknown as ModelGatewayService;
  await modelGatewayGenerationPort(gateway)(
    request({ modelId: OPUS, modelOptions: { promptCache: "conversation" }, tools, ...overrides }),
  );
  if (!captured) throw new Error("The gateway was not called.");
  return captured;
}

function withHistory(
  reads: readonly ReturnType<typeof read>[],
  overrides: Partial<CustomerRuntimeModelGenerationRequest> = {},
) {
  return send({
    completedToolCalls: reads.map(({ tool }) => tool),
    modelToolCallSlots: reads.map(({ slot }) => slot),
    ...overrides,
  });
}

/** Indexes of messages carrying a cache breakpoint on any content part. */
function breakpoints(messages: readonly OpenAiCompatibleChatCompletionMessage[]) {
  return messages.flatMap((message, index) =>
    Array.isArray(message.content) &&
    message.content.some(
      (part) => typeof part === "object" && part !== null && "cache_control" in part,
    )
      ? [index]
      : [],
  );
}

const changingArtifact = (generation: number): RuntimeArtifact => ({
  content: `exitCode: 0\nstdout: generation ${generation}`,
  fileName: `code-execute-${generation}.txt`,
  label: "Sandboxed code output",
  type: "deploy_log",
});

function replayedReasoning(count: number) {
  const thinking = (modelCallIndex: number) =>
    count % 2 === 0
      ? {
          format: "anthropic-claude-v1",
          index: 0,
          signature: `c2ln${modelCallIndex}`,
          text: `Think ${modelCallIndex}.`,
          type: "reasoning.text",
        }
      : {
          type: "reasoning.text",
          text: `Think ${modelCallIndex}.`,
          signature: `c2ln${modelCallIndex}`,
          index: 0,
          format: "anthropic-claude-v1",
        };
  return replayReasoningForAttempt({
    attempt: 0,
    history: validateGenerationReasoning(
      Array.from({ length: count }, (_, modelCallIndex) => ({
        details: [thinking(modelCallIndex)],
        modelCallIndex,
        producerAttemptId: `attempt-${modelCallIndex}`,
        producerModelId: OPUS,
      })),
      count,
    ),
    modelId: OPUS,
    modelToolProtocol: undefined,
  });
}

describe("conversation prompt cache breakpoints", () => {
  it("marks the system prompt and the last tool-history message, never the trailing artifacts", async () => {
    const captured = await withHistory([read(0, 0, "zero"), read(0, 1, "one")], {
      sandboxArtifacts: [changingArtifact(0)],
    });
    const roles = captured.messages.map((message) => message.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool", "tool", "user"]);
    expect(breakpoints(captured.messages)).toEqual([0, 4]);
    expect(captured.additionalBody).not.toHaveProperty("cache_control");
    expect(captured.messages[4]?.content).toEqual([
      { ...breakpoint, text: expect.stringContaining("one is active."), type: "text" },
    ]);
    expect(String(captured.messages[5]?.content)).toContain("generation 0");
  });

  it.each([false, true])(
    "keeps each generation's request a byte-identical extension of the previous cached prefix (reasoning: %p)",
    async (withReasoning) => {
      const generations = [
        [read(0, 0, "zero"), read(0, 1, "one")],
        [read(1, 0, "two")],
        [read(2, 0, "three"), read(2, 1, "four")],
      ];
      const requests = [];
      for (let index = 1; index <= generations.length; index += 1) {
        requests.push(
          await withHistory(generations.slice(0, index).flat(), {
            ...(withReasoning ? { replayReasoning: replayedReasoning(index) } : {}),
            sandboxArtifacts: [changingArtifact(index)],
          }),
        );
      }
      expect(
        requests.map(
          (captured) => captured.messages.filter((message) => message.reasoning_details).length,
        ),
      ).toEqual(withReasoning ? [1, 2, 3] : [0, 0, 0]);
      for (let index = 1; index < requests.length; index += 1) {
        const previous = requests[index - 1]!;
        const current = requests[index]!;
        const cachedThrough = breakpoints(previous.messages).at(-1)!;
        const plain = (messages: readonly OpenAiCompatibleChatCompletionMessage[]) =>
          messages.map(({ content, ...rest }) => ({
            ...rest,
            content:
              typeof content === "string"
                ? content
                  ? [{ text: content, type: "text" }]
                  : []
                : content.map((part) => {
                    const { cache_control: _marker, ...block } = part as Record<string, unknown>;
                    return block;
                  }),
          }));
        expect(JSON.stringify(plain(current.messages.slice(0, cachedThrough + 1)))).toBe(
          JSON.stringify(plain(previous.messages.slice(0, cachedThrough + 1))),
        );
        expect(breakpoints(current.messages).at(-1)).toBeGreaterThan(cachedThrough);
      }
    },
  );

  it("marks the prompt before any tool has run", async () => {
    const captured = await send({ sandboxArtifacts: [changingArtifact(0)] });
    const promptIndex = captured.messages.findIndex(
      (message) =>
        Array.isArray(message.content) &&
        JSON.stringify(message.content).includes("Report the artifact result."),
    );
    expect(promptIndex).toBeGreaterThan(0);
    expect(breakpoints(captured.messages)).toEqual([0, promptIndex]);
  });

  it("keeps the breakpoint before the screenshot image message", async () => {
    const capture = read(0, 0, "page");
    const captured = await withHistory([capture], {
      sandboxArtifacts: [
        {
          content: Uint8Array.from(
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
              "base64",
            ),
          ),
          contentType: "image/png",
          fileName: "shot.png",
          label: "Screenshot",
          metadata: {
            toolCallId: capture.tool.toolCallId,
            url: "https://example.com/",
            viewport: "desktop",
          },
          type: "screenshot",
        },
      ],
      toolResultImages: "screenshots",
    });
    const imageIndex = captured.messages.findIndex((message) =>
      JSON.stringify(message.content).includes("image_url"),
    );
    expect(imageIndex).toBeGreaterThan(0);
    expect(captured.messages[imageIndex - 1]?.role).toBe("tool");
    expect(breakpoints(captured.messages)).toEqual([0, imageIndex - 1]);
  });

  it("marks only the system prompt when the history is rewritten as textual context", async () => {
    const retired = {
      ...read(0, 0, "retired"),
      tool: { ...read(0, 0, "retired").tool, toolName: "provider.retired" },
    };
    const captured = await withHistory([retired], { sandboxArtifacts: [changingArtifact(0)] });
    expect(captured.messages.some((message) => message.role === "tool")).toBe(false);
    expect(breakpoints(captured.messages)).toEqual([0]);
  });

  it("marks only the system prompt with the system cache mode", async () => {
    const captured = await withHistory([read(0, 0, "zero")], {
      modelOptions: { promptCache: "system" },
    });
    expect(breakpoints(captured.messages)).toEqual([0]);
  });

  it("sends no cache markers on routes outside OpenRouter", async () => {
    const captured = await withHistory([read(0, 0, "zero")], { modelId: "openai/gpt-5.2" });
    expect(breakpoints(captured.messages)).toEqual([]);
    expect(captured.additionalBody).toBeUndefined();
  });
});
