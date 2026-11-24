import { describe, expect, it } from "bun:test";
import type {
  ModelGatewayChatCompletionRequest,
  ModelGatewayService,
  ModelGatewayToolCall,
} from "@deployments-ai/model-gateway";
import { Effect } from "effect";
import { modelGatewayGenerationPort, packRuntimeModelContext } from "./model-gateway.ts";
import { createTestAgentRuntime, id, input } from "./runtime.fixture.ts";
import type { RuntimeModelGenerationRequest, RuntimeToolDefinition } from "./types.ts";

type CustomerRuntimeModelGenerationRequest = Extract<
  RuntimeModelGenerationRequest,
  { readonly executionPurpose?: "customer" }
>;

const customRoute = {
  modelFallbackIds: [],
  modelId: "openrouter/example/custom-gemma4",
  modelInputTokenBudget: 8_192,
  modelOutputTokenReserve: 512,
} as const;
const tool: RuntimeToolDefinition = {
  effect: "write",
  inputSchema: {
    additionalProperties: false,
    properties: {
      count: { minimum: 1, type: "integer" },
      resource: { enum: ["alpha", "beta"], type: "string" },
    },
    required: ["resource"],
    type: "object",
  },
  requiredScopes: [],
  toolName: "synthetic.update",
};
const call = 'call:runtime_tool_0{resource:"alpha"}';
const completedWrite = {
  effect: "write",
  idempotencyKey: `${id("7")}:model-tool:0:0`,
  input: { resource: "alpha" },
  inputSummary: "Update alpha.",
  outputSummary: "Alpha updated.",
  policyAction: "allow",
  policyReason: "Allowed.",
  requiredScopes: [],
  toolCallId: id("20"),
  toolName: tool.toolName,
} as const;
const laughterHistory = [
  { content: "the box finally arrived lol", role: "assistant" },
  { content: "I put it on the shelf lol", role: "assistant" },
  { content: "the label fell off lol", role: "assistant" },
] as const;

function request(
  overrides: Partial<CustomerRuntimeModelGenerationRequest> = {},
): CustomerRuntimeModelGenerationRequest {
  const { inputMedia: _media, ...base } = input(customRoute);
  return {
    ...base,
    brainEvidence: [],
    completedToolCalls: [],
    memories: [],
    modelCallId: "model-call-1",
    modelToolCallSlots: [],
    recentMessages: [],
    sandboxArtifacts: [],
    skills: [],
    tools: [tool],
    modelToolProtocol: "gemma4",
    ...overrides,
  };
}

function gateway(
  respond: (request: ModelGatewayChatCompletionRequest) => {
    readonly assistantMessage: string;
    readonly finishReason?: string;
    readonly toolCalls?: readonly ModelGatewayToolCall[];
  },
): ModelGatewayService {
  return {
    chatCompletion: (request: ModelGatewayChatCompletionRequest) =>
      Effect.succeed({
        ...respond(request),
        body: {},
        modelCallId: request.modelCallId,
        route: {},
      } as never),
  } as unknown as ModelGatewayService;
}

