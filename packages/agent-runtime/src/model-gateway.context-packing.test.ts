import { describe, expect, it } from "bun:test";
import type {
  ModelGatewayChatCompletionRequest,
  ModelGatewayService,
} from "@deployments-ai/model-gateway";
import { Effect } from "effect";
import { modelGatewayGenerationPort, packRuntimeModelContext } from "./model-gateway.ts";
import { gemma4Route, id, request } from "./model-tool-context.fixture.ts";

const requiredContextTokens = packRuntimeModelContext(request(), {
  gemma4: false,
  modelToolDefinitions: [],
}).metrics.estimatedInputTokens;

describe("model gateway runtime adapter", () => {
  it("requires explicit budgets for model routes without authoritative limits", () => {
    const options = { gemma4: false, modelToolDefinitions: [] } as const;
    expect(() =>
      packRuntimeModelContext(request({ modelId: "openrouter/custom-model" }), options),
    ).toThrow("explicit modelInputTokenBudget and modelOutputTokenReserve");

    const packed = packRuntimeModelContext(
      request({
        modelId: "openrouter/custom-model",
        modelInputTokenBudget: 8_192,
        modelOutputTokenReserve: 512,
      }),
      options,
    );
    expect(packed.metrics).toMatchObject({
      contextWindowTokens: 8_704,
      inputTokenBudget: 8_192,
      outputTokenReserve: 512,
    });
  });

  it("packs an admitted non-curated model within its catalog window and forwards the catalog", async () => {
    const modelId = "openrouter/acme/long-context";
    const modelCatalog = {
      [modelId]: {
        contextWindowTokens: 262_144,
        maximumOutputTokens: 2_048,
        pricing: { inputUsdPerMillionTokens: 0.5, outputUsdPerMillionTokens: 1.5 },
      },
    };
    const packed = packRuntimeModelContext(request({ modelCatalog, modelId }), {
      gemma4: false,
      modelToolDefinitions: [],
    });
    expect(packed.metrics).toMatchObject({
      contextWindowTokens: 262_144,
      inputTokenBudget: 262_144 - 2_048,
      outputTokenReserve: 2_048,
    });

    let captured: ModelGatewayChatCompletionRequest | undefined;
    const gateway = {
      chatCompletion: (input: ModelGatewayChatCompletionRequest) => {
        captured = input;
        return Effect.succeed({ body: {}, modelCallId: "model-call-1", route: {} } as never);
      },
    } as unknown as ModelGatewayService;
    await modelGatewayGenerationPort(gateway)(request({ modelCatalog, modelId }));
    expect(captured).toMatchObject({ maxTokens: 2_048, modelCatalog, modelId });
  });

  it("does not require an absent continuation to fit in the initial tool-enabled request", () => {
    const packed = packRuntimeModelContext(
      request({
        modelId: "openrouter/custom-model",
        modelInputTokenBudget: requiredContextTokens + 768,
        modelOutputTokenReserve: 256,
        recentMessages: [{ content: "current conversation evidence", role: "user" }],
      }),
      {
        gemma4: false,
        modelToolDefinitions: [
          {
            function: {
              name: "runtime_tool_0",
              parameters: {
                additionalProperties: false,
                properties: { resource: { type: "string" } },
                required: ["resource"],
                type: "object",
              },
            },
            type: "function",
          },
        ],
      },
    );

    expect(packed.metrics.estimatedInputTokens).toBeLessThanOrEqual(requiredContextTokens + 768);
    expect(packed.modelToolsEnabled).toBe(true);
    expect(JSON.stringify(packed.messages)).toContain("current conversation evidence");
  });

  it("uses a compact truthful continuation when another model tool cannot be reserved", () => {
    const toolDefinition = {
      function: {
        name: "runtime_tool_0",
        parameters: {
          additionalProperties: false,
          properties: { payload: { type: "string" } },
          required: ["payload"],
          type: "object",
        },
      },
      type: "function",
    } as const;
    const packed = packRuntimeModelContext(
      request({
        completedToolCalls: [
          {
            effect: "write",
            idempotencyKey: `${id("7")}:model-tool:0:0`,
            input: { payload: "x".repeat(400) },
            inputSummary: `Send the payload ${"i".repeat(256)}`,
            outputSummary: `Provider accepted it ${"o".repeat(256)}`,
            policyAction: "allow",
            policyReason: "Allowed.",
            requiredScopes: [],
            toolCallId: id("20"),
            toolName: "provider.write",
          },
        ],
        ...gemma4Route,
        modelInputTokenBudget: requiredContextTokens + 768,
        modelOutputTokenReserve: 256,
        modelToolCallSlots: [
          {
            idempotencyKey: `${id("7")}:model-tool:0:0`,
            modelCallIndex: 0,
            toolCallIndex: 0,
          },
        ],
        prompt: "p".repeat(300),
      }),
      {
        gemma4: true,
        modelToolAliases: [{ name: "runtime_tool_0", toolName: "provider.write" }],
        modelToolDefinitions: [toolDefinition],
        modelToolProtocol: "MODEL TOOL WIRE PROTOCOL\ncall:runtime_tool_0{payload:<string>}",
      },
    );

    expect(packed.metrics.estimatedInputTokens).toBeLessThanOrEqual(requiredContextTokens + 768);
    expect(packed.modelToolsEnabled).toBe(false);
    expect(packed.messages.some((message) => message.tool_calls)).toBe(false);
    expect(JSON.stringify(packed.messages)).toContain("Provider accepted it");
    expect(JSON.stringify(packed.messages)).not.toContain("MODEL TOOL WIRE PROTOCOL");
  });

  it("keeps truncated multibyte context within every declared input budget", () => {
    const options = { gemma4: false, modelToolDefinitions: [] } as const;
    const baseline = packRuntimeModelContext(request(), options).metrics.estimatedInputTokens;
    for (
      let inputTokenBudget = baseline + 40;
      inputTokenBudget <= baseline + 80;
      inputTokenBudget += 1
    ) {
      const packed = packRuntimeModelContext(
        request({
          conversationCheckpoint: {
            fromSequence: 0,
            sourceMessageCount: 1,
            summary: "😀".repeat(1_000),
            throughSequence: 0,
          },
          modelInputTokenBudget: inputTokenBudget,
        }),
        options,
      );

      expect(packed.metrics.estimatedInputTokens).toBeLessThanOrEqual(inputTokenBudget);
      expect(JSON.stringify(packed.messages)).not.toContain("�");
    }
  });

  it("packs checkpoints and the newest history inside an explicit model input budget", async () => {
    let captured: ModelGatewayChatCompletionRequest | undefined;
    const gateway = {
      chatCompletion: (input: ModelGatewayChatCompletionRequest) => {
        captured = input;
        return Effect.succeed({
          assistantMessage: "Continuity retained.",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never);
      },
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        conversationCheckpoint: {
          fromSequence: 0,
          sourceMessageCount: 600,
          summary: "Rowan prefers teasing energy and has a job interview tomorrow.",
          throughMessageCharacterOffset: 12_000,
          throughSequence: 599,
        },
        historySelection: {
          availableMessages: 700,
          characterBudget: 65_536,
          selectedMessages: 100,
        },
        modelInputTokenBudget: requiredContextTokens + 768,
        recentMessages: Array.from({ length: 100 }, (_, index) => ({
          content: `history-${index}-${"x".repeat(80)}`,
          role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        })),
        runContext: "Current workflow state: continue the ongoing conversation naturally.",
      }),
    );

    const serialized = JSON.stringify(captured?.messages);
    expect(serialized).toContain("job interview tomorrow");
    expect(serialized).toContain("sequences 0-598 and the first 12000 characters of sequence 599");
    expect(serialized).toContain("Current workflow state");
    expect(serialized).toContain("history-99");
    expect(serialized).not.toContain("history-0-");
    expect(captured?.maxTokens).toBe(4_096);
    expect(result.metadata?.contextPacking).toMatchObject({
      checkpointIncluded: true,
      inputTokenBudget: requiredContextTokens + 768,
      recentMessagesAvailable: 700,
      runContextIncluded: true,
    });
    const contextPacking = result.metadata?.contextPacking as
      | { readonly recentMessagesDropped: number }
      | undefined;
    expect(contextPacking?.recentMessagesDropped).toBeGreaterThan(0);
  });

  it("reports a partially packed checkpoint as included and truncated", async () => {
    let captured: ModelGatewayChatCompletionRequest | undefined;
    const gateway = {
      chatCompletion: (input: ModelGatewayChatCompletionRequest) => {
        captured = input;
        return Effect.succeed({ body: {}, modelCallId: "model-call-1", route: {} } as never);
      },
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        conversationCheckpoint: {
          fromSequence: 0,
          sourceMessageCount: 100,
          summary: `checkpoint-start-${"x".repeat(2_000)}-checkpoint-end`,
          throughSequence: 99,
        },
        modelInputTokenBudget: requiredContextTokens + 768,
      }),
    );

    expect(JSON.stringify(captured?.messages)).toContain("checkpoint-start");
    expect(result.metadata?.contextPacking).toMatchObject({
      checkpointIncluded: true,
      optionalSectionsDropped: ["checkpoint"],
    });
  });

  it("rejects required run context that cannot fit before calling the provider", async () => {
    let calls = 0;
    const gateway = {
      chatCompletion: () => {
        calls += 1;
        return Effect.die("provider must not be called");
      },
    } as unknown as ModelGatewayService;

    expect(
      modelGatewayGenerationPort(gateway)(
        request({
          modelInputTokenBudget: requiredContextTokens + 768,
          runContext: "x".repeat(4_096),
        }),
      ),
    ).rejects.toThrow("Required model context");
    expect(calls).toBe(0);
  });
});
