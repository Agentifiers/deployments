import { afterEach, describe, expect, test as it, vi } from "bun:test";
import { Effect } from "effect";

import {
  makeModelGateway,
  ModelGateway,
  type ModelGatewayCredentialRequest,
  modelGatewayLayer,
} from "./index.ts";

const TEST_RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";

describe("model gateway Effect service", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("provides an Effect service for runtime code", async () => {
    const embedding = Array.from({ length: 3 }, (_, index) => index + 1);
    const requests: Request[] = [];
    const credentialRequests: ModelGatewayCredentialRequest[] = [];
    const fetchImpl = (async (input: string | Request | URL, init?: RequestInit) => {
      const request = new Request(input as string, init);
      requests.push(request);
      if (request.url.endsWith("/embeddings")) {
        return Response.json({
          data: [{ embedding }],
          usage: { total_tokens: 11 },
        });
      }

      const chunks = [
        {
          choices: [{ delta: { content: "Deployment ", role: "assistant" }, index: 0 }],
          extra_fields: {
            routing_info: { resolved_model: { model: "gpt-5.2", provider: "openai" } },
          },
          id: "chatcmpl_1",
        },
        {
          choices: [{ delta: { content: "finished." }, finish_reason: "stop", index: 0 }],
          id: "chatcmpl_1",
        },
        {
          choices: [],
          id: "chatcmpl_1",
          usage: { completion_tokens: 8, prompt_tokens: 12, total_tokens: 20 },
        },
      ];
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream; charset=utf-8" } },
      );
    }) as unknown as typeof fetch;

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const gateway = yield* ModelGateway;
        const route = yield* gateway.resolveRoute({ modelId: "qwen/qwen3.7-plus" });
        const chatCompletion = yield* gateway.chatCompletion({
          fallbackModelIds: ["openrouter/z-ai/glm-5.2"],
          fetch: fetchImpl,
          maxTokens: 250,
          messages: [{ content: "Summarize the run.", role: "user" }],
          modelCallId: "chat_call_1",
          modelId: "gpt-5.2",
          runId: TEST_RUN_ID,
        });
        const embeddingResult = yield* gateway.embedding({
          dimensions: 3,
          fetch: fetchImpl,
          input: "deploy smoke-test policy",
          modelCallId: "embedding_1",
          modelId: "openai/text-embedding-3-small",
          runId: TEST_RUN_ID,
        });

        return {
          chatCompletion,
          embeddingResult,
          route,
        };
      }).pipe(
        Effect.provide(
          modelGatewayLayer({
            baseUrl: "https://gateway.internal",
            credentials: async (request) => {
              credentialRequests.push(request);
              return `token-${credentialRequests.length}`;
            },
          }),
        ),
      ),
    );

    expect(result).toMatchObject({
      chatCompletion: {
        assistantMessage: "Deployment finished.",
        finishReason: "stop",
        inputTokens: 12,
        modelCallId: "chat_call_1",
        modelId: "openai/gpt-5.2",
        outputTokens: 8,
        route: {
          bifrostModelId: "openai/gpt-5.2",
          fallbackModelIds: ["openrouter/z-ai/glm-5.2"],
          provider: "openai",
        },
        servedProvider: "openai",
        responseShape: {
          normalized: {
            choiceCount: 1,
            choiceShape: "record",
            contentCharacters: "Deployment finished.".length,
            contentPartCount: 0,
            contentShape: "text",
            messageShape: "record",
            reasoningCarrier: "missing",
            reasoningCharacters: 0,
            reasoningShape: "missing",
            toolCallCount: 0,
            toolCallsShape: "missing",
          },
          rawResponseShape: "missing",
        },
        totalTokens: 20,
        usage: {
          idempotencyKey: expect.stringContaining(
            "01ARZ3NDEKTSV4RRFFQ69G5FAY:model_tokens:bifrost:chat_call_1:attempt:",
          ),
          quantity: 20,
          runId: TEST_RUN_ID,
        },
      },
      embeddingResult: {
        embedding,
        modelId: "openai/text-embedding-3-small",
        provider: "openai",
        usage: {
          idempotencyKey: expect.stringContaining(
            "01ARZ3NDEKTSV4RRFFQ69G5FAY:model_tokens:bifrost:embedding_1:attempt:",
          ),
          quantity: 11,
        },
        usageTokens: 11,
      },
      route: {
        bifrostModelId: "openrouter/qwen/qwen3.7-plus",
        provider: "openrouter",
        providerModelId: "qwen/qwen3.7-plus",
      },
    });
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.url)).toEqual([
      "https://gateway.internal/v1/chat/completions",
      "https://gateway.internal/v1/embeddings",
    ]);
    expect(credentialRequests).toEqual([
      { modelIds: ["openai/gpt-5.2", "openrouter/z-ai/glm-5.2"] },
      { modelIds: ["openai/text-embedding-3-small"] },
    ]);
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer token-1",
      "Bearer token-2",
    ]);
    expect(requests[0]!.json()).resolves.toMatchObject({
      fallbacks: ["openrouter/z-ai/glm-5.2"],
      max_tokens: 250,
      messages: [{ content: "Summarize the run.", role: "user" }],
      model: "openai/gpt-5.2",
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("pins embedding calls to the exact pre-resolved fallback route", async () => {
    const requests: Request[] = [];
    const fetchImpl = (async (input: string | Request | URL, init?: RequestInit) => {
      requests.push(new Request(input as string, init));
      return Response.json({
        data: [{ embedding: [1, 0, 0] }],
        model: "text-embedding-3-large",
        usage: { total_tokens: 3 },
      });
    }) as unknown as typeof fetch;
    const credentialRequests: ModelGatewayCredentialRequest[] = [];
    const gateway = makeModelGateway({
      baseUrl: "https://gateway.internal",
      credentials: async (request) => {
        credentialRequests.push(request);
        return "memory-token";
      },
      defaultFallbackModelIds: ["openrouter/z-ai/glm-5.2"],
    });
    const scope = { organizationId: "org_1" };
    const fallbackModelIds = ["openai/text-embedding-3-large"];
    const route = await Effect.runPromise(
      gateway.resolveRoute({
        fallbackModelIds,
        modelId: "openai/text-embedding-3-small",
        scope,
      }),
    );

    expect(route).toMatchObject({ fallbackModelIds, routeScopeRef: "organization:org_1" });
    expect(
      Effect.runPromise(
        gateway.embedding({
          dimensions: 3,
          fallbackModelIds,
          fetch: fetchImpl,
          input: "memory route check",
          modelCallId: "embedding_pinned_1",
          modelId: route.modelId,
          resolvedRoute: route,
          runId: TEST_RUN_ID,
          scope,
        }),
      ),
    ).resolves.toMatchObject({
      embedding: [1, 0, 0],
      modelId: "openai/text-embedding-3-large",
      provider: "openai",
      usage: { modelId: "openai/text-embedding-3-large" },
    });
    expect(requests[0]!.json()).resolves.toMatchObject({
      fallbacks: ["openai/text-embedding-3-large"],
      model: "openai/text-embedding-3-small",
    });
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer memory-token");
    expect(credentialRequests).toEqual([
      {
        modelIds: ["openai/text-embedding-3-small", "openai/text-embedding-3-large"],
        scope,
      },
    ]);

    expect(
      Effect.runPromise(
        gateway.embedding({
          dimensions: 3,
          fallbackModelIds,
          fetch: fetchImpl,
          input: "memory route check",
          modelCallId: "embedding_pinned_2",
          modelId: route.modelId,
          resolvedRoute: { ...route, routeScopeRef: "organization:other" },
          runId: TEST_RUN_ID,
          scope,
        }),
      ),
    ).rejects.toThrow("pinned embedding route");
    expect(requests).toHaveLength(1);
  });

  it("bounds only the provider request by the provider signal", async () => {
    vi.useFakeTimers();
    const gateway = makeModelGateway({
      baseUrl: "https://gateway.internal",
      credentials: async () => {
        vi.advanceTimersByTime(200);
        return "memory-token";
      },
    });
    const providerLatenciesMs = [20, 300];
    const request = {
      dimensions: 3,
      fetch: (async (_input: string | Request | URL, init?: RequestInit) => {
        vi.advanceTimersByTime(providerLatenciesMs.shift() ?? 0);
        init?.signal?.throwIfAborted();
        return Response.json({ data: [{ embedding: [1, 0, 0] }], usage: { total_tokens: 3 } });
      }) as unknown as typeof fetch,
      input: "memory query",
      modelCallId: "embedding_provider_deadline",
      modelId: "openai/text-embedding-3-small",
      providerSignal: () => AbortSignal.timeout(120),
      runId: TEST_RUN_ID,
    };

    expect(Effect.runPromise(gateway.embedding(request))).resolves.toMatchObject({
      embedding: [1, 0, 0],
    });
    expect(Effect.runPromise(gateway.embedding(request))).rejects.toMatchObject({
      _tag: "ModelGatewayRequestError",
      message: "The operation timed out.",
    });
  });
});
