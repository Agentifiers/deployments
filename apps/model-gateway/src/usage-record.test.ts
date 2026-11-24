import { describe, expect, test } from "bun:test";
import { observeResponseBody, usageReader, type StreamOutcome } from "./usage-record.ts";

const encoder = new TextEncoder();

function streamOf(chunks: readonly string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>) {
  return Buffer.from(await new Response(stream).arrayBuffer()).toString("utf8");
}

describe("usage reader", () => {
  test("reads the last SSE usage even when lines are split across chunks and use CRLF", () => {
    const reader = usageReader("text/event-stream; charset=utf-8");
    const body =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\r\n\r\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}\r\n\r\n' +
      "data: [DONE]\r\n\r\n";
    for (let index = 0; index < body.length; index += 7) {
      reader.chunk(encoder.encode(body.slice(index, index + 7)));
    }
    expect(reader.usage()).toEqual({ inputTokens: 5, outputTokens: 3 });
  });

  test("reads JSON usage including cost, and tolerates bodies without usage", () => {
    const json = usageReader("application/json");
    json.chunk(encoder.encode('{"data":[],"usage":{"prompt_tokens":4,'));
    json.chunk(encoder.encode('"total_tokens":4,"cost":{"total_cost":0.000002}}}'));
    expect(json.usage()).toEqual({ costUsdMicros: 2, inputTokens: 4 });

    const empty = usageReader(null);
    empty.chunk(encoder.encode("not json"));
    expect(empty.usage()).toBeUndefined();
  });
});

describe("observeResponseBody", () => {
  test("passes bytes through unchanged and ends once on completion", async () => {
    const outcomes: StreamOutcome[] = [];
    const seen: string[] = [];
    const observed = observeResponseBody(streamOf(["a", "bc", "\u00e9"]), {
      chunk: (bytes) => seen.push(Buffer.from(bytes).toString("utf8")),
      end: (outcome) => outcomes.push(outcome),
    });
    expect(await drain(observed)).toBe("abc\u00e9");
    expect(seen).toEqual(["a", "bc", "\u00e9"]);
    expect(outcomes).toEqual(["completed"]);
  });

  test("reports cancellation and cancels the upstream body", async () => {
    const outcomes: StreamOutcome[] = [];
    let upstreamCancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      cancel: () => {
        upstreamCancelled = true;
      },
      pull: (controller) => controller.enqueue(encoder.encode("x")),
    });
    const reader = observeResponseBody(upstream, {
      chunk: () => undefined,
      end: (outcome) => outcomes.push(outcome),
    }).getReader();
    await reader.read();
    await reader.cancel("client went away");
    expect(outcomes).toEqual(["cancelled"]);
    expect(upstreamCancelled).toBe(true);
  });

  test("reports an upstream failure", async () => {
    const outcomes: StreamOutcome[] = [];
    const upstream = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.error(new Error("reset")),
    });
    const observed = observeResponseBody(upstream, {
      chunk: () => undefined,
      end: (outcome) => outcomes.push(outcome),
    });
    expect(drain(observed)).rejects.toThrow("reset");
    expect(outcomes).toEqual(["failed"]);
  });
});
