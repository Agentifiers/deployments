import { describe, expect, test as it } from "bun:test";
import { requestOpenAiCompatibleChatCompletion } from "./index.ts";

const encoder = new TextEncoder();

/** Serves raw SSE text split at exactly the given read boundaries; `open` never closes it. */
function sseResponse(reads: readonly string[], options: { readonly open?: boolean } = {}) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const read of reads) controller.enqueue(encoder.encode(read));
        if (!options.open) controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function event(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { choices: [{ delta, index: 0, ...extra }], id: "gen-1", model: "qwen/qwen3.7-plus" };
}

function scriptedFetch(responses: readonly (() => Response)[]) {
  let calls = 0;
  const fetchImpl = (async () => {
    const next = responses[Math.min(calls, responses.length - 1)]!;
    calls += 1;
    return next();
  }) as unknown as typeof fetch;
  return { calls: () => calls, fetchImpl };
}

function chatCompletion(
  fetchImpl: typeof fetch,
  options: {
    readonly onTextDelta?: (text: string) => void;
    readonly signal?: AbortSignal;
    readonly streamIdleTimeoutMs?: number;
  } = {},
) {
  return requestOpenAiCompatibleChatCompletion({
    baseURL: "https://bifrost.internal",
    body: {
      messages: [{ content: "hello", role: "user" }],
      model: "openrouter/qwen",
      stream: true,
    },
    defaultHeaders: { "Content-Type": "application/json" },
    errorContext: "Model gateway chat completion",
    fetch: fetchImpl,
    sleep: async () => undefined,
    ...options,
  });
}

const finished = event(chunk({ content: "ok" }, { finish_reason: "stop" })) + "data: [DONE]\n\n";

function finishedBody(message: Record<string, unknown>) {
  return {
    choices: [
      {
        finish_reason: "stop",
        index: 0,
        message: { content: "ok", role: "assistant", ...message },
      },
    ],
    id: "gen-1",
    model: "qwen/qwen3.7-plus",
    object: "chat.completion",
  };
}

async function streamedBody(deltas: readonly Record<string, unknown>[]) {
  const { fetchImpl } = scriptedFetch([
    () => sseResponse([...deltas.map((delta) => event(chunk(delta))), finished]),
  ]);
  return await chatCompletion(fetchImpl);
}

