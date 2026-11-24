import { describe, expect, test } from "bun:test";
import { createPlatformSdk, PlatformApiError, type PlatformStreamPage } from "./index.ts";

const session = {
  accessToken: "stream-session-token",
  streamUrl: "https://streams.example.test/v1/threads/thread_1/stream",
};

type Connection = (signal: AbortSignal | undefined) => Response;

function sse(events: readonly string[], options: { readonly holdOpen?: boolean } = {}): Connection {
  return (signal) =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const event of events) controller.enqueue(new TextEncoder().encode(event));
          if (!options.holdOpen) {
            controller.close();
            return;
          }
          signal?.addEventListener("abort", () =>
            controller.error(new DOMException("The operation was aborted.", "AbortError")),
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
}

const data = (entries: readonly unknown[]) => `event: data\ndata: ${JSON.stringify(entries)}\n\n`;
const control = (fields: Readonly<Record<string, unknown>>) =>
  `event: control\ndata: ${JSON.stringify(fields)}\n\n`;

function runtimeWith(connections: Connection[]) {
  const requests: { readonly authorization: string | null; readonly url: URL }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      authorization: new Headers(init?.headers).get("authorization"),
      url: new URL(input instanceof Request ? input.url : input),
    });
    const next = connections.shift();
    if (!next) throw new Error("unexpected stream request");
    return next(init?.signal ?? undefined);
  }) as unknown as typeof fetch;
  const runtime = createPlatformSdk({
    apiKey: "platform-api-key",
    baseUrl: "https://api.example.test",
    fetch: fetchImpl,
  }).runtime({});
  return { requests, runtime };
}

async function collect(pages: AsyncIterable<PlatformStreamPage>) {
  const collected: PlatformStreamPage[] = [];
  for await (const page of pages) collected.push(page);
  return collected;
}

describe("thread stream SSE iteration", () => {
  test("reconnects from the last committed offset and ends when the stream closes", async () => {
    const { requests, runtime } = runtimeWith([
      sse([
        data([{ eventId: "e1" }]),
        control({ streamCursor: "c1", streamNextOffset: "1", upToDate: true }),
        data([{ eventId: "e2" }]),
        control({ streamNextOffset: "2" }),
        // The server ends the connection before committing e3 with a control event.
        data([{ eventId: "e3" }]),
      ]),
      sse([data([{ eventId: "e3" }]), control({ streamClosed: true, streamNextOffset: "3" })]),
    ]);

    const pages = await collect(runtime.threads.streamEvents(session, { offset: "-1" }));

    expect(pages.map((page) => [page.items, page.nextOffset, page.closed])).toEqual([
      [[{ eventId: "e1" }], "1", false],
      [[{ eventId: "e2" }], "2", false],
      [[{ eventId: "e3" }], "3", true],
    ]);
    expect(requests.map(({ url }) => url.toString())).toEqual([
      "https://streams.example.test/v1/threads/thread_1/stream?live=sse&offset=-1",
      "https://streams.example.test/v1/threads/thread_1/stream?cursor=c1&live=sse&offset=2",
    ]);
    expect(
      requests.every(({ authorization }) => authorization === "Bearer stream-session-token"),
    ).toBe(true);
  });

  test("ends quietly when the caller aborts an open connection", async () => {
    const abort = new AbortController();
    const { requests, runtime } = runtimeWith([
      sse([data([{ eventId: "e1" }]), control({ streamNextOffset: "1", upToDate: true })], {
        holdOpen: true,
      }),
    ]);

    const pages: PlatformStreamPage[] = [];
    for await (const page of runtime.threads.streamEvents(session, {
      offset: "0",
      signal: abort.signal,
    })) {
      pages.push(page);
      abort.abort();
    }

    expect(pages.map((page) => page.nextOffset)).toEqual(["1"]);
    expect(requests).toHaveLength(1);
  });

  test("surfaces an expired session when reconnecting", async () => {
    const { runtime } = runtimeWith([
      sse([control({ streamNextOffset: "4", upToDate: true })]),
      () =>
        Response.json(
          { code: "stream_session_expired", status: 401, title: "stream session expired" },
          { headers: { "content-type": "application/problem+json" }, status: 401 },
        ),
    ]);

    const pages: PlatformStreamPage[] = [];
    const failure = await (async () => {
      for await (const page of runtime.threads.streamEvents(session, { offset: "3" })) {
        pages.push(page);
      }
    })().catch((error: unknown) => error);

    expect(pages.map((page) => page.nextOffset)).toEqual(["4"]);
    expect(failure).toBeInstanceOf(PlatformApiError);
    expect(failure).toMatchObject({ problem: { code: "stream_session_expired", status: 401 } });
  });
});
