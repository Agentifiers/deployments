import { describe, expect, test as it } from "bun:test";
import {
  requestOpenAiCompatibleChatCompletion,
  requestOpenAiCompatibleEmbedding,
} from "./index.ts";

const successBody = {
  choices: [{ finish_reason: "stop", message: { content: "done" } }],
  id: "chatcmpl_1",
  model: "openrouter/qwen/qwen3.7-plus",
  usage: { completion_tokens: 1, prompt_tokens: 2, total_tokens: 3 },
};

const rateLimitedBody = {
  error: { code: "429", message: "Provider returned error" },
};

function scriptedFetch(responses: readonly (() => Response)[]) {
  let calls = 0;
  const fetchImpl = (async () => {
    const next = responses[Math.min(calls, responses.length - 1)]!;
    calls += 1;
    return next();
  }) as unknown as typeof fetch;
  return { calls: () => calls, fetchImpl };
}

function recordingSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (delayMs: number) => {
      delays.push(delayMs);
    },
  };
}

function chatCompletion(
  fetchImpl: typeof fetch,
  options: { readonly signal?: AbortSignal; readonly sleep?: (delayMs: number) => Promise<void> },
) {
  return requestOpenAiCompatibleChatCompletion({
    baseURL: "https://bifrost.internal",
    body: {
      fallbacks: ["openai/gpt-5.2"],
      messages: [{ content: "hello", role: "user" }],
      model: "openrouter/qwen/qwen3.7-plus",
      stream: true,
    },
    defaultHeaders: { "Content-Type": "application/json" },
    errorContext: "Model gateway chat completion",
    fetch: fetchImpl,
    ...options,
  });
}

