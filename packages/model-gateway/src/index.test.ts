import { describe, expect, test as it } from "bun:test";
import { Effect, Fiber } from "effect";

import {
  chatCompletionServedModelId,
  chatCompletionToolCalls,
  DEFAULT_AGENT_MODEL_ID,
  ModelGateway,
  modelGatewayLayer,
  modelGatewayRequestHeaders,
  normalizeModelId,
  normalizeOpenAiCompatibleBaseUrl,
  openAiCompatibleEmbeddingFromBody,
  openAiCompatibleEndpoint,
  providerModelIdForModelId,
  requestOpenAiCompatibleChatCompletion,
  requestOpenAiCompatibleEmbedding,
  resolveModelRoute,
} from "./index.ts";

const TEST_RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";

describe("model gateway", () => {
  it("normalizes OpenAI-compatible function tool calls", () => {
    expect(
      chatCompletionToolCalls({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    arguments: '{"resource":"account"}',
                    name: "runtime_tool_0",
                  },
                  id: "call_1",
                  type: "function",
                },
              ],
            },
          },
        ],
      }),
    ).toEqual([
      {
        arguments: { resource: "account" },
        id: "call_1",
        name: "runtime_tool_0",
      },
    ]);
    expect(() =>
      chatCompletionToolCalls({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: { arguments: "[]", name: "runtime_tool_0" },
                  id: "call_1",
                  type: "function",
                },
              ],
            },
          },
        ],
      }),
    ).toThrow("arguments must be a JSON object");
  });

  it("normalizes platform model ids to Bifrost provider-qualified ids", () => {
    expect(normalizeModelId("")).toBe(DEFAULT_AGENT_MODEL_ID);
    expect(normalizeModelId("gpt-5.2")).toBe("openai/gpt-5.2");
    expect(normalizeModelId("openai/gpt-4.1")).toBe("openai/gpt-4.1");
    expect(normalizeModelId("qwen/qwen3.7-plus")).toBe("openrouter/qwen/qwen3.7-plus");
    expect(normalizeModelId("openrouter/z-ai/glm-5.2")).toBe("openrouter/z-ai/glm-5.2");
    expect(normalizeModelId("anthropic/claude-sonnet-5")).toBe(
      "openrouter/anthropic/claude-sonnet-5",
    );
  });

  it("rejects explicit provider prefixes without a provider model id", () => {
    expect(() => normalizeModelId("openai")).toThrow("provider model id");
    expect(() => normalizeModelId("openrouter")).toThrow("provider model id");
    expect(() => normalizeModelId("openai/")).toThrow("missing the provider model id");
    expect(() => normalizeModelId("openrouter///")).toThrow("missing the provider model id");
    expect(() => normalizeModelId("openai/   ")).toThrow("missing the provider model id");
    expect(() => normalizeModelId("openai//gpt-5.2")).toThrow("missing the provider model id");
    expect(() => normalizeModelId("openrouter//anthropic/claude-sonnet-5")).toThrow(
      "missing the provider model id",
    );
    expect(() => normalizeModelId("openrouter/anthropic/   ")).toThrow(
      "missing the provider model id",
    );
  });

  it("rejects malformed fallback model ids before returning routes", () => {
    expect(() =>
      resolveModelRoute({
        fallbackModelIds: [" "],
        modelId: "gpt-5.2",
      }),
    ).toThrow("Fallback model id is required");
    expect(() =>
      resolveModelRoute({
        fallbackModelIds: ["openrouter/   "],
        modelId: "gpt-5.2",
      }),
    ).toThrow("provider model id");
  });

  it("resolves Bifrost routes with deduped fallback ids", () => {
    expect(
      resolveModelRoute({
        fallbackModelIds: ["openai/gpt-4.1", "gpt-4.1", "openrouter/z-ai/glm-5.2"],
        modelId: "openrouter/qwen/qwen3.7-plus",
      }),
    ).toEqual({
      bifrostModelId: "openrouter/qwen/qwen3.7-plus",
      fallbackModelIds: ["openai/gpt-4.1", "openrouter/z-ai/glm-5.2"],
      modelId: "openrouter/qwen/qwen3.7-plus",
      provider: "openrouter",
      providerModelId: "qwen/qwen3.7-plus",
      requestedModelId: "openrouter/qwen/qwen3.7-plus",
    });
  });

  it("records the request scope on the route", () => {
    expect(
      resolveModelRoute({
        modelId: "gpt-5.2",
        scope: {
          agentId: "agent_1",
          organizationId: "org_1",
          runId: TEST_RUN_ID,
          workspaceId: "workspace_1",
        },
      }),
    ).toMatchObject({
      routeScopeRef:
        "organization:org_1/workspace:workspace_1/agent:agent_1/run:01ARZ3NDEKTSV4RRFFQ69G5FAY",
    });
    expect(resolveModelRoute({ modelId: "gpt-5.2" })).not.toHaveProperty("routeScopeRef");
  });

  it("keeps provider model ids available for gateway diagnostics", () => {
    expect(providerModelIdForModelId("openrouter/xiaomi/mimo-v2.5")).toBe("xiaomi/mimo-v2.5");
    expect(providerModelIdForModelId("openai/gpt-5.2")).toBe("gpt-5.2");
  });

  it("normalizes provider-native top-level response model ids", () => {
    const route = resolveModelRoute({ modelId: "gpt-5.2" });

    expect(chatCompletionServedModelId({ model: "gpt-5.2" }, route)).toBe("openai/gpt-5.2");
  });

  it("preserves an OpenRouter route for provider-native top-level response model ids", () => {
    const route = resolveModelRoute({ modelId: "openrouter/openai/gpt-4o" });

    expect(chatCompletionServedModelId({ model: "openai/gpt-4o" }, route)).toBe(
      "openrouter/openai/gpt-4o",
    );
  });

  it("uses the top-level model when provider metadata identifies a fallback provider", () => {
    const route = resolveModelRoute({
      fallbackModelIds: ["openrouter/z-ai/glm-5.2"],
      modelId: "openrouter/qwen/qwen3.7-plus",
    });

    expect(
      chatCompletionServedModelId(
        {
          extra_fields: { provider: "openrouter" },
          model: "z-ai/glm-5.2",
        },
        route,
      ),
    ).toBe("openrouter/z-ai/glm-5.2");
  });

  it("normalizes gateway base URLs and sends only the bearer token", () => {
    expect(normalizeOpenAiCompatibleBaseUrl("https://bifrost.internal")).toBe(
      "https://bifrost.internal/v1",
    );
    expect(normalizeOpenAiCompatibleBaseUrl("https://bifrost.internal/v1/")).toBe(
      "https://bifrost.internal/v1",
    );
    expect(modelGatewayRequestHeaders("gateway-token")).toEqual({
      Authorization: "Bearer gateway-token",
      "Content-Type": "application/json",
      "x-bf-passthrough-extra-params": "true",
    });
  });

  it("builds OpenAI-compatible resource endpoints from versioned and unversioned bases", () => {
    expect(openAiCompatibleEndpoint("https://bifrost.internal", "embeddings")).toBe(
      "https://bifrost.internal/v1/embeddings",
    );
    expect(openAiCompatibleEndpoint("https://openrouter.ai/api/v1/", "/embeddings/")).toBe(
      "https://openrouter.ai/api/v1/embeddings",
    );
  });

  it("parses finite embedding vectors and usage from OpenAI-compatible responses", () => {
    const embedding = Array.from({ length: 3 }, (_, index) => index + 1);
    expect(
      openAiCompatibleEmbeddingFromBody({
        body: {
          data: [{ embedding }],
          usage: { total_tokens: 9 },
        },
        dimensions: 3,
      }),
    ).toEqual({
      embedding,
      usageTokens: 9,
    });
    expect(
      openAiCompatibleEmbeddingFromBody({
        body: {
          data: [{ embedding: [1, Number.NaN, 3] }],
          usage: { total_tokens: 9 },
        },
        dimensions: 3,
      }),
    ).toBeUndefined();
  });

  it("rejects coerced embedding components", () => {
    expect(
      openAiCompatibleEmbeddingFromBody({
        body: { data: [{ embedding: [0.1, null, true] }] },
        dimensions: 3,
      }),
    ).toBeUndefined();
  });

  it("executes OpenAI-compatible embedding requests through the gateway helper", async () => {
    const embedding = Array.from({ length: 3 }, (_, index) => index + 1);
    const requests: Request[] = [];
    const fetchImpl = (async (input: string | Request | URL, init?: RequestInit) => {
      const request = new Request(input as string, init);
      requests.push(request);
      return Response.json({
        data: [{ embedding }],
        usage: { total_tokens: 7 },
      });
    }) as unknown as typeof fetch;

    const result = await requestOpenAiCompatibleEmbedding({
      baseURL: "https://bifrost.internal",
      defaultHeaders: modelGatewayRequestHeaders("gateway-token"),
      dimensions: 3,
      fetch: fetchImpl,
      input: "deploy smoke-test policy",
      model: "openai/text-embedding-3-small",
    });

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe("https://bifrost.internal/v1/embeddings");
    expect(request.headers.get("authorization")).toBe("Bearer gateway-token");
    expect(request.headers.get("x-bf-vk")).toBeNull();
    expect(request.json()).resolves.toEqual({
      dimensions: 3,
      input: "deploy smoke-test policy",
      model: "openai/text-embedding-3-small",
    });
    expect(result).toEqual({
      body: {
        data: [{ embedding }],
        usage: { total_tokens: 7 },
      },
      embedding,
      usageTokens: 7,
    });
  });

  it("executes streamed OpenAI-compatible chat completions through the gateway helper", async () => {
    const requests: Request[] = [];
    const fetchImpl = (async (input: string | Request | URL, init?: RequestInit) => {
      const request = new Request(input as string, init);
      requests.push(request);
      return new Response(
        [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "do", role: "assistant" }, index: 0 }], id: "chatcmpl_1", model: "openai/gpt-5.2" })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: "ne" }, finish_reason: "stop", index: 0 }], id: "chatcmpl_1", model: "openai/gpt-5.2" })}`,
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const result = await requestOpenAiCompatibleChatCompletion({
      baseURL: "https://bifrost.internal",
      body: {
        messages: [{ content: "Summarize the run.", role: "user" }],
        model: "openai/gpt-5.2",
        stream: true,
      },
      defaultHeaders: modelGatewayRequestHeaders("gateway-token"),
      fetch: fetchImpl,
    });

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe("https://bifrost.internal/v1/chat/completions");
    expect(request.headers.get("authorization")).toBe("Bearer gateway-token");
    expect(request.headers.get("x-bf-vk")).toBeNull();
    expect(request.json()).resolves.toEqual({
      messages: [{ content: "Summarize the run.", role: "user" }],
      model: "openai/gpt-5.2",
      stream: true,
    });
    expect(result).toEqual({
      choices: [
        { finish_reason: "stop", index: 0, message: { content: "done", role: "assistant" } },
      ],
      id: "chatcmpl_1",
      model: "openai/gpt-5.2",
      object: "chat.completion",
    });
  });

  it("rejects raw provider error envelopes returned through Bifrost with HTTP success", async () => {
    expect(
      requestOpenAiCompatibleChatCompletion({
        baseURL: "https://bifrost.internal",
        body: {
          messages: [{ content: "hello", role: "user" }],
          model: "openrouter/test",
          stream: true,
        },
        defaultHeaders: {
          Authorization: "Bearer gateway-secret",
          "Content-Type": "application/json",
        },
        fetch: (async () =>
          Response.json({
            extra_fields: {
              raw_response: {
                error: {
                  code: "upstream_server_error",
                  message: "The model request failed upstream.",
                  type: "server_error",
                },
              },
            },
          })) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      _tag: "ModelGatewayRequestError",
      message: expect.stringContaining("upstream_server_error"),
    });
  });

  it("preserves bounded Bifrost rejection diagnostics", async () => {
    const result = await requestOpenAiCompatibleChatCompletion({
      baseURL: "https://bifrost.internal",
      body: {
        messages: [{ content: "hello", role: "user" }],
        model: "openrouter/test",
        stream: true,
      },
      defaultHeaders: {
        Authorization: "Bearer gateway-secret",
        "Content-Type": "application/json",
      },
      fetch: (async () =>
        Response.json(
          {
            error: { message: `Invalid request payload\n${"x".repeat(600)}` },
            status_code: 400,
            type: "invalid_request",
          },
          { status: 400 },
        )) as unknown as typeof fetch,
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    const providerMessage = (result as { readonly providerMessage: string }).providerMessage;

    expect(result).toMatchObject({
      _tag: "ModelGatewayRequestError",
      message: expect.stringContaining("Invalid request payload"),
      providerCode: "invalid_request",
      status: 400,
    });
    expect(providerMessage).toMatch(/^Invalid request payload x+$/u);
    expect(providerMessage).toHaveLength(512);
  });

  it("aborts embedding requests when the Effect fiber is interrupted", async () => {
    let resolveSignal!: (signal: AbortSignal) => void;
    const signalPromise = new Promise<AbortSignal>((resolve) => {
      resolveSignal = resolve;
    });
    const fetchImpl = (async (_input: string | Request | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Expected embedding fetch signal.");
      resolveSignal(signal);
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    const program = Effect.gen(function* () {
      const gateway = yield* ModelGateway;
      return yield* gateway.embedding({
        dimensions: 3,
        fetch: fetchImpl,
        input: "deployment policy",
        modelCallId: "embedding_1",
        modelId: "openai/text-embedding-3-small",
        runId: TEST_RUN_ID,
      });
    }).pipe(
      Effect.provide(
        modelGatewayLayer({
          credentials: async () => "gateway-token",
          baseUrl: "https://bifrost.internal",
        }),
      ),
    );

    const fiber = Effect.runFork(program);
    const signal = await signalPromise;
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(signal.aborted).toBe(true);
  });
});
