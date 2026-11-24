import { describe, expect, it } from "bun:test";
import type { Ulid } from "@deployments-ai/db";
import {
  DEFAULT_AGENT_MODEL_ID,
  type ModelGatewayChatCompletionRequest,
  type ModelGatewayService,
  type ModelGatewayToolCall,
} from "@deployments-ai/model-gateway";
import { Effect } from "effect";
import { modelGatewayGenerationPort } from "./model-gateway.ts";
import { safeResponseInterpretation } from "./model-response-diagnostics.ts";
import { responseDepthClassificationRequest } from "./response-depth.ts";
import type { RuntimeModelGenerationRequest, RuntimeToolDefinition } from "./types.ts";

type CustomerRuntimeModelGenerationRequest = Extract<
  RuntimeModelGenerationRequest,
  { readonly executionPurpose?: "customer" }
>;

const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}` as Ulid;
const idempotencyKey = `${id("7")}:model-tool:0:0`;
const tool: RuntimeToolDefinition = {
  effect: "write",
  inputSchema: {
    additionalProperties: false,
    properties: { resource: { type: "string" } },
    required: ["resource"],
    type: "object",
  },
  requiredScopes: [],
  toolName: "synthetic.update",
};
const policy = {
  classifierInstructions: "Return exactly default or detailed.",
  detailedInstructions: "Develop the answer without padding.",
  minimumWords: 3,
  maximumWords: 5,
};
const usage = {
  idempotencyKey: "metered-call",
  occurredAt: 1,
  quantity: 23,
  source: "model-gateway",
  type: "model_tokens",
  unit: "tokens",
};
const gemma4Route = {
  modelId: "openrouter/example/custom-gemma4",
  modelInputTokenBudget: 8_192,
  modelOutputTokenReserve: 512,
  modelToolProtocol: "gemma4",
} as const;

function request(
  overrides: Partial<CustomerRuntimeModelGenerationRequest> = {},
): CustomerRuntimeModelGenerationRequest {
  return {
    agentDefinitionId: id("1"),
    agentDeploymentId: id("2"),
    agentManifestHash: "sha256:test-manifest",
    agentReleaseId: id("3"),
    brainEvidence: [],
    captureMode: "metadata-only",
    completedToolCalls: [],
    environmentId: id("4"),
    instructions: "Use the run evidence.",
    memories: [],
    modelCallId: "metered-call",
    modelId: DEFAULT_AGENT_MODEL_ID,
    modelToolCallSlots: [],
    organizationId: id("5"),
    projectId: id("6"),
    prompt: "Describe the result.",
    recentMessages: [],
    responseDepthMode: "detailed",
    responseDepthPolicy: policy,
    runId: id("7"),
    sandboxArtifacts: [],
    skills: [],
    spanId: "0123456789abcdef",
    threadId: id("8"),
    traceId: "0123456789abcdef0123456789abcdef",
    tools: [],
    ...overrides,
  };
}

function generate(
  assistantMessage: string,
  input = request(),
  toolCalls?: readonly ModelGatewayToolCall[],
) {
  const gateway = {
    chatCompletion: () =>
      Effect.succeed({
        assistantMessage,
        body: {},
        finishReason: "stop",
        inputTokens: 17,
        modelCallId: input.modelCallId,
        modelId: input.modelId,
        outputTokens: 6,
        route: {},
        totalTokens: 23,
        usage,
        ...(toolCalls ? { toolCalls } : {}),
      } as never),
  } as unknown as ModelGatewayService;
  return modelGatewayGenerationPort(gateway)(input);
}

function completedRequest(effect: RuntimeToolDefinition["effect"]) {
  return request({
    ...gemma4Route,
    completedToolCalls: [
      {
        effect,
        idempotencyKey,
        input: { resource: "alpha" },
        inputSummary: "Update the synthetic resource.",
        outputSummary: "Updated the synthetic resource.",
        policyAction: "allow",
        policyReason: "Allowed.",
        requiredScopes: [],
        toolCallId: id("20"),
        toolName: tool.toolName,
      },
    ],
    modelToolCallSlots: [{ idempotencyKey, modelCallIndex: 0, toolCallIndex: 0 }],
    tools: [{ ...tool, effect }],
  });
}

describe("response depth interpretation", () => {
  it.each([
    ["provider", {}, "private short", 2],
    ["gemma4", gemma4Route, "private response that exceeds the permitted length", 7],
  ] as const)(
    "rejects out-of-bound %s drafts without leaking text",
    async (_route, overrides, draft, wordCount) => {
      const result = await generate(draft, request(overrides));
      expect(result.assistantMessage).toBe("");
      expect(result.responseError).toBeDefined();
      expect(result.toolCalls).toBeUndefined();
      expect(result.usage).toEqual([usage]);
      expect(result.totalTokens).toBe(23);
      expect(safeResponseInterpretation(result.metadata?.responseInterpretation)).toMatchObject({
        assistantCharacters: 0,
        disposition: "rejected-response-depth",
        responseDepthViolation: { wordCount, minimumWords: 3, maximumWords: 5 },
      });
      expect(JSON.stringify(result)).not.toContain(draft);
    },
  );

  it("rejects overlong visible default text with safe diagnostics and retained usage", async () => {
    const draft = "private ordinary answer";
    const result = await generate(
      `<thought>private reasoning</thought>\n${draft}`,
      request({
        ...gemma4Route,
        responseDepthMode: "default",
        responseDepthPolicy: { ...policy, defaultMaximumWords: 2 },
      }),
    );
    expect(result.assistantMessage).toBe("");
    expect(result.responseError).toBeDefined();
    expect(result.usage).toEqual([usage]);
    expect(result.totalTokens).toBe(23);
    expect(safeResponseInterpretation(result.metadata?.responseInterpretation)).toMatchObject({
      assistantCharacters: 0,
      disposition: "rejected-response-depth",
      responseDepthViolation: { wordCount: 3, minimumWords: 1, maximumWords: 2 },
    });
    expect(JSON.stringify(result)).not.toContain(draft);
    expect(JSON.stringify(result)).not.toContain("private reasoning");
  });

  it("preserves in-bound text exactly and leaves default-mode brevity alone", async () => {
    const answer = "one\ttwo three\n\nfour five";
    expect((await generate(answer)).assistantMessage).toBe(answer);
    const ordinary = await generate("brief", request({ responseDepthMode: "default" }));
    expect(ordinary.assistantMessage).toBe("brief");
    expect(ordinary.responseError).toBeUndefined();
  });

  it("counts only visible Gemma text, not hidden reasoning", async () => {
    const result = await generate(
      "<thought>one two three four five</thought>\nshort",
      request(gemma4Route),
    );
    expect(result.assistantMessage).toBe("");
    expect(result.metadata?.responseInterpretation).toMatchObject({
      responseDepthViolation: { wordCount: 1 },
    });
  });

  it.each(["detailed", "default"] as const)(
    "does not reject an outward tool-call turn for out-of-bound %s accompanying text",
    async (responseDepthMode) => {
      const result = await generate(
        "updating now",
        request({
          tools: [tool],
          responseDepthMode,
          responseDepthPolicy: { ...policy, defaultMaximumWords: 1 },
        }),
        [{ arguments: { resource: "alpha" }, id: "provider-call", name: "runtime_tool_0" }],
      );
      expect(result.toolCalls).toEqual([
        {
          input: { resource: "alpha" },
          modelToolCallId: "provider-call",
          toolName: tool.toolName,
        },
      ]);
      expect(result.responseError).toBeUndefined();
    },
  );

  it.each([
    ["detailed", "", "post-side-effect-acknowledgement"],
    ["detailed", "call:runtime_tool_0{resource:alpha}", "repeated-side-effect-acknowledgement"],
    ["default", "", "post-side-effect-acknowledgement"],
    ["default", "call:runtime_tool_0{resource:alpha}", "repeated-side-effect-acknowledgement"],
  ] as const)(
    "preserves recognized completed side-effect acknowledgements in %s mode: %s",
    async (responseDepthMode, content, disposition) => {
      const result = await generate(content, {
        ...completedRequest("write"),
        responseDepthMode,
        responseDepthPolicy: { ...policy, defaultMaximumWords: 1 },
      });
      expect(result.assistantMessage).toBe("got it");
      expect(result.toolCalls).toBeUndefined();
      expect(result.responseError).toBeUndefined();
      expect(result.metadata?.responseInterpretation).toMatchObject({ disposition });
    },
  );

  it("does not exempt post-read answers from detailed bounds", async () => {
    const result = await generate("short", completedRequest("read"));
    expect(result.assistantMessage).toBe("");
    expect(result.metadata?.responseInterpretation).toMatchObject({
      disposition: "rejected-response-depth",
    });
  });

  it("sends a private, tool-free, architecture-aware 64-token classifier request", async () => {
    let sent: ModelGatewayChatCompletionRequest | undefined;
    const gateway = {
      chatCompletion: (input: ModelGatewayChatCompletionRequest) => {
        sent = input;
        return Effect.succeed({
          assistantMessage: "detailed",
          modelCallId: input.modelCallId,
        } as never);
      },
    } as unknown as ModelGatewayService;
    const classifier = responseDepthClassificationRequest(
      request({
        modelToolProtocol: "gemma4",
        tools: [tool],
      }),
      policy,
    );
    const result = await modelGatewayGenerationPort(gateway)(classifier);
    expect(result.assistantMessage).toBe("detailed");
    expect(sent?.maxTokens).toBe(64);
    expect(sent?.tools).toBeUndefined();
    expect(sent?.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(sent?.additionalBody).toBeDefined();
  });
});