describe("provider retry for OpenAI-compatible requests", () => {
  it("retries an upstream 429 with jittered backoff and returns the success body", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      () => Response.json(rateLimitedBody, { status: 429 }),
      () => Response.json(successBody),
    ]);
    const { delays, sleep } = recordingSleep();

    expect(chatCompletion(fetchImpl, { sleep })).resolves.toEqual(successBody);
    expect(calls()).toBe(2);
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(500);
    expect(delays[0]).toBeLessThanOrEqual(1_000);
  });

  it("resends the identical body, including in-body fallbacks, on each attempt", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_input: string, init: RequestInit) => {
      bodies.push(init.body as string);
      return bodies.length === 1
        ? Response.json(rateLimitedBody, { status: 503 })
        : Response.json(successBody);
    }) as unknown as typeof fetch;

    await chatCompletion(fetchImpl, recordingSleep());
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]!);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ fallbacks: ["openai/gpt-5.2"] });
  });

  it("honors Retry-After seconds and HTTP-dates, capped at ten seconds", async () => {
    const retryAt = new Date(Date.now() + 4_000).toUTCString();
    const { fetchImpl } = scriptedFetch([
      () => Response.json(rateLimitedBody, { headers: { "retry-after": "3" }, status: 429 }),
      () => Response.json(rateLimitedBody, { headers: { "retry-after": retryAt }, status: 429 }),
      () => Response.json(rateLimitedBody, { headers: { "retry-after": "120" }, status: 429 }),
      () => Response.json(successBody),
    ]);
    const { delays, sleep } = recordingSleep();

    expect(chatCompletion(fetchImpl, { sleep })).resolves.toEqual(successBody);
    expect(delays[0]).toBe(3_000);
    expect(delays[1]).toBeGreaterThan(2_000);
    expect(delays[1]).toBeLessThanOrEqual(4_000);
    expect(delays[2]).toBe(10_000);
  });

  it.each([400, 401, 404])("does not retry non-retryable status %i", async (status) => {
    const { calls, fetchImpl } = scriptedFetch([
      () => Response.json({ error: { message: "Provider returned error" } }, { status }),
      () => Response.json(successBody),
    ]);
    const { delays, sleep } = recordingSleep();

    expect(chatCompletion(fetchImpl, { sleep })).rejects.toMatchObject({
      _tag: "ModelGatewayRequestError",
      status,
    });
    expect(calls()).toBe(1);
    expect(delays).toEqual([]);
  });

  it.each(["funding_mismatch", "model_credential_store_unavailable"])(
    "does not retry the gateway's 502 %s refusal",
    async (code) => {
      const { calls, fetchImpl } = scriptedFetch([
        () =>
          Response.json(
            { error: { code, message: "Refused.", type: "model_gateway_error" } },
            { status: 502 },
          ),
        () => Response.json(successBody),
      ]);
      const { delays, sleep } = recordingSleep();

      expect(chatCompletion(fetchImpl, { sleep })).rejects.toMatchObject({
        _tag: "ModelGatewayRequestError",
        providerCode: code,
        status: 502,
      });
      expect(calls()).toBe(1);
      expect(delays).toEqual([]);
    },
  );

  it("does not retry the gateway's 403 operator_funding_exhausted refusal", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      () =>
        Response.json(
          {
            error: {
              code: "operator_funding_exhausted",
              message: "Organization has used its monthly operator-funded model spend ceiling.",
              type: "model_gateway_error",
            },
          },
          { status: 403 },
        ),
      () => Response.json(successBody),
    ]);
    const { delays, sleep } = recordingSleep();

    expect(chatCompletion(fetchImpl, { sleep })).rejects.toMatchObject({
      _tag: "ModelGatewayRequestError",
      providerCode: "operator_funding_exhausted",
      status: 403,
    });
    expect(calls()).toBe(1);
    expect(delays).toEqual([]);
  });

  it("still retries a 502 the gateway did not refuse for funding", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      () =>
        Response.json({ error: { code: "bad_gateway", message: "Upstream." } }, { status: 502 }),
      () => Response.json(successBody),
    ]);

    expect(chatCompletion(fetchImpl, recordingSleep())).resolves.toEqual(successBody);
    expect(calls()).toBe(2);
  });

  it("retries a 500 only when it carries an upstream provider error", async () => {
    const upstream = scriptedFetch([
      () => Response.json({ error: { message: "Provider returned error" } }, { status: 500 }),
      () => Response.json(successBody),
    ]);
    expect(chatCompletion(upstream.fetchImpl, recordingSleep())).resolves.toEqual(successBody);
    expect(upstream.calls()).toBe(2);

    const internal = scriptedFetch([
      () => Response.json({ error: { message: "Internal error" } }, { status: 500 }),
      () => Response.json(successBody),
    ]);
    expect(chatCompletion(internal.fetchImpl, recordingSleep())).rejects.toMatchObject({
      status: 500,
    });
    expect(internal.calls()).toBe(1);
  });

  it("throws the unchanged terminal error after three retries", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      () => Response.json(rateLimitedBody, { status: 429 }),
    ]);
    const { delays, sleep } = recordingSleep();

    const failure = await chatCompletion(fetchImpl, { sleep }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failure).toMatchObject({
      _tag: "ModelGatewayRequestError",
      endpoint: "https://bifrost.internal/v1/chat/completions",
      message:
        "Model gateway chat completion failed with status 429 (429) Provider message: Provider returned error.",
      providerCode: "429",
      providerMessage: "Provider returned error",
      status: 429,
    });
    expect(calls()).toBe(4);
    expect(delays).toHaveLength(3);
    expect(delays[1]).toBeGreaterThanOrEqual(1_000);
    expect(delays[1]).toBeLessThanOrEqual(2_000);
    expect(delays[2]).toBeGreaterThanOrEqual(2_000);
    expect(delays[2]).toBeLessThanOrEqual(4_000);
  });

  it("retries in-body capacity envelopes under the same policy", async () => {
    const capacityBody = {
      extra_fields: {
        raw_response: {
          error: {
            code: "capacity_exhausted",
            message: "The model is temporarily at capacity.",
            type: "server_error",
          },
        },
      },
    };
    const { calls, fetchImpl } = scriptedFetch([
      () => Response.json(capacityBody),
      () => Response.json(capacityBody),
      () => Response.json(successBody),
    ]);

    expect(chatCompletion(fetchImpl, recordingSleep())).resolves.toEqual(successBody);
    expect(calls()).toBe(3);
  });

  it("stops retrying promptly when the signal aborts during backoff", async () => {
    const controller = new AbortController();
    const { signal } = controller;
    const addEventListener = signal.addEventListener.bind(signal);
    // Abort once the default backoff sleep subscribes, i.e. while it waits on Retry-After.
    signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
      addEventListener(...args);
      queueMicrotask(() => controller.abort(new Error("run canceled")));
    }) as AbortSignal["addEventListener"];
    const { calls, fetchImpl } = scriptedFetch([
      () => Response.json(rateLimitedBody, { headers: { "retry-after": "10" }, status: 429 }),
      () => Response.json(successBody),
    ]);
    const startedAt = Date.now();

    expect(chatCompletion(fetchImpl, { signal })).rejects.toThrow("run canceled");
    expect(calls()).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("does not issue another attempt when aborted before the retry", async () => {
    const controller = new AbortController();
    const { calls, fetchImpl } = scriptedFetch([
      () => Response.json(rateLimitedBody, { status: 429 }),
    ]);

    expect(
      chatCompletion(fetchImpl, {
        signal: controller.signal,
        sleep: async () => controller.abort(new Error("run canceled")),
      }),
    ).rejects.toThrow("run canceled");
    expect(calls()).toBe(1);
  });

  it("retries transient embedding failures and keeps the terminal error on exhaustion", async () => {
    const embedding = [1, 2, 3];
    const recovered = scriptedFetch([
      () => new Response("", { status: 503 }),
      () => Response.json({ data: [{ embedding }], usage: { total_tokens: 7 } }),
    ]);
    const request = {
      baseURL: "https://bifrost.internal",
      defaultHeaders: { "Content-Type": "application/json" },
      dimensions: 3,
      errorContext: "Model gateway embedding",
      input: "hello",
      model: "openai/text-embedding-3-small",
      sleep: recordingSleep().sleep,
    };

    expect(
      requestOpenAiCompatibleEmbedding({ ...request, fetch: recovered.fetchImpl }),
    ).resolves.toMatchObject({ embedding, usageTokens: 7 });
    expect(recovered.calls()).toBe(2);

    const exhausted = scriptedFetch([() => new Response("", { status: 429 })]);
    expect(
      requestOpenAiCompatibleEmbedding({ ...request, fetch: exhausted.fetchImpl }),
    ).rejects.toMatchObject({
      _tag: "ModelGatewayRequestError",
      message: "Model gateway embedding failed with status 429.",
      status: 429,
    });
    expect(exhausted.calls()).toBe(4);
  });
});
