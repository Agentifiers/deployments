import { describe, expect, test as it } from "bun:test";
import { Effect } from "effect";

import {
  ModelGateway,
  makeModelGateway,
  MODEL_GATEWAY_ENV_KEYS,
  type ModelGatewayCredentialRequest,
  modelGatewayRouteDefaultsFromEnv,
  modelGatewayRouteIdentity,
  modelGatewayLayer,
  modelUsageLedgerEntry,
  resolveModelRoute,
} from "./index.ts";

const TEST_RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";

describe("model gateway routing and configuration", () => {
  it("encodes every resolved route field in one canonical operator identity", () => {
    const route = resolveModelRoute({
      fallbackModelIds: [],
      modelId: "openai/text-embedding-3-small",
    });

    expect(modelGatewayRouteIdentity(route)).toBe(
      '{"bifrostModelId":"openai/text-embedding-3-small","fallbackModelIds":[],"modelId":"openai/text-embedding-3-small","provider":"openai","providerModelId":"text-embedding-3-small","requestedModelId":"openai/text-embedding-3-small","routeScopeRef":null}',
    );
  });

  it("keeps a pinned route when it still matches the resolved request", () => {
    const scope = { organizationId: "org_1" };
    const route = resolveModelRoute({
      fallbackModelIds: [],
      modelId: "openrouter/openai/text-embedding-3-small",
      scope,
    });

    expect(
      resolveModelRoute({
        fallbackModelIds: [],
        modelId: route.modelId,
        routeIdentity: modelGatewayRouteIdentity(route),
        scope,
      }),
    ).toEqual(route);
    expect(() =>
      resolveModelRoute({
        fallbackModelIds: [],
        modelId: route.modelId,
        routeIdentity: modelGatewayRouteIdentity(route),
        scope: { organizationId: "org_2" },
      }),
    ).toThrow("no longer matches");
  });

  it("asks credentials for the embedding model only and sends the bearer token", async () => {
    const requests: Request[] = [];
    const credentialRequests: ModelGatewayCredentialRequest[] = [];
    const fetchImpl = (async (input: string | Request | URL, init?: RequestInit) => {
      const request = new Request(input as string, init);
      requests.push(request);
      return Response.json({ data: [{ embedding: [1, 2, 3] }], usage: { total_tokens: 3 } });
    }) as unknown as typeof fetch;

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const gateway = yield* ModelGateway;
        return yield* gateway.embedding({
          dimensions: 3,
          fetch: fetchImpl,
          input: "deployment policy",
          modelCallId: "embedding_1",
          modelId: "openai/text-embedding-3-small",
          runId: TEST_RUN_ID,
          scope: { organizationId: "org_1" },
        });
      }).pipe(
        Effect.provide(
          modelGatewayLayer({
            baseUrl: "https://gateway.internal/v1",
            credentials: async (request) => {
              credentialRequests.push(request);
              return "embedding-token";
            },
            defaultFallbackModelIds: ["openai/gpt-5.2"],
          }),
        ),
      ),
    );

    expect(result?.embedding).toEqual([1, 2, 3]);
    expect(credentialRequests).toEqual([
      { modelIds: ["openai/text-embedding-3-small"], scope: { organizationId: "org_1" } },
    ]);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer embedding-token");
    expect(requests[0]?.headers.get("x-bf-vk")).toBeNull();
  });

  it("fails with a config error and sends nothing when credentials are unavailable", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return Response.json({ data: [{ embedding: [1, 2, 3] }] });
    }) as unknown as typeof fetch;
    const service = makeModelGateway({
      baseUrl: "https://gateway.internal/v1",
      credentials: async () => {
        throw new Error("issuer refused");
      },
    });

    expect(
      Effect.runPromise(
        service.embedding({
          dimensions: 3,
          fetch: fetchImpl,
          input: "deployment policy",
          modelCallId: "embedding_1",
          modelId: "openai/text-embedding-3-small",
          runId: TEST_RUN_ID,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "ModelGatewayConfigError",
      key: MODEL_GATEWAY_ENV_KEYS.tokenIssuer[0],
      message: expect.stringContaining("issuer refused"),
    });
    expect(fetchCalls).toBe(0);
  });

  it("rejects invalid embedding ledger ids before the provider request", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return Response.json({ data: [{ embedding: [1, 2, 3] }] });
    }) as unknown as typeof fetch;

    expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const gateway = yield* ModelGateway;
          return yield* gateway.embedding({
            dimensions: 3,
            fetch: fetchImpl,
            input: "deployment policy",
            modelCallId: " ",
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
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "ModelGatewayUsageError",
      message: expect.stringContaining("stable model call id"),
    });
    expect(fetchCalls).toBe(0);
  });

  it("keeps caller model identity separate from the provider response id", async () => {
    const service = makeModelGateway({
      credentials: async () => "gateway-token",
      baseUrl: "https://bifrost.internal",
    });
    const response = (id?: string) =>
      service.chatCompletion({
        fetch: (async () =>
          Response.json({
            choices: [{ finish_reason: "stop", message: { content: "done" } }],
            ...(id ? { id } : {}),
            model: "gpt-5.2",
            usage: { total_tokens: 3 },
          })) as unknown as typeof fetch,
        messages: [{ content: "complete the run", role: "user" }],
        modelCallId: "caller-stable-call",
        modelId: "openai/gpt-5.2",
        runId: TEST_RUN_ID,
      });

    const withProviderId = await Effect.runPromise(response("provider-response-1"));
    const withoutProviderId = await Effect.runPromise(response());

    expect(withProviderId.modelCallId).toBe("caller-stable-call");
    expect(withProviderId.providerRequestId).toBe("provider-response-1");
    expect(withoutProviderId.modelCallId).toBe("caller-stable-call");
    expect(withoutProviderId.providerRequestId).toBeUndefined();
  });

  it("returns malformed embedding usage through a typed error", async () => {
    const fetchImpl = (async () =>
      Response.json({
        data: [{ embedding: [1, 2] }],
        usage: { total_tokens: 9 },
      })) as unknown as typeof fetch;

    expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const gateway = yield* ModelGateway;
          return yield* gateway.embedding({
            dimensions: 3,
            fetch: fetchImpl,
            input: "deployment policy",
            modelCallId: "embedding_malformed",
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
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "ModelGatewayEmbeddingResponseError",
      usage: {
        idempotencyKey: expect.stringMatching(
          /^01ARZ3NDEKTSV4RRFFQ69G5FAY:model_tokens:bifrost:embedding_malformed:attempt:[0-9a-f-]{36}:openai\/text-embedding-3-small$/u,
        ),
        quantity: 9,
        runId: TEST_RUN_ID,
      },
    });
  });

  it("retains billable usage when rejecting an unauthorized served embedding model", async () => {
    const service = makeModelGateway({
      credentials: async () => "gateway-token",
      baseUrl: "https://bifrost.internal",
    });

    expect(
      Effect.runPromise(
        service.embedding({
          dimensions: 3,
          fetch: (async () =>
            Response.json({
              data: [{ embedding: [1, 2, 3] }],
              model: "o3",
              usage: { total_tokens: 9 },
            })) as unknown as typeof fetch,
          input: "deployment policy",
          modelCallId: "embedding_unauthorized_model",
          modelId: "openai/text-embedding-3-small",
          runId: TEST_RUN_ID,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "ModelGatewayEmbeddingResponseError",
      usage: {
        modelId: "openai/o3",
        quantity: 9,
        runId: TEST_RUN_ID,
      },
    });
  });

  it("normalizes model token usage and Bifrost cost metadata into one ledger row", () => {
    expect(
      modelUsageLedgerEntry({
        payer: { kind: "operator" },
        modelCallId: "call_1",
        modelId: "openrouter/qwen/qwen3.7-plus",
        occurredAt: "2026-07-10T12:59:59.900Z",
        provider: "openrouter",
        response: {
          body: {
            usage: {
              prompt_tokens: 12,
              completion_tokens: 8,
              cost_usd: "0.000045",
            },
          },
        },
        runId: TEST_RUN_ID,
      }),
    ).toEqual({
      costUsdMicros: 45,
      idempotencyKey:
        "01ARZ3NDEKTSV4RRFFQ69G5FAY:model_tokens:bifrost:call_1:openrouter/qwen/qwen3.7-plus",
      inputTokens: 12,
      modelId: "openrouter/qwen/qwen3.7-plus",
      occurredAt: "2026-07-10T12:59:59.900Z",
      outputTokens: 8,
      payer: { kind: "operator" },
      provider: "openrouter",
      quantity: 20,
      runId: TEST_RUN_ID,
      source: "bifrost:openrouter/qwen/qwen3.7-plus",
      type: "model_tokens",
      unit: "tokens",
    });
  });

  it("reads the deployment route defaults from the environment", () => {
    expect(
      modelGatewayRouteDefaultsFromEnv({
        DEPLOYMENTS_AI_DEFAULT_MODEL_FALLBACK_IDS: " openai/gpt-5.6-luna, ,openai/gpt-6-sol ",
        DEPLOYMENTS_AI_DEFAULT_MODEL_ID: " openai/gpt-6-luna ",
      }),
    ).toEqual({
      defaultFallbackModelIds: ["openai/gpt-5.6-luna", "openai/gpt-6-sol"],
      defaultModelId: "openai/gpt-6-luna",
    });
    expect(
      modelGatewayRouteDefaultsFromEnv({
        DEPLOYMENTS_AI_DEFAULT_MODEL_FALLBACK_IDS: " , ",
        DEPLOYMENTS_AI_DEFAULT_MODEL_ID: "",
      }),
    ).toEqual({});
  });
});
