import { describe, expect, it } from "bun:test";
import { createPlatformSdk, PlatformTransportError } from "./index.ts";

describe("platform SDK streaming transport", () => {
  it("buffers multiline SSE events and streams NDJSON", async () => {
    const responses = [
      new Response('event: run\ndata: {"type":\ndata: "run.started"}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      new Response('{"type":"run.completed"}\n', {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      }),
    ];
    const fetchImpl = (async () => responses.shift()!) as unknown as typeof fetch;
    const sdk = createPlatformSdk({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    const events: unknown[] = [];
    for await (const event of sdk.stream({ method: "GET", path: "/v1/runs/run_1/tail" })) {
      events.push(event);
    }
    for await (const event of sdk.stream({ method: "GET", path: "/v1/runs/run_1/tail" })) {
      events.push(event);
    }
    expect(events).toEqual([{ type: "run.started" }, { type: "run.completed" }]);
  });

  it("streams case-insensitive SSE media types with bare carriage-return lines", async () => {
    const fetchImpl = (async () =>
      new Response('data: {"type":"run.started"}\r\rdata: {"type":"run.completed"}\r\r', {
        status: 200,
        headers: { "content-type": "Text/Event-Stream" },
      })) as unknown as typeof fetch;
    const sdk = createPlatformSdk({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    const events: unknown[] = [];
    for await (const event of sdk.stream({ method: "GET", path: "/v1/runs/run_1/tail" })) {
      events.push(event);
    }
    expect(events).toEqual([{ type: "run.started" }, { type: "run.completed" }]);
  });

  it("rejects unsupported successful stream media types", async () => {
    const fetchImpl = (async () =>
      new Response("upstream login page", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    const sdk = createPlatformSdk({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    const consume = async () => {
      for await (const _event of sdk.stream({ method: "GET", path: "/v1/runs/run_1/tail" })) {
        // Consume the stream to force media-type validation.
      }
    };
    expect(consume()).rejects.toBeInstanceOf(PlatformTransportError);
  });

  it("rejects malformed NDJSON instead of emitting text events", async () => {
    const fetchImpl = (async () =>
      new Response("{not-json}\n", {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      })) as unknown as typeof fetch;
    const sdk = createPlatformSdk({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    const consume = async () => {
      for await (const _event of sdk.stream({ method: "GET", path: "/v1/runs/run_1/tail" })) {
        // Consume to force strict NDJSON parsing.
      }
    };
    expect(consume()).rejects.toBeInstanceOf(PlatformTransportError);
  });

  it("expands top-level JSON arrays into individual stream events", async () => {
    const fetchImpl = (async () =>
      Response.json([
        { type: "run.started" },
        { type: "run.completed" },
      ])) as unknown as typeof fetch;
    const sdk = createPlatformSdk({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    const events: unknown[] = [];
    for await (const event of sdk.stream({ method: "GET", path: "/v1/runs/run_1/tail" })) {
      events.push(event);
    }
    expect(events).toEqual([{ type: "run.started" }, { type: "run.completed" }]);
  });

  it("treats a successful no-content stream page as empty", async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 204,
        headers: {
          "content-type": "application/json",
          "stream-cursor": "cursor_2",
          "stream-next-offset": "24",
          "stream-up-to-date": "true",
        },
      })) as unknown as typeof fetch;
    const sdk = createPlatformSdk({ baseUrl: "https://api.example.test", fetch: fetchImpl });

    const page = await sdk.streamPage({ method: "GET", path: "/v1/runs/run_1/tail" });

    expect(page).toMatchObject({
      cursor: "cursor_2",
      items: [],
      nextOffset: "24",
      upToDate: true,
    });
  });

  it("wraps stream body failures as transport errors", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"run.started"}\n\n'));
        controller.error(new Error("socket closed"));
      },
    });
    const fetchImpl = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;
    const sdk = createPlatformSdk({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    const consume = async () => {
      for await (const _event of sdk.stream({ method: "GET", path: "/v1/runs/run_1/tail" })) {
        // Consume until the stream reports the transport failure.
      }
    };
    expect(consume()).rejects.toBeInstanceOf(PlatformTransportError);
  });

  it("cancels streaming response bodies when consumers stop early", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"type":"run.started"}\n'));
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchImpl = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      })) as unknown as typeof fetch;
    const sdk = createPlatformSdk({ baseUrl: "https://api.example.test", fetch: fetchImpl });

    for await (const _event of sdk.stream({ method: "GET", path: "/v1/runs/run_1/tail" })) {
      break;
    }

    expect(canceled).toBe(true);
  });
});
