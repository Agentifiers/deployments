import { describe, expect, test as it } from "bun:test";
import { Effect } from "effect";

import {
  ModelGateway,
  makeModelGateway,
  modelGatewayLayer,
  modelUsageLedgerEntry,
} from "./index.ts";

const TEST_RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const TEST_OTHER_RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

describe("model gateway usage", () => {
  it("ignores invalid raw micros cost fields before falling back to USD cost metadata", () => {
    expect(
      modelUsageLedgerEntry({
        payer: { kind: "operator" },
        modelCallId: "call_1",
        modelId: "openrouter/qwen/qwen3.7-plus",
        provider: "openrouter",
        response: {
          body: {
            cost_usd_micros: 12.9,
            usage: {
              total_tokens: 20,
              cost_usd: "0.000045",
            },
          },
        },
        runId: TEST_RUN_ID,
      })?.costUsdMicros,
    ).toBe(45);
  });

  it("normalizes nested Bifrost usage cost objects", () => {
    expect(
      modelUsageLedgerEntry({
        payer: { kind: "operator" },
        modelCallId: "call_1",
        modelId: "openrouter/qwen/qwen3.7-plus",
        provider: "openrouter",
        response: {
          body: {
            usage: {
              cost: {
                request_cost: "0.000019",
                total_cost: "0.000021",
              },
              total_tokens: 20,
            },
          },
        },
        runId: TEST_RUN_ID,
      })?.costUsdMicros,
    ).toBe(21);
  });

  it.each([
    [
      "OpenRouter",
      { cache_write_tokens: 40, cached_tokens: 900 },
      { cachedInputTokens: 900, cacheWriteInputTokens: 40 },
    ],
    [
      "Bifrost",
      { cached_read_tokens: 700, cached_write_tokens: 30 },
      { cachedInputTokens: 700, cacheWriteInputTokens: 30 },
    ],
    ["invalid", { cache_write_tokens: 1.5, cached_tokens: -1 }, {}],
  ] as const)("parses %s prompt cache token details", (_shape, promptTokensDetails, expected) => {
    const entry = modelUsageLedgerEntry({
      payer: { kind: "operator" },
      modelCallId: "call_1",
      modelId: "openrouter/qwen/qwen3.7-plus",
      provider: "openrouter",
      response: {
        body: {
          usage: {
            completion_tokens: 10,
            prompt_tokens: 1_000,
            prompt_tokens_details: promptTokensDetails,
            total_tokens: 1_010,
          },
        },
      },
      runId: TEST_RUN_ID,
    });
    expect({
      cachedInputTokens: entry?.cachedInputTokens,
      cacheWriteInputTokens: entry?.cacheWriteInputTokens,
    }).toEqual({ cachedInputTokens: undefined, cacheWriteInputTokens: undefined, ...expected });
  });

  it("validates top-level cost micros before falling back to response cost metadata", () => {
    expect(
      modelUsageLedgerEntry({
        payer: { kind: "operator" },
        costUsdMicros: 12.9,
        modelCallId: "call_1",
        modelId: "openrouter/qwen/qwen3.7-plus",
        provider: "openrouter",
        response: {
          body: {
            usage: {
              total_tokens: 20,
              cost_usd: "0.000045",
            },
          },
        },
        runId: TEST_RUN_ID,
      })?.costUsdMicros,
    ).toBe(45);
  });

  it("ignores fractional token counts in gateway metadata", () => {
    expect(
      modelUsageLedgerEntry({
        payer: { kind: "operator" },
        modelCallId: "call_1",
        modelId: "openrouter/qwen/qwen3.7-plus",
        provider: "openrouter",
        response: {
          body: {
            usage: {
              prompt_tokens: 12.5,
              completion_tokens: 8,
            },
          },
        },
        runId: TEST_RUN_ID,
      }),
    ).toBeUndefined();
  });

  it("rejects token and cost values outside the safe-integer range", () => {
    expect(
      modelUsageLedgerEntry({
        payer: { kind: "operator" },
        modelCallId: "call_1",
        modelId: "openai/gpt-5.2",
        provider: "openai",
        response: { usage: { total_tokens: Number.MAX_SAFE_INTEGER + 1 } },
        runId: TEST_RUN_ID,
      }),
    ).toBeUndefined();
    expect(
      modelUsageLedgerEntry({
        payer: { kind: "operator" },
        modelCallId: "call_1",
        modelId: "openai/gpt-5.2",
        provider: "openai",
        response: { cost_usd: Number.MAX_VALUE, usage: { total_tokens: 20 } },
        runId: TEST_RUN_ID,
      }),
    ).not.toHaveProperty("costUsdMicros");
    expect(
      modelUsageLedgerEntry({
        payer: { kind: "operator" },
        modelCallId: "call_1",
        modelId: "openai/gpt-5.2",
        provider: "openai",
        runId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
      }),
    ).toBeUndefined();
  });

  it("returns no usage row when the gateway response has no token count", () => {
    expect(
      modelUsageLedgerEntry({
        payer: { kind: "operator" },
        modelCallId: "call_1",
        modelId: "openai/gpt-5.2",
        provider: "openai",
        response: {},
        runId: TEST_RUN_ID,
      }),
    ).toBeUndefined();
  });

  it("keeps retries idempotent without collapsing separate model calls", () => {
    const request = {
      payer: { kind: "operator" as const },
      modelId: "openai/gpt-5.2",
      provider: "openai" as const,
      runId: TEST_RUN_ID,
      usage: { totalTokens: 12 },
    };

    expect(modelUsageLedgerEntry({ ...request, modelCallId: "call_1" })?.idempotencyKey).toBe(
      "01ARZ3NDEKTSV4RRFFQ69G5FAY:model_tokens:bifrost:call_1:openai/gpt-5.2",
    );
    expect(modelUsageLedgerEntry({ ...request, modelCallId: "call_2" })?.idempotencyKey).toBe(
      "01ARZ3NDEKTSV4RRFFQ69G5FAY:model_tokens:bifrost:call_2:openai/gpt-5.2",
    );
  });

  it("requires a canonical run id before deriving ledger identity", () => {
    expect(() =>
      modelUsageLedgerEntry({
        payer: { kind: "operator" },
        modelCallId: "call_1",
        modelId: "openai/gpt-5.2",
        provider: "openai",
        runId: " ",
        usage: { totalTokens: 12 },
      }),
    ).toThrow("canonical ULID run id");

    expect(
      modelUsageLedgerEntry({
        payer: { kind: "operator" },
        modelCallId: "call_1",
        modelId: "openai/gpt-5.2",
        provider: "openai",
        runId: " 01ARZ3NDEKTSV4RRFFQ69G5FAY ",
        usage: { totalTokens: 12 },
      })?.idempotencyKey,
    ).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAY:model_tokens:bifrost:call_1:openai/gpt-5.2");
  });

  it("normalizes usage model ids before deriving ledger identity", () => {
    const aliasEntry = modelUsageLedgerEntry({
      payer: { kind: "operator" },
      modelCallId: "call_1",
      modelId: "gpt-5.2",
      provider: "openrouter",
      runId: TEST_RUN_ID,
      usage: { totalTokens: 12 },
    });
    const qualifiedEntry = modelUsageLedgerEntry({
      payer: { kind: "operator" },
      modelCallId: "call_1",
      modelId: "openai/gpt-5.2",
      provider: "openai",
      runId: TEST_RUN_ID,
      usage: { totalTokens: 12 },
    });

    expect(aliasEntry).toMatchObject({
      idempotencyKey: "01ARZ3NDEKTSV4RRFFQ69G5FAY:model_tokens:bifrost:call_1:openai/gpt-5.2",
      modelId: "openai/gpt-5.2",
      provider: "openai",
      source: "bifrost:openai/gpt-5.2",
    });
    expect(aliasEntry?.idempotencyKey).toBe(qualifiedEntry?.idempotencyKey);
  });

  it("fails closed when usage is missing a stable model call id", () => {
    expect(() =>
      modelUsageLedgerEntry({
        payer: { kind: "operator" },
        modelCallId: " ",
        modelId: "openai/gpt-5.2",
        provider: "openai",
        runId: TEST_RUN_ID,
        usage: { totalTokens: 12 },
      }),
    ).toThrow("stable model call id");
  });

  it("fails closed when usage is missing a stable model id", () => {
    expect(() =>
      modelUsageLedgerEntry({
        payer: { kind: "operator" },
        modelCallId: "call_1",
        modelId: " ",
        provider: "openai",
        runId: TEST_RUN_ID,
        usage: { totalTokens: 12 },
      }),
    ).toThrow("stable model id");
  });

  it("uses the caller-stable call id when the response omits an id", async () => {
    const fetchImpl = (async () =>
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "No id, no usage row." } }],
        model: "openai/gpt-5.2",
        usage: {
          completion_tokens: 3,
          prompt_tokens: 4,
          total_tokens: 7,
        },
      })) as unknown as typeof fetch;

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const gateway = yield* ModelGateway;
        return yield* gateway.chatCompletion({
          fetch: fetchImpl,
          messages: [{ content: "Summarize the run.", role: "user" }],
          modelCallId: "chat_call_1",
          modelId: "gpt-5.2",
          runId: TEST_RUN_ID,
        });
      }).pipe(
        Effect.provide(
          modelGatewayLayer({
            credentials: async () => "gateway-token",
            baseUrl: "https://bifrost.internal",
          }),
        ),
      ),
    );

    expect(result).toMatchObject({
      assistantMessage: "No id, no usage row.",
      inputTokens: 4,
      modelCallId: "chat_call_1",
      modelId: "openai/gpt-5.2",
      outputTokens: 3,
      totalTokens: 7,
      usage: {
        idempotencyKey: expect.stringMatching(
          /^01ARZ3NDEKTSV4RRFFQ69G5FAY:model_tokens:bifrost:chat_call_1:attempt:[0-9a-f-]{36}:openai\/gpt-5.2$/u,
        ),
        runId: TEST_RUN_ID,
      },
    });
  });

  it("rejects metered chat responses without valid usage metadata", async () => {
    const service = makeModelGateway({
      credentials: async () => "gateway-token",
      baseUrl: "https://bifrost.internal",
    });

    expect(
      Effect.runPromise(
        service.chatCompletion({
          fetch: (async () =>
            Response.json({
              choices: [{ finish_reason: "stop", message: { content: "done" } }],
              model: "gpt-5.2",
            })) as unknown as typeof fetch,
          messages: [{ content: "hello", role: "user" }],
          modelCallId: "metered_without_usage",
          modelId: "openai/gpt-5.2",
          runId: TEST_RUN_ID,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "ModelGatewayUsageError",
      message: "Metered chat responses require valid usage metadata.",
    });
  });

  it("rejects embedding responses without valid usage metadata", async () => {
    const service = makeModelGateway({
      credentials: async () => "gateway-token",
      baseUrl: "https://bifrost.internal",
    });

    expect(
      Effect.runPromise(
        service.embedding({
          dimensions: 3,
          fetch: (async () =>
            Response.json({ data: [{ embedding: [1, 2, 3] }] })) as unknown as typeof fetch,
          input: "hello",
          modelCallId: "embedding_without_usage",
          modelId: "openai/text-embedding-3-small",
          runId: TEST_RUN_ID,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "ModelGatewayUsageError",
      message: "Embedding responses require valid usage metadata.",
    });
  });

  it("records repeated provider dispatches under distinct usage attempt identities", async () => {
    const service = makeModelGateway({
      credentials: async () => "gateway-token",
      baseUrl: "https://bifrost.internal",
    });
    const request = {
      fetch: (async () =>
        Response.json({
          choices: [{ finish_reason: "stop", message: { content: "done" } }],
          model: "gpt-5.2",
          usage: { total_tokens: 7 },
        })) as unknown as typeof fetch,
      messages: [{ content: "hello", role: "user" }] as const,
      modelCallId: "logical_call",
      modelId: "openai/gpt-5.2",
      runId: TEST_RUN_ID,
    };

    const first = await Effect.runPromise(service.chatCompletion(request));
    const second = await Effect.runPromise(service.chatCompletion(request));

    expect(first.usage?.idempotencyKey).not.toBe(second.usage?.idempotencyKey);
    expect(first.usage?.idempotencyKey).toMatch(
      /^01ARZ3NDEKTSV4RRFFQ69G5FAY:model_tokens:bifrost:logical_call:attempt:[0-9a-f-]{36}:openai\/gpt-5.2$/u,
    );
    expect(second.usage?.idempotencyKey).toMatch(
      /^01ARZ3NDEKTSV4RRFFQ69G5FAY:model_tokens:bifrost:logical_call:attempt:[0-9a-f-]{36}:openai\/gpt-5.2$/u,
    );
  });

  it("rejects metered chat requests without a caller-stable call id", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return Response.json({
        choices: [{ message: { content: "should not run" } }],
        id: "chatcmpl_provider",
      });
    }) as unknown as typeof fetch;

    expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const gateway = yield* ModelGateway;
          return yield* gateway.chatCompletion({
            fetch: fetchImpl,
            messages: [{ content: "Summarize the run.", role: "user" }],
            modelId: "gpt-5.2",
            runId: TEST_RUN_ID,
          });
        }).pipe(
          Effect.provide(
            modelGatewayLayer({
              credentials: async () => "gateway-token",
              baseUrl: "https://bifrost.internal",
            }),
          ),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "ModelGatewayUsageError",
      message: expect.stringContaining("caller-stable model call id"),
    });
    expect(fetchCalls).toBe(0);
  });

  it("uses scope.runId for chat usage and rejects conflicting run ids", async () => {
    let fetchCalls = 0;
    const service = makeModelGateway({
      credentials: async () => "gateway-token",
      baseUrl: "https://bifrost.internal",
    });
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return Response.json({
        choices: [{ finish_reason: "stop", message: { content: "done" } }],
        model: "gpt-5.2",
        usage: { total_tokens: 7 },
      });
    }) as unknown as typeof fetch;

    const result = await Effect.runPromise(
      service.chatCompletion({
        fetch: fetchImpl,
        messages: [{ content: "hello", role: "user" }],
        modelCallId: "scope_call",
        modelId: "openai/gpt-5.2",
        scope: { organizationId: "org_1", runId: TEST_RUN_ID },
      }),
    );

    expect(result.usage?.runId).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAY");
    expect(
      Effect.runPromise(
        service.chatCompletion({
          fetch: fetchImpl,
          messages: [{ content: "hello", role: "user" }],
          modelCallId: "conflicting_call",
          modelId: "openai/gpt-5.2",
          runId: TEST_OTHER_RUN_ID,
          scope: { organizationId: "org_1", runId: TEST_RUN_ID },
        }),
      ),
    ).rejects.toMatchObject({ _tag: "ModelGatewayUsageError" });
    expect(fetchCalls).toBe(1);
  });

  it("uses scope.runId for embedding usage and rejects conflicting run ids", async () => {
    let fetchCalls = 0;
    const service = makeModelGateway({
      credentials: async () => "gateway-token",
      baseUrl: "https://bifrost.internal",
    });
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return Response.json({
        data: [{ embedding: [1, 2, 3] }],
        usage: { total_tokens: 3 },
      });
    }) as unknown as typeof fetch;

    const result = await Effect.runPromise(
      service.embedding({
        dimensions: 3,
        fetch: fetchImpl,
        input: "hello",
        modelCallId: "embedding_scope",
        modelId: "openai/text-embedding-3-small",
        runId: TEST_RUN_ID,
        scope: { organizationId: "org_1", runId: TEST_RUN_ID },
      }),
    );

    expect(result.usage?.runId).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAY");
    expect(
      Effect.runPromise(
        service.embedding({
          dimensions: 3,
          fetch: fetchImpl,
          input: "hello",
          modelCallId: "embedding_conflict",
          modelId: "openai/text-embedding-3-small",
          runId: TEST_OTHER_RUN_ID,
          scope: { organizationId: "org_1", runId: TEST_RUN_ID },
        }),
      ),
    ).rejects.toMatchObject({ _tag: "ModelGatewayUsageError" });
    expect(fetchCalls).toBe(1);
  });

  it("rejects usage identities beyond DynamoDB key limits before chat dispatch", async () => {
    let fetchCalls = 0;
    const service = makeModelGateway({
      credentials: async () => "gateway-token",
      baseUrl: "https://bifrost.internal",
    });

    expect(
      Effect.runPromise(
        service.chatCompletion({
          fetch: (async () => {
            fetchCalls += 1;
            return Response.json({});
          }) as unknown as typeof fetch,
          messages: [{ content: "hello", role: "user" }],
          modelCallId: "x".repeat(940),
          modelId: "openai/gpt-5.2",
          runId: TEST_RUN_ID,
        }),
      ),
    ).rejects.toMatchObject({ _tag: "ModelGatewayUsageError" });
    expect(fetchCalls).toBe(0);
  });
});
