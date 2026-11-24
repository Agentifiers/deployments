import { describe, expect, it } from "bun:test";
import type {
  ModelGatewayChatCompletionRequest,
  ModelGatewayService,
} from "@deployments-ai/model-gateway";
import { DEFAULT_AGENT_MODEL_ID } from "@deployments-ai/model-gateway";
import { Effect } from "effect";
import { modelGatewayGenerationPort } from "./model-gateway.ts";
import { gemma4Route, request } from "./model-tool-context.fixture.ts";

describe("model gateway runtime adapter", () => {
  it("reloads model routing credentials for every generation", async () => {
    let loads = 0;
    const loadGateway = async () => {
      loads += 1;
      return {
        chatCompletion: () =>
          Effect.succeed({
            assistantMessage: `loaded-${loads}`,
            body: {},
            modelCallId: "model-call-1",
            route: {},
          } as never),
      } as unknown as ModelGatewayService;
    };
    const generate = modelGatewayGenerationPort(loadGateway);

    expect((await generate(request())).assistantMessage).toBe("loaded-1");
    expect((await generate(request())).assistantMessage).toBe("loaded-2");
    expect(loads).toBe(2);
  });

  it("returns metered empty responses so runtime fallback can retain usage", async () => {
    const responseShape = {
      normalized: {
        choiceCount: 1,
        choiceShape: "record",
        contentCharacters: 0,
        contentPartCount: 0,
        contentShape: "null",
        messageShape: "record",
        reasoningCarrier: "reasoning-content",
        reasoningCharacters: 24,
        reasoningShape: "text",
        toolCallCount: 0,
        toolCallsShape: "missing",
      },
      rawResponseShape: "missing",
    } as const;
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          body: {},
          modelCallId: "model-call-1",
          modelId: "provider/resolved-model",
          responseShape,
          route: {},
          usage: {
            idempotencyKey: "model-call-1",
            occurredAt: 1,
            quantity: 7,
            source: "model-gateway",
            type: "model_tokens",
            unit: "tokens",
          },
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe("");
    expect(result.metadata?.responseInterpretation).toMatchObject({
      disposition: "provider-empty",
      gatewayResponseShape: responseShape,
    });
    expect(result.usage).toHaveLength(1);
  });

  it("rejects habitual Gemma laughter before publication while retaining metered usage", async () => {
    const rawReply = "that explains the missing label lol\n\ncheck the blue drawer.";
    const usage = {
      idempotencyKey: "model-call-1",
      occurredAt: 1,
      quantity: 23,
      source: "model-gateway",
      type: "model_tokens",
      unit: "tokens",
    };
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: rawReply,
          body: {},
          finishReason: "stop",
          inputTokens: 17,
          modelCallId: "model-call-1",
          modelId: gemma4Route.modelId,
          outputTokens: 6,
          providerRequestId: "provider-response-1",
          route: {},
          totalTokens: 23,
          usage,
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        recentMessages: [
          { content: "the box finally arrived lol", role: "assistant" },
          { content: "I put it on the shelf lol", role: "assistant" },
          { content: "the label fell off lol", role: "assistant" },
        ],
      }),
    );

    expect(result.assistantMessage).toBe("");
    expect(result.responseError).toBeDefined();
    expect(result.toolCalls).toBeUndefined();
    expect(result).toMatchObject({
      inputTokens: 17,
      outputTokens: 6,
      resolvedModelId: gemma4Route.modelId,
      totalTokens: 23,
      usage: [usage],
    });
    expect(result.metadata).toMatchObject({
      finishReason: "stop",
      modelCallId: "model-call-1",
      providerRequestId: "provider-response-1",
      responseInterpretation: {
        assistantCharacters: 0,
        disposition: "rejected-habitual-laughter-ending",
        providerAssistantCharacters: rawReply.length,
      },
    });
    expect(JSON.stringify(result)).not.toContain("that explains the missing label");
    expect(JSON.stringify(result)).not.toContain("the box finally arrived");
  });

  it("propagates provider response identity separately from the stable model call id", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: "Completed.",
          body: {},
          modelCallId: "model-call-1",
          providerRequestId: "provider-response-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request());

    expect(result.metadata).toMatchObject({
      modelCallId: "model-call-1",
      providerRequestId: "provider-response-1",
    });
  });

  it("keeps echoed platform timing labels out of chat replies", async () => {
    const leakedLabel =
      "[Platform timing: sent 1 hour, 42 minutes before the current turn. Treat momentary state in this message as belonging to that earlier time; do not repeat this label.]";
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: `${leakedLabel}\nmissed u. what are u up to?`,
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request());

    expect(result.assistantMessage).toBe("missed u. what are u up to?");
    expect(result.assistantMessage).not.toContain("Platform timing:");
  });

  it("never requests more output than the packed reserve", async () => {
    let captured: ModelGatewayChatCompletionRequest | undefined;
    const gateway = {
      chatCompletion: (input: ModelGatewayChatCompletionRequest) => {
        captured = input;
        return Effect.succeed({ body: {}, modelCallId: "model-call-1", route: {} } as never);
      },
    } as unknown as ModelGatewayService;

    await modelGatewayGenerationPort(gateway)(
      request({ modelId: DEFAULT_AGENT_MODEL_ID, modelOutputTokenReserve: 64 }),
    );

    expect(captured?.maxTokens).toBe(64);
  });

  it("keeps the Gemma 4 output cap typed while exposing native passthrough fields", async () => {
    let captured: ModelGatewayChatCompletionRequest | undefined;
    const gateway = {
      chatCompletion: (input: ModelGatewayChatCompletionRequest) => {
        captured = input;
        return Effect.succeed({ body: {}, modelCallId: "model-call-1", route: {} } as never);
      },
    } as unknown as ModelGatewayService;

    await modelGatewayGenerationPort(gateway)(
      request({ ...gemma4Route, modelOutputTokenReserve: 64 }),
    );

    expect(captured?.maxTokens).toBe(64);
    expect(captured?.additionalBody).toMatchObject({
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(captured?.additionalBody).not.toHaveProperty("extra_params");
  });

  it("clamps configured reserves to the selected model output limit", async () => {
    let captured: ModelGatewayChatCompletionRequest | undefined;
    const gateway = {
      chatCompletion: (input: ModelGatewayChatCompletionRequest) => {
        captured = input;
        return Effect.succeed({ body: {}, modelCallId: "model-call-1", route: {} } as never);
      },
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({ modelId: "openai/gpt-4o", modelOutputTokenReserve: 31_744 }),
    );

    expect(captured?.maxTokens).toBe(16_384);
    expect(result.metadata?.contextPacking).toMatchObject({ outputTokenReserve: 16_384 });
  });

  it("preserves an embedded no-initiation literal in Gemma 4 prose", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: "the literal token is [NO_INITIATION], babe",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe("the literal token is [NO_INITIATION], babe");
  });

  it("preserves an embedded no-initiation literal in textual tool arguments", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage:
            "call:runtime_tool_0{delayMinutes:2,name:literal,prompt:Send the literal [NO_INITIATION] token}",
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

    expect(result.toolCalls?.[0]?.input).toMatchObject({
      prompt: "Send the literal [NO_INITIATION] token",
    });
  });
});