describe("explicit custom-route Gemma 4 tools", () => {
  it("executes a validated textual call through the runtime and completes its continuation", async () => {
    const executed: unknown[] = [];
    const requests: ModelGatewayChatCompletionRequest[] = [];
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id("20"),
      }),
      executeToolCall: async (request) => {
        executed.push(request.input);
        return { outputSummary: "Alpha updated.", status: "completed" };
      },
      generateAssistantMessage: modelGatewayGenerationPort(
        gateway((request) => {
          requests.push(request);
          return {
            assistantMessage: requests.length === 1 ? call : "Alpha is ready.",
            finishReason: "stop",
          };
        }),
      ),
      resolveToolDefinition: async () => tool,
    });

    const result = await runtime.execute(
      input({ ...customRoute, modelToolNames: [tool.toolName], modelToolProtocol: "gemma4" }),
    );

    expect(result.completionStatus).toBe("completed");
    expect(result.assistantMessage).toBe("Alpha is ready.");
    expect(executed).toEqual([{ resource: "alpha" }]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.messages[0]?.content).toContain("call:runtime_tool_0{resource:<string>}");
  });

  it("does not interpret text as a call on a non-opted-in custom route", async () => {
    const nativeRequest = request();
    const { modelToolProtocol: _protocol, ...withoutProtocol } = nativeRequest;
    const result = await modelGatewayGenerationPort(
      gateway(() => ({ assistantMessage: call, finishReason: "stop" })),
    )(withoutProtocol);

    expect(result.assistantMessage).toBe(call);
    expect(result.toolCalls).toBeUndefined();
  });

  it("rejects habitual laughter on an explicitly opted-in custom Gemma route", async () => {
    const result = await modelGatewayGenerationPort(
      gateway(() => ({ assistantMessage: "try the blue drawer lol", finishReason: "stop" })),
    )(request({ recentMessages: laughterHistory }));

    expect(result.assistantMessage).toBe("");
    expect(result.responseError).toBeDefined();
    expect(result.metadata?.responseInterpretation).toMatchObject({
      disposition: "rejected-habitual-laughter-ending",
    });
  });

  it("does not reject laughter on a non-Gemma custom route", async () => {
    const nativeRequest = request({ recentMessages: laughterHistory });
    const { modelToolProtocol: _protocol, ...withoutProtocol } = nativeRequest;
    const result = await modelGatewayGenerationPort(
      gateway(() => ({ assistantMessage: "try the blue drawer lol", finishReason: "stop" })),
    )(withoutProtocol);

    expect(result.assistantMessage).toBe("try the blue drawer lol");
    expect(result.responseError).toBeUndefined();
  });

  it("accepts a clean Gemma response despite habitual laughter in history", async () => {
    const result = await modelGatewayGenerationPort(
      gateway(() => ({ assistantMessage: "try the blue drawer.", finishReason: "stop" })),
    )(request({ recentMessages: laughterHistory }));

    expect(result.assistantMessage).toBe("try the blue drawer.");
    expect(result.responseError).toBeUndefined();
  });

  it.each(["provider", "textual"] as const)(
    "keeps a valid %s tool call despite habitual laughter in history",
    async (format) => {
      const result = await modelGatewayGenerationPort(
        gateway(() =>
          format === "provider"
            ? {
                assistantMessage: "I'll update the record lol",
                finishReason: "tool_calls",
                toolCalls: [
                  {
                    arguments: { resource: "alpha" },
                    id: "provider-tool-1",
                    name: "runtime_tool_0",
                  },
                ],
              }
            : { assistantMessage: call, finishReason: "stop" },
        ),
      )(request({ recentMessages: laughterHistory }));

      expect(result.responseError).toBeUndefined();
      expect(result.toolCalls).toEqual([
        {
          input: { resource: "alpha" },
          modelToolCallId: expect.any(String),
          toolName: tool.toolName,
        },
      ]);
    },
  );

  it("keeps a completed side-effect acknowledgement despite habitual laughter in history", async () => {
    const result = await modelGatewayGenerationPort(
      gateway(() => ({ assistantMessage: call, finishReason: "stop" })),
    )(
      request({
        completedToolCalls: [completedWrite],
        modelToolCallSlots: [
          { idempotencyKey: completedWrite.idempotencyKey, modelCallIndex: 0, toolCallIndex: 0 },
        ],
        recentMessages: laughterHistory,
      }),
    );

    expect(result.assistantMessage).toBe("got it");
    expect(result.toolCalls).toBeUndefined();
    expect(result.responseError).toBeUndefined();
  });

  it.each([
    ["unknown tool", 'call:unavailable{resource:"alpha"}', "stop"],
    ["missing required input", "call:runtime_tool_0{}", "stop"],
    ["invalid scalar type", 'call:runtime_tool_0{resource:"alpha",count:true}', "stop"],
    ["invalid enum", 'call:runtime_tool_0{resource:"gamma"}', "stop"],
    ["extra input", 'call:runtime_tool_0{resource:"alpha",extra:true}', "stop"],
    ["truncated envelope", 'call:runtime_tool_0{resource:"alpha"', "length"],
    ["exhausted without authoritative boundary", call, "length"],
    ["second call", `${call}\ncall:runtime_tool_0{resource:"beta"}`, "stop"],
    ["cancellation", `${call} actually, cancel that`, "stop"],
  ])(
    "rejects %s without displaying raw tool syntax",
    async (_case, assistantMessage, finishReason) => {
      const result = await modelGatewayGenerationPort(
        gateway(() => ({ assistantMessage, finishReason })),
      )(request());

      expect(result.assistantMessage).toBe("");
      expect(result.toolCalls).toBeUndefined();
    },
  );

  it("rejects a non-scalar tool schema before invoking the custom provider", async () => {
    let calls = 0;
    const generate = modelGatewayGenerationPort(
      gateway(() => {
        calls += 1;
        return { assistantMessage: call };
      }),
    );
    expect(
      generate(
        request({
          tools: [
            {
              ...tool,
              inputSchema: {
                additionalProperties: false,
                properties: { resource: { type: "object" } },
                required: ["resource"],
                type: "object",
              },
            },
          ],
        }),
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("rejects an invalid structured call instead of recovering accompanying text", async () => {
    const result = await modelGatewayGenerationPort(
      gateway(() => ({
        assistantMessage: call,
        finishReason: "stop",
        toolCalls: [{ arguments: {}, id: "provider-call-1", name: "runtime_tool_0" }],
      })),
    )(request());

    expect(result.assistantMessage).toBe("");
    expect(result.toolCalls).toBeUndefined();
  });

  it("rejects a valid textual call when the continuation budget disabled tools", async () => {
    const inputTokenBudget =
      packRuntimeModelContext(request(), { gemma4: true, modelToolDefinitions: [] }).metrics
        .estimatedInputTokens + 768;
    let captured: ModelGatewayChatCompletionRequest | undefined;
    const result = await modelGatewayGenerationPort(
      gateway((request) => {
        captured = request;
        return { assistantMessage: call, finishReason: "stop" };
      }),
    )(
      request({
        completedToolCalls: [completedWrite],
        modelInputTokenBudget: inputTokenBudget,
        modelToolCallSlots: [
          { idempotencyKey: completedWrite.idempotencyKey, modelCallIndex: 0, toolCallIndex: 0 },
        ],
        tools: [{ ...tool, description: "x".repeat(4_096) }],
      }),
    );

    expect(captured?.tools).toBeUndefined();
    expect(result.assistantMessage).toBe("");
    expect(result.toolCalls).toBeUndefined();
  });

  it("does not repeat an already completed write on an opted-in custom route", async () => {
    const result = await modelGatewayGenerationPort(
      gateway(() => ({ assistantMessage: call, finishReason: "stop" })),
    )(
      request({
        completedToolCalls: [completedWrite],
        modelToolCallSlots: [
          { idempotencyKey: completedWrite.idempotencyKey, modelCallIndex: 0, toolCallIndex: 0 },
        ],
      }),
    );

    expect(result.assistantMessage).toBe("got it");
    expect(result.toolCalls).toBeUndefined();
  });
});
