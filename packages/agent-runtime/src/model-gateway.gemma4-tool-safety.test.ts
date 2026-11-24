import { describe, expect, it } from "bun:test";
import type { ModelGatewayService } from "@deployments-ai/model-gateway";
import { DEFAULT_AGENT_MODEL_ID } from "@deployments-ai/model-gateway";
import type { Ulid } from "@deployments-ai/db";
import { Effect } from "effect";
import { modelGatewayGenerationPort } from "./model-gateway.ts";
import type { RuntimeModelGenerationRequest } from "./types.ts";

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

describe("Gemma 4 textual tool safety", () => {
  it("rejects a textual tool call before an unmarked repeated thought suffix", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage:
            "call:runtime_tool_0{}\nthought wait here\nthought wait here\nthought wait here\n2h",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        tools: [
          {
            effect: "write",
            inputSchema: { additionalProperties: false, properties: {}, type: "object" },
            requiredScopes: ["schedules:write"],
            toolName: "agent.schedule.remind",
          },
        ],
      }),
    );

    expect(result.toolCalls).toBeUndefined();
  });

  it("rejects a textual tool call when prose precedes a repeated thought suffix", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage:
            "call:runtime_tool_0{}\nnever mind\nthought wait here\nthought wait here\nthought wait here\n2h",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        tools: [
          {
            effect: "write",
            inputSchema: { additionalProperties: false, properties: {}, type: "object" },
            requiredScopes: ["schedules:write"],
            toolName: "agent.schedule.remind",
          },
        ],
      }),
    );

    expect(result.toolCalls).toBeUndefined();
  });

  it("rejects a textual tool call when distinct prose follows a repeated thought suffix", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: `call:runtime_tool_0{}\n${"thought wait here until the malformed generation is definitely exhausted\n".repeat(10)}thought actually don't schedule it`,
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        tools: [
          {
            effect: "write",
            inputSchema: { additionalProperties: false, properties: {}, type: "object" },
            requiredScopes: ["schedules:write"],
            toolName: "agent.schedule.remind",
          },
        ],
      }),
    );

    expect(result.toolCalls).toBeUndefined();
  });

  it.each([
    "call:runtime_tool_0{}\nI'm unable to schedule this.",
    "call:runtime_tool_0{}\nThe operation failed.",
    "call:runtime_tool_0{}\nGot it. The operation failed.",
    "call:runtime_tool_0{}\nGot it. I need more information first.",
    "call:runtime_tool_0{}\nGot it. Maybe I'll schedule it.",
    "call:runtime_tool_0{}\nGot it. I didn't schedule it.",
    "call:runtime_tool_0{}\nGot it. I refuse to schedule it.",
    "call:runtime_tool_0{}\nGot it?",
  ])("rejects a complete write call followed by failure prose: %s", async (assistantMessage) => {
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
        tools: [
          {
            effect: "write",
            inputSchema: { additionalProperties: false, properties: {}, type: "object" },
            requiredScopes: ["schedules:write"],
            toolName: "agent.schedule.remind",
          },
        ],
      }),
    );

    expect(result.toolCalls).toBeUndefined();
  });

  it.each([
    "[NO_INITIATION]\ncall:runtime_tool_0{delayMinutes:2,name:quick_check_in,prompt:Send Rowan a short follow-up.}",
    "call:runtime_tool_0{delayMinutes:2,name:quick_check_in,prompt:Send Rowan a short follow-up.}\n[NO_INITIATION]",
  ])(
    "normalizes heartbeat control markers before recovering a textual tool call",
    async (assistantMessage) => {
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
          tools: [
            {
              effect: "write",
              inputSchema: {
                additionalProperties: false,
                properties: {
                  delayMinutes: { type: "integer" },
                  name: { type: "string" },
                  prompt: { type: "string" },
                },
                type: "object",
              },
              requiredScopes: ["schedules:write"],
              toolName: "agent.schedule.remind",
            },
          ],
        }),
      );

      expect(result.assistantMessage).toBe("");
      expect(result.toolCalls?.[0]).toMatchObject({
        input: { delayMinutes: 2, name: "quick_check_in" },
        toolName: "agent.schedule.remind",
      });
    },
  );

  it("preserves punctuation inside Gemma 4 textual tool string arguments", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage:
            "call:runtime_tool_0{delayMinutes:2,name:quick_check_in,prompt:At 3, say: hello}",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        tools: [
          {
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
        ],
      }),
    );

    expect(result.toolCalls?.[0]?.input).toEqual({
      delayMinutes: 2,
      name: "quick_check_in",
      prompt: "At 3, say: hello",
    });
  });

  it("keeps numeric-looking Gemma 4 values as strings when the schema requires strings", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: "call:runtime_tool_0{title:123,prompt:true,value:null}",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        tools: [
          {
            effect: "write",
            inputSchema: {
              additionalProperties: false,
              properties: {
                prompt: { type: "string" },
                title: { type: "string" },
                value: { type: "string" },
              },
              type: "object",
            },
            requiredScopes: ["schedules:write"],
            toolName: "agent.schedule.remind",
          },
        ],
      }),
    );

    expect(result.toolCalls?.[0]?.input).toEqual({
      prompt: "true",
      title: "123",
      value: "null",
    });
  });

  it("suppresses a truncated Gemma 4 textual tool envelope", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: "call:runtime_tool_0{delayMinutes:2,prompt:this was truncated",
          body: {},
          finishReason: "length",
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        tools: [
          {
            effect: "write",
            inputSchema: {
              additionalProperties: false,
              properties: {
                delayMinutes: { type: "integer" },
                prompt: { type: "string" },
              },
              type: "object",
            },
            requiredScopes: ["schedules:write"],
            toolName: "agent.schedule.remind",
          },
        ],
      }),
    );

    expect(result.assistantMessage).toBe("");
    expect(result.toolCalls).toBeUndefined();
  });

  it.each(["call:", "call:runtime_tool_0", "<|tool_call>call:runtime_tool_0"])(
    "suppresses a Gemma 4 tool prefix truncated before its arguments: %s",
    async (assistantMessage) => {
      const gateway = {
        chatCompletion: () =>
          Effect.succeed({
            assistantMessage,
            body: {},
            finishReason: "length",
            modelCallId: "model-call-1",
            route: {},
          } as never),
      } as unknown as ModelGatewayService;

      const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

      expect(result.assistantMessage).toBe("");
    },
  );

  it.each([
    ["<thought>private reasoning</thought>visible reply", "visible reply"],
    ["<thought>private reasoning without a closing stop", ""],
  ])("removes an XML Gemma 4 thought envelope", async (assistantMessage, expected) => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage,
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe(expected);
  });

  it("recovers compact JSON-style Gemma 4 textual tool arguments", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage:
            'call:runtime_tool_0{"delayMinutes":2,"name":"quick-check","prompt":"say hi"}',
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        tools: [
          {
            effect: "write",
            inputSchema: {
              additionalProperties: false,
              properties: {
                delayMinutes: { type: "integer" },
                name: { type: "string" },
                prompt: { type: "string" },
              },
              type: "object",
            },
            requiredScopes: ["schedules:write"],
            toolName: "agent.schedule.remind",
          },
        ],
      }),
    );

    expect(result.toolCalls?.[0]?.input).toEqual({
      delayMinutes: 2,
      name: "quick-check",
      prompt: "say hi",
    });
  });

  it.each([
    { additionalProperties: true, type: "object" },
    { additionalProperties: false, patternProperties: { ".*": {} }, type: "object" },
    {
      additionalProperties: false,
      properties: {
        viewportSize: {
          additionalProperties: false,
          properties: { height: { type: "integer" }, width: { type: "integer" } },
          type: "object",
        },
      },
      type: "object",
    },
    { additionalProperties: false, properties: { payload: {} }, type: "object" },
    {
      additionalProperties: false,
      properties: { payload: { $ref: "#/$defs/payload" } },
      type: "object",
    },
    {
      additionalProperties: false,
      properties: { identifier: { anyOf: [{ type: "string" }, { type: "null" }] } },
      type: "object",
    },
    {
      additionalProperties: false,
      properties: { identifier: { type: ["string", "number"] } },
      type: "object",
    },
  ])(
    "rejects Gemma 4 tools whose textual syntax cannot be recovered safely",
    async (inputSchema) => {
      const gateway = {
        chatCompletion: () => {
          throw new Error("Gateway must not be called.");
        },
      } as unknown as ModelGatewayService;

      expect(
        modelGatewayGenerationPort(gateway)(
          request({
            ...gemma4Route,
            tools: [
              {
                effect: "write",
                inputSchema,
                requiredScopes: ["schedules:write"],
                toolName: "agent.schedule.remind",
              },
            ],
          }),
        ),
      ).rejects.toThrow("requires a closed object schema with explicit scalar properties");
    },
  );

  it.each([
    ["done. call:runtime_tool_0{delayMinutes:2,name:x,prompt:y}", "done."],
    ["done! _call:runtime_tool_0{delayMinutes:2,name:x,prompt:y}", "done!"],
    ["done; <|tool_call>call:runtime_tool_0{}<tool_call|>", "done;"],
    ["done.\nthought\ncall:runtime_tool_0{delayMinutes:2,name:x,prompt:y}", "done."],
  ])(
    "does not execute a Gemma 4 textual tool call embedded in prose or thought: %s",
    async (assistantMessage, expectedMessage) => {
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
          tools: [
            {
              effect: "write",
              inputSchema: { additionalProperties: false, properties: {}, type: "object" },
              requiredScopes: ["schedules:write"],
              toolName: "agent.schedule.remind",
            },
          ],
        }),
      );

      expect(result.toolCalls).toBeUndefined();
      expect(result.assistantMessage).toBe(expectedMessage);
    },
  );

  it("preserves ordinary colon-delimited call prose", async () => {
    const assistantMessage = "give the office a call: tomorrow works.";
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage,
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe(assistantMessage);
  });

  it("recovers an empty Gemma 4 textual tool argument object", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: "call:runtime_tool_0{}",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        tools: [
          {
            effect: "read",
            inputSchema: { additionalProperties: false, properties: {}, type: "object" },
            requiredScopes: [],
            toolName: "provider.status",
          },
        ],
      }),
    );

    expect(result.toolCalls).toEqual([
      {
        input: {},
        modelToolCallId: expect.any(String),
        toolName: "provider.status",
      },
    ]);
  });

  it("does not execute a Gemma 4 tool call after a leading thought envelope", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: "<|channel>thought\nprivate reasoning<channel|>call:runtime_tool_0{}",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        tools: [
          {
            effect: "write",
            inputSchema: { additionalProperties: false, properties: {}, type: "object" },
            requiredScopes: ["schedules:write"],
            toolName: "agent.schedule.remind",
          },
        ],
      }),
    );

    expect(result.toolCalls).toBeUndefined();
    expect(result.assistantMessage).toBe("");
  });
});