describe("streamed chat completions", () => {
  it("aggregates text, split tool-call deltas, and a usage-only final chunk into one body", async () => {
    const deltas: string[] = [];
    const stream = [
      ": OPENROUTER PROCESSING\n\n",
      event(chunk({ content: "Checking ", role: "assistant" })),
      event(chunk({ content: "now." })),
      event(
        chunk({
          tool_calls: [
            {
              function: { arguments: '{"re', name: "records_read" },
              id: "call_a",
              index: 0,
              type: "function",
            },
          ],
        }),
      ),
      event(
        chunk({
          tool_calls: [
            { function: { arguments: "", name: "deploy" }, id: "call_b", index: 1 },
            { function: { arguments: 'gion":"eu"}' }, index: 0 },
          ],
        }),
      ),
      event(chunk({ tool_calls: [{ function: { arguments: "{}" }, index: 1 }] })),
      event(chunk({}, { finish_reason: "tool_calls", native_finish_reason: "tool_use" })),
      event({
        choices: [],
        id: "gen-1",
        model: "qwen/qwen3.7-plus",
        provider: "Alibaba",
        usage: {
          completion_tokens: 9,
          cost: 0.000_42,
          prompt_tokens: 30,
          prompt_tokens_details: { cached_tokens: 12 },
          total_tokens: 39,
        },
      }),
      "data: [DONE]\n\n",
    ].join("");
    // Split mid-line, mid-CRLF, and mid-UTF-8 sequence to exercise read reassembly.
    const crlf = stream.replaceAll("\n", "\r\n");
    const reads = [crlf.slice(0, 41), crlf.slice(41, 87), crlf.slice(87, 88), crlf.slice(88)];
    const { fetchImpl } = scriptedFetch([() => sseResponse(reads)]);

    const body = await chatCompletion(fetchImpl, { onTextDelta: (text) => deltas.push(text) });

    expect(deltas).toEqual(["Checking ", "now."]);
    expect(body).toEqual({
      choices: [
        {
          finish_reason: "tool_calls",
          index: 0,
          message: {
            content: "Checking now.",
            role: "assistant",
            tool_calls: [
              {
                function: { arguments: '{"region":"eu"}', name: "records_read" },
                id: "call_a",
                type: "function",
              },
              { function: { arguments: "{}", name: "deploy" }, id: "call_b", type: "function" },
            ],
          },
          native_finish_reason: "tool_use",
        },
      ],
      id: "gen-1",
      model: "qwen/qwen3.7-plus",
      object: "chat.completion",
      provider: "Alibaba",
      usage: {
        completion_tokens: 9,
        cost: 0.000_42,
        prompt_tokens: 30,
        prompt_tokens_details: { cached_tokens: 12 },
        total_tokens: 39,
      },
    });
  });

  it("decodes multi-byte text split across reads", async () => {
    const bytes = encoder.encode(event(chunk({ content: "naïve ✓" }, { finish_reason: "stop" })));
    const split = bytes.indexOf(0xe2) + 1;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, split));
          controller.enqueue(bytes.slice(split));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );

    expect(chatCompletion(scriptedFetch([() => response]).fetchImpl)).resolves.toMatchObject({
      choices: [{ message: { content: "naïve ✓" } }],
    });
  });

  it("rejects non-retryable provider error events without retrying", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      () =>
        sseResponse([
          event({
            choices: [{ delta: {}, finish_reason: "error", index: 0 }],
            error: { code: "context_length_exceeded", message: "Prompt is too long." },
          }),
        ]),
      () => sseResponse([finished]),
    ]);

    expect(chatCompletion(fetchImpl)).rejects.toMatchObject({
      _tag: "ModelGatewayRequestError",
      providerCode: "context_length_exceeded",
      providerMessage: "Prompt is too long.",
    });
    expect(calls()).toBe(1);
  });

  it("retries transient error events that arrive before any assistant text", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      () =>
        sseResponse([
          "event: error\n",
          event({ error: { message: "Provider returned error" }, status_code: 502 }),
        ]),
      () => sseResponse([finished]),
    ]);

    expect(chatCompletion(fetchImpl)).resolves.toMatchObject({
      choices: [{ message: { content: "ok" } }],
    });
    expect(calls()).toBe(2);
  });

  it("never replays a stream that already delivered assistant text", async () => {
    const deltas: string[] = [];
    const { calls, fetchImpl } = scriptedFetch([
      () =>
        sseResponse([
          event(chunk({ content: "Part" })),
          event({ error: { code: "capacity_exhausted", message: "At capacity." } }),
        ]),
      () => sseResponse([finished]),
    ]);

    expect(
      chatCompletion(fetchImpl, { onTextDelta: (text) => deltas.push(text) }),
    ).rejects.toMatchObject({ providerCode: "capacity_exhausted" });
    expect(calls()).toBe(1);
    expect(deltas).toEqual(["Part"]);
  });

  it("treats an idle stream as a retryable failure", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      () => sseResponse([": keepalive\n\n"], { open: true }),
      () => sseResponse([finished]),
    ]);

    expect(chatCompletion(fetchImpl, { streamIdleTimeoutMs: 20 })).resolves.toMatchObject({
      choices: [{ message: { content: "ok" } }],
    });
    expect(calls()).toBe(2);
  });

  it("surfaces the idle failure once retries are exhausted", async () => {
    const { calls, fetchImpl } = scriptedFetch([() => sseResponse([], { open: true })]);

    expect(chatCompletion(fetchImpl, { streamIdleTimeoutMs: 5 })).rejects.toMatchObject({
      _tag: "ModelGatewayRequestError",
      message: expect.stringContaining("stream was idle"),
    });
    expect(calls()).toBe(4);
  });

  it("cancels an open stream promptly when the caller aborts", async () => {
    const controller = new AbortController();
    const { fetchImpl } = scriptedFetch([
      () => sseResponse([event(chunk({ content: "Hel" }))], { open: true }),
    ]);
    const startedAt = Date.now();

    const pending = chatCompletion(fetchImpl, {
      onTextDelta: () => controller.abort(new Error("run canceled")),
      signal: controller.signal,
    });

    expect(pending).rejects.toThrow("run canceled");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("rejects a stream that ends before the completion finished", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      () => sseResponse([event(chunk({ content: "Trunc" }))]),
    ]);

    expect(chatCompletion(fetchImpl)).rejects.toMatchObject({
      message: expect.stringContaining("ended before the completion finished"),
    });
    expect(calls()).toBe(1);
  });

  it("folds reasoning text fragments and a late signature into one block", async () => {
    const body = await streamedBody([
      {
        reasoning: "Let me ",
        reasoning_details: [
          { format: "anthropic-claude-v1", index: 0, text: "Let me ", type: "reasoning.text" },
        ],
      },
      {
        reasoning: "think.",
        reasoning_details: [{ index: 0, text: "think.", type: "reasoning.text" }],
      },
      { reasoning_details: [{ index: 0, signature: "sig==", type: "reasoning.text" }] },
    ]);

    expect(body).toEqual(
      finishedBody({
        reasoning: "Let me think.",
        reasoning_details: [
          {
            format: "anthropic-claude-v1",
            index: 0,
            signature: "sig==",
            text: "Let me think.",
            type: "reasoning.text",
          },
        ],
      }),
    );
  });

  it("never lets a null reasoning fragment erase an earlier value", async () => {
    const body = await streamedBody([
      { reasoning_details: [{ index: 0, signature: null, text: "a", type: "reasoning.text" }] },
      { reasoning_details: [{ index: 0, signature: "s", type: "reasoning.text" }] },
      {
        reasoning_details: [
          { format: null, index: 0, signature: null, text: null, type: "reasoning.text" },
        ],
      },
    ]);

    expect(body).toEqual(
      finishedBody({
        reasoning_details: [{ index: 0, signature: "s", text: "a", type: "reasoning.text" }],
      }),
    );
  });

  it("keys reasoning fragments without an index by their array position", async () => {
    const body = await streamedBody([
      {
        reasoning_details: [
          { data: "a", type: "reasoning.encrypted" },
          { data: "b", type: "reasoning.encrypted" },
        ],
      },
      { reasoning_details: [{ id: "rs_a", type: "reasoning.encrypted" }] },
    ]);

    expect(body).toEqual(
      finishedBody({
        reasoning_details: [
          { data: "a", id: "rs_a", type: "reasoning.encrypted" },
          { data: "b", type: "reasoning.encrypted" },
        ],
      }),
    );
  });
});
