import { describe, expect, it } from "bun:test";
import type { ModelGatewayService, ModelGatewayToolCall } from "@deployments-ai/model-gateway";
import { DEFAULT_AGENT_MODEL_ID } from "@deployments-ai/model-gateway";
import type { Ulid } from "@deployments-ai/db";
import { Effect } from "effect";
import { modelGatewayGenerationPort } from "./model-gateway.ts";
import type { RuntimeModelGenerationRequest, RuntimeToolDefinition } from "./types.ts";

const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}` as Ulid;
const idempotencyKey = `${id("7")}:model-tool:0:0`;

function tool(effect: RuntimeToolDefinition["effect"]): RuntimeToolDefinition {
  return {
    effect,
    inputSchema: {
      additionalProperties: false,
      properties: { resource: { type: "string" } },
      required: ["resource"],
      type: "object",
    },
    requiredScopes: [],
    toolName: "synthetic.update",
  };
}

function request(effect: RuntimeToolDefinition["effect"]): RuntimeModelGenerationRequest {
  return {
    agentDefinitionId: id("1"),
    agentDeploymentId: id("2"),
    agentManifestHash: "sha256:test-manifest",
    agentReleaseId: id("3"),
    brainEvidence: [],
    captureMode: "metadata-only",
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
        toolName: "synthetic.update",
      },
    ],
    environmentId: id("4"),
    instructions: "Use the run evidence.",
    memories: [],
    modelCallId: "model-call-1",
    modelId: "openrouter/example/custom-gemma4",
    modelInputTokenBudget: 8_192,
    modelOutputTokenReserve: 512,
    modelToolProtocol: "gemma4",
    modelToolCallSlots: [{ idempotencyKey, modelCallIndex: 0, toolCallIndex: 0 }],
    organizationId: id("5"),
    projectId: id("6"),
    prompt: "Update the synthetic resource.",
    recentMessages: [],
    runId: id("7"),
    sandboxArtifacts: [],
    skills: [],
    spanId: "0123456789abcdef",
    threadId: id("8"),
    traceId: "0123456789abcdef0123456789abcdef",
    tools: [tool(effect)],
  } as RuntimeModelGenerationRequest;
}

async function generate(
  assistantMessage: string,
  effect: RuntimeToolDefinition["effect"],
  toolCalls?: readonly ModelGatewayToolCall[],
) {
  const gateway = {
    chatCompletion: () =>
      Effect.succeed({
        assistantMessage,
        body: {},
        modelCallId: "model-call-1",
        route: {},
        ...(toolCalls ? { toolCalls } : {}),
      } as never),
  } as unknown as ModelGatewayService;
  return modelGatewayGenerationPort(gateway)(request(effect));
}

describe("Gemma 4 completed tool continuation", () => {
  it.each([
    ["textual", "call:runtime_tool_0{resource:alpha}", undefined],
    [
      "structured",
      "",
      [{ arguments: { resource: "alpha" }, id: "provider-call-2", name: "runtime_tool_0" }],
    ],
  ] as const)("suppresses an exact repeated %s write", async (_kind, assistantMessage, calls) => {
    const result = await generate(assistantMessage, "write", calls);

    expect(result.assistantMessage).toBe("got it");
    expect(result.toolCalls).toBeUndefined();
  });

  it("acknowledges an empty post-write turn", async () => {
    const result = await generate("", "write");

    expect(result.assistantMessage).toBe("got it");
    expect(result.toolCalls).toBeUndefined();
  });

  it("fails closed on an empty post-read turn", async () => {
    const result = await generate("", "read");

    expect(result.assistantMessage).toBe("");
    expect(result.toolCalls).toBeUndefined();
  });

  it("preserves a different write request", async () => {
    const result = await generate("call:runtime_tool_0{resource:beta}", "write");

    expect(result.assistantMessage).toBe("");
    expect(result.toolCalls?.[0]?.input).toEqual({ resource: "beta" });
  });

  it("suppresses a repeated write while preserving a new structured request", async () => {
    const result = await generate("", "write", [
      { arguments: { resource: "alpha" }, id: "provider-call-2", name: "runtime_tool_0" },
      { arguments: { resource: "beta" }, id: "provider-call-3", name: "runtime_tool_0" },
    ]);

    expect(result.assistantMessage).toBe("");
    expect(result.toolCalls).toEqual([
      {
        input: { resource: "beta" },
        modelToolCallId: "provider-call-3",
        toolName: "synthetic.update",
      },
    ]);
  });

  it.each([
    ["suppresses a repeat of any write in the latest generation", 1, "got it", undefined],
    ["allows a repeat of a write from an earlier generation", 0, "", { resource: "alpha" }],
  ] as const)("%s", async (_name, earlierGeneration, message, expectedInput) => {
    const earlierKey = `${id("7")}:model-tool:${earlierGeneration}:0`;
    const latestToolCallIndex = earlierGeneration === 1 ? 1 : 0;
    const latestKey = `${id("7")}:model-tool:1:${latestToolCallIndex}`;
    const input = {
      ...request("write"),
      completedToolCalls: [
        {
          ...request("write").completedToolCalls[0]!,
          idempotencyKey: earlierKey,
          input: { resource: "alpha" },
        },
        {
          ...request("write").completedToolCalls[0]!,
          idempotencyKey: latestKey,
          input: { resource: "beta" },
          toolCallId: id("21"),
        },
      ],
      modelToolCallSlots: [
        { idempotencyKey: earlierKey, modelCallIndex: earlierGeneration, toolCallIndex: 0 },
        { idempotencyKey: latestKey, modelCallIndex: 1, toolCallIndex: latestToolCallIndex },
      ],
    };
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: "call:runtime_tool_0{resource:alpha}",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(input);

    expect(result.assistantMessage).toBe(message);
    expect(result.toolCalls?.[0]?.input).toEqual(expectedInput);
  });

  it("does not change empty continuation behavior for other model routes", async () => {
    const {
      modelInputTokenBudget: _inputBudget,
      modelOutputTokenReserve: _outputReserve,
      modelToolProtocol: _protocol,
      ...gemma4Input
    } = request("write");
    const input = { ...gemma4Input, modelId: DEFAULT_AGENT_MODEL_ID };
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: "",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;
    const result = await modelGatewayGenerationPort(gateway)(input);

    expect(result.assistantMessage).toBe("");
  });
});
