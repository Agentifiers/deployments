import { describe, expect, it } from "bun:test";
import type {
  ModelGatewayChatCompletionRequest,
  ModelGatewayService,
} from "@deployments-ai/model-gateway";
import { DEFAULT_AGENT_MODEL_ID } from "@deployments-ai/model-gateway";
import type { Ulid } from "@deployments-ai/db";
import { Effect } from "effect";
import { modelGatewayGenerationPort } from "./model-gateway.ts";
import type { RuntimeModelGenerationRequest, RuntimeToolDefinition } from "./types.ts";

type CustomerRuntimeModelGenerationRequest = Extract<
  RuntimeModelGenerationRequest,
  { readonly executionPurpose?: "customer" }
>;

const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}` as Ulid;
const gemma4Route = {
  modelId: "openrouter/example/custom-gemma4",
  modelInputTokenBudget: 8_192,
  modelOutputTokenReserve: 512,
  modelToolProtocol: "gemma4",
} as const;
const boundedRemindTool: RuntimeToolDefinition = {
  effect: "write",
  inputSchema: {
    additionalProperties: false,
    properties: {
      delayMinutes: { maximum: 43_200, minimum: 1, type: "integer" },
      name: { minLength: 1, type: "string" },
      prompt: { minLength: 1, type: "string" },
    },
    required: ["delayMinutes", "name", "prompt"],
    type: "object",
  },
  requiredScopes: [],
  toolName: "agent.schedule.remind",
};

const describedRemindTool: RuntimeToolDefinition = {
  description: "Create a one-time follow-up.",
  effect: "write",
  inputSchema: {
    additionalProperties: false,
    properties: {
      delayMinutes: { type: "integer" },
      name: { type: "string" },
      prompt: { type: "string" },
    },
    required: ["delayMinutes", "name", "prompt"],
    type: "object",
  },
  requiredScopes: ["schedules:write"],
  toolName: "agent.schedule.remind",
};

const remindTool: RuntimeToolDefinition = {
  effect: "write",
  inputSchema: {
    additionalProperties: false,
    properties: {
      delayMinutes: { type: "integer" },
      name: { type: "string" },
      prompt: { type: "string" },
    },
    required: ["delayMinutes", "name", "prompt"],
    type: "object",
  },
  requiredScopes: [],
  toolName: "agent.schedule.remind",
};

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
    modelCallId: "model-call-1",
    modelToolCallSlots: [],
    modelId: DEFAULT_AGENT_MODEL_ID,
    organizationId: id("5"),
    projectId: id("6"),
    prompt: "Report the artifact result.",
    recentMessages: [],
    runId: id("7"),
    sandboxArtifacts: [],
    spanId: "0123456789abcdef",
    skills: [],
    threadId: id("8"),
    traceId: "0123456789abcdef0123456789abcdef",
    tools: [],
    ...overrides,
  };
}

describe("Gemma 4 textual tool recovery", () => {
  it("pins exact Gemma 4 textual tool signatures in trusted system context", async () => {
    let captured: ModelGatewayChatCompletionRequest | undefined;
    const gateway = {
      chatCompletion: (input: ModelGatewayChatCompletionRequest) => {
        captured = input;
        return Effect.succeed({
          assistantMessage:
            "call:runtime_tool_0{delayMinutes:2,name:check_in,prompt:Send the requested follow-up.}",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never);
      },
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        tools: [
          {
            description: "Create a one-time follow-up.",
            effect: "write",
            inputSchema: {
              additionalProperties: false,
              properties: {
                delayMinutes: { type: "integer" },
                name: { type: "string" },
                prompt: { type: "string" },
              },
              required: ["delayMinutes", "name", "prompt"],
              type: "object",
            },
            requiredScopes: ["schedules:write"],
            toolName: "agent.schedule.remind",
          },
          {
            description: "List scheduled follow-ups.",
            effect: "read",
            inputSchema: {
              additionalProperties: false,
              properties: {
                cursor: { type: "string" },
                limit: { type: "integer" },
              },
              type: "object",
            },
            requiredScopes: ["schedules:read"],
            toolName: "agent.schedule.list",
          },
        ],
      }),
    );

    const systemMessage = captured?.messages.find((message) => message.role === "system");
    expect(systemMessage?.content).toContain(
      "call:runtime_tool_0{delayMinutes:<integer>,name:<string>,prompt:<string>}",
    );
    expect(systemMessage?.content).toContain("call:runtime_tool_1{}");
    expect(systemMessage?.content).toContain(
      "runtime_tool_1 optional fields: cursor:<string>,limit:<integer>",
    );
    expect(systemMessage?.content).toContain(
      "Omit an optional field's entire name:value pair when it is not needed.",
    );
    expect(systemMessage?.content).not.toContain(
      "call:runtime_tool_1{cursor:<string>,limit:<integer>}",
    );
    expect(systemMessage?.content).toContain("Never invent or rename a function or parameter.");
    expect(result.toolCalls).toHaveLength(1);
  });

  it("recovers Gemma 4 textual tool calls instead of exposing them to the user", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage:
            "call:runtime_tool_0{delayMinutes:2,name:quick_check_in,prompt:Send Rowan a short, natural follow-up.}\nthought\non it. i'll check back with you in a sec.",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        tools: [describedRemindTool],
      }),
    );

    expect(result.assistantMessage).toBe("");
    expect(result.toolCalls).toEqual([
      {
        input: {
          delayMinutes: 2,
          name: "quick_check_in",
          prompt: "Send Rowan a short, natural follow-up.",
        },
        modelToolCallId: expect.any(String),
        toolName: "agent.schedule.remind",
      },
    ]);
  });

  it.each([
    [
      "_call:agent.schedule.remind{delayMinutes:2,name:quick_check_in,prompt:Send Rowan a short follow-up.}on_success: got it. i'll text you in two.",
      "quick_check_in",
    ],
    [
      "call:agent.schedule.remind({delayMinutes:2,name:'quick check in',prompt:'Send Rowan a short follow-up.'})text\non it. i'll text you in two.",
      "quick check in",
    ],
    [
      "<|tool_call>_call:agent.schedule.remind{delayMinutes:2,name:quick_check_in,prompt:Send Rowan a short follow-up.}<tool_call|>",
      "quick_check_in",
    ],
    [
      "_call:agent.schedule.remind{delayMinutes:2,name:quick_check_in,prompt:Send Rowan a short follow-up.}done. i'll text you in two.",
      "quick_check_in",
    ],
    [
      '_call:agent.schedule.remind{delayMinutes:2,name:quick_check_in,prompt:Send Rowan a short follow-up.}on_success: "got it. i\'ll text you in two."',
      "quick_check_in",
    ],
    [
      "_call:agent.schedule.remind{delayMinutes:2,name:quick_check_in,prompt:Send Rowan a short follow-up.}on_call: [OK]\n\ngot it. i'll text you in two.",
      "quick_check_in",
    ],
    [
      "call:agent.schedule.remind{delayMinutes:2,name:quick_check_in,prompt:Send Rowan a short follow-up.}text:on it. i'll text you in two.",
      "quick_check_in",
    ],
    [
      '_call:agent.schedule.remind{delayMinutes:2,name:quick_check_in,prompt:Send Rowan a short follow-up.}on_tool_success: "got it. i\'ll text you in two."',
      "quick_check_in",
    ],
    [
      'call:runtime_tool_0{delayMinutes:2,name:"quick_check_in",prompt:"Send Rowan a short follow-up."}\n\ngot it, i\'ll message you in two.',
      "quick_check_in",
    ],
    [
      'call:runtime_tool_0{delayMinutes:2,name:"check_in_on_rowan",prompt:"Send Rowan a short follow-up."}\non it. i\'ll buzz you in 2.',
      "check_in_on_rowan",
    ],
    [
      'call:runtime_tool_0{delayMinutes:2,name:"quick check in",prompt:"Send Rowan a short follow-up."}\n\ngotcha. i\'ll buzz you in a bit.',
      "quick check in",
    ],
    [
      'call:runtime_tool_0{delayMinutes:2,name:"quick_check",prompt:"Send Rowan a short follow-up."}\n\ngot it, i\'ll buzz you in a couple minutes.',
      "quick_check",
    ],
    [
      'call:runtime_tool_0{delayMinutes:2,name:"quick check in",prompt:"Send Rowan a short follow-up."}\n\non it. see you in two.',
      "quick check in",
    ],
    [
      'call:runtime_tool_0{delayMinutes:2,name:"check_in",prompt:"Send Rowan a short follow-up."}\n\ngot you. i\'ll hit you up in a sec.',
      "check_in",
    ],
    [
      'call:runtime_tool_0{delayMinutes:2,name:"check_in",prompt:"Send Rowan a short follow-up."}\n\non it. i\'ll ping you in a sec.',
      "check_in",
    ],
    [
      'call:runtime_tool_0{delayMinutes:2,name:"greenhouse_check",prompt:"Send Rowan a short follow-up."}Got it. I\'ll ping you in fifteen.\n\nDon\'t let the fern droop.',
      "greenhouse_check",
    ],
    [
      'call:runtime_tool_0{delayMinutes:2,name:"greenhouse_check",prompt:"Send Rowan a short follow-up."}\n\nGot it. I\'ll make sure you don\'t forget the greenhouse check.',
      "greenhouse_check",
    ],
    [
      'call:runtime_tool_0{delayMinutes:2,name:"greenhouse_check",prompt:"Send Rowan a short follow-up."}\n\ndone. i\'ve got you covered.',
      "greenhouse_check",
    ],
    [
      'call:runtime_tool_0{delayMinutes:2,name:"greenhouse_check",prompt:"Send Rowan a short follow-up."}\n\ngot it, i\'ll remind you in fifteen.',
      "greenhouse_check",
    ],
    [
      'call:runtime_tool_0{delayMinutes:2,name:"greenhouse_check",prompt:"Send Rowan a short follow-up."}\n\ngot it. i\'ll tell you in fifteen.',
      "greenhouse_check",
    ],
    [
      'call:runtime_tool_0{delayMinutes:2,name:"greenhouse_check",prompt:"Send Rowan a short follow-up."}\n\ngot it, fifteen minutes. keep the synthetic fern happy.',
      "greenhouse_check",
    ],
    [
      'call:runtime_tool_0{delayMinutes:2,name:"greenhouse_check",prompt:"Send Rowan a short follow-up."}\n\ngot it. i\'ll make sure you don\'t forget that synthetic plant.',
      "greenhouse_check",
    ],
  ])(
    "recovers observed Gemma 4 textual tool protocol variants: %s",
    async (assistantMessage, name) => {
      const gateway = {
        chatCompletion: () =>
          Effect.succeed({
            assistantMessage,
            body: {},
            modelCallId: "model-call-1",
            route: {},
          } as never),
      } as unknown as ModelGatewayService;

      const result = await modelGatewayGenerationPort(gateway)(
        request({
          ...gemma4Route,
          tools: [describedRemindTool],
        }),
      );

      expect(result.assistantMessage).toBe("");
      expect(result.toolCalls).toEqual([
        {
          input: {
            delayMinutes: 2,
            name,
            prompt: "Send Rowan a short follow-up.",
          },
          modelToolCallId: expect.any(String),
          toolName: "agent.schedule.remind",
        },
      ]);
    },
  );

  it("recovers a complete validated Gemma 4 tool call before length-exhausted chatter", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage:
            "<|tool_call>_call:agent.schedule.remind{delayMinutes:2,name:quick_check_in,prompt:Send Rowan a short follow-up.}<tool_call|>on_success: got it. i'll text you in two.",
          body: {},
          finishReason: "length",
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        tools: [boundedRemindTool],
      }),
    );

    expect(result.assistantMessage).toBe("");
    expect(result.toolCalls).toEqual([
      {
        input: {
          delayMinutes: 2,
          name: "quick_check_in",
          prompt: "Send Rowan a short follow-up.",
        },
        modelToolCallId: expect.any(String),
        toolName: "agent.schedule.remind",
      },
    ]);
  });

  it("rejects an uncommitted textual tool call from a length-truncated turn", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage:
            "<|tool_call>_call:agent.schedule.remind{delayMinutes:2,name:quick_check_in,prompt:Send Rowan a short follow-up.}<tool_call|>\nthought\nI shouldn't send this after all",
          body: {},
          finishReason: "length",
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        tools: [boundedRemindTool],
      }),
    );

    expect(result.assistantMessage).toBe("");
    expect(result.toolCalls).toBeUndefined();
  });

  it("fails closed when Gemma 4 pairs an invalid structured call with an acknowledgment", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: "got it. i'll text you in two.",
          body: {},
          modelCallId: "model-call-1",
          route: {},
          toolCalls: [
            {
              arguments: { delayMinutes: 2 },
              id: "call_1",
              name: "runtime_tool_0",
            },
          ],
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        tools: [boundedRemindTool],
      }),
    );

    expect(result.assistantMessage).toBe("");
    expect(result.toolCalls).toBeUndefined();
  });

  it("fails closed when a length-truncated Gemma 4 response mixes structured and textual calls", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage:
            "_call:agent.schedule.remind{delayMinutes:2,name:quick_check_in,prompt:Send Rowan a short follow-up.}on_success: got it. i'll text you in two.",
          body: {},
          finishReason: "length",
          modelCallId: "model-call-1",
          route: {},
          toolCalls: [
            {
              arguments: { delayMinutes: 2 },
              id: "call_1",
              name: "runtime_tool_0",
            },
          ],
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        tools: [boundedRemindTool],
      }),
    );

    expect(result.assistantMessage).toBe("");
    expect(result.toolCalls).toBeUndefined();
  });

  it("rejects a second textual Gemma 4 tool call after an acknowledgment", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage:
            "_call:agent.schedule.remind{delayMinutes:2,name:first,prompt:First follow-up.}got it.\n" +
            "_call:agent.schedule.remind{delayMinutes:3,name:second,prompt:Second follow-up.}",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        tools: [remindTool],
      }),
    );

    expect(result.assistantMessage).toBe("");
    expect(result.toolCalls).toBeUndefined();
  });

  it("rejects a textual Gemma 4 tool call followed by cancellation prose", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage:
            "_call:agent.schedule.remind{delayMinutes:2,name:check_in,prompt:Send a follow-up.}sure. don't schedule that",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        tools: [remindTool],
      }),
    );

    expect(result.assistantMessage).toBe("");
    expect(result.toolCalls).toBeUndefined();
  });

  it("rejects a textual Gemma 4 tool call followed by a request to forget it", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage:
            "_call:agent.schedule.remind{delayMinutes:2,name:check_in,prompt:Send a follow-up.}got it. forget the reminder.",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        tools: [remindTool],
      }),
    );

    expect(result.toolCalls).toBeUndefined();
  });

  it.each([
    "<|tool_call>_call:agent.schedule.remind{delayMinutes:2,name:''}<tool_call|>",
    "_call:agent.schedule.remind{delayMinutes:2,reminderName:check_in,prompt:Check in with Rowan.}on it.",
  ])("fails closed on malformed live Gemma 4 tool input: %s", async (assistantMessage) => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage,
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        tools: [boundedRemindTool],
      }),
    );

    expect(result.assistantMessage).toBe("");
    expect(result.toolCalls).toBeUndefined();
  });

  it("recovers a Gemma 4 textual tool call before a colon-delimited thought block", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage:
            "call:runtime_tool_0{delayMinutes:2,name:quick_check_in,prompt:Send Rowan a short follow-up.}\nthought:\nprivate reasoning",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        tools: [describedRemindTool],
      }),
    );

    expect(result.assistantMessage).toBe("");
    expect(result.toolCalls).toEqual([
      {
        input: {
          delayMinutes: 2,
          name: "quick_check_in",
          prompt: "Send Rowan a short follow-up.",
        },
        modelToolCallId: expect.any(String),
        toolName: "agent.schedule.remind",
      },
    ]);
  });

  it("does not reissue an identical completed Gemma 4 write", async () => {
    const idempotencyKey = `${id("7")}:model-tool:0:0`;
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: "call:runtime_tool_0{resource:alpha}",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;
    const result = await modelGatewayGenerationPort(gateway)(
      request({
        completedToolCalls: [
          {
            effect: "write",
            idempotencyKey,
            input: { resource: "alpha" },
            inputSummary: "Update the synthetic resource.",
            outputSummary: "Updated the synthetic resource.",
            policyAction: "allow",
            policyReason: "Allowed.",
            requiredScopes: [],
            toolCallId: id("20"),
            toolName: "synthetic.update",
          },
        ],
        ...gemma4Route,
        modelToolCallSlots: [{ idempotencyKey, modelCallIndex: 0, toolCallIndex: 0 }],
        tools: [
          {
            effect: "write",
            inputSchema: {
              additionalProperties: false,
              properties: { resource: { type: "string" } },
              required: ["resource"],
              type: "object",
            },
            requiredScopes: [],
            toolName: "synthetic.update",
          },
        ],
      }),
    );

    expect(result.assistantMessage).toBe("got it");
    expect(result.toolCalls).toBeUndefined();
  });
});
