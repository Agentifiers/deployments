import { expect, test } from "bun:test";

import { executePinnedHttpRequest, executePinnedHttpsWithSameOriginRedirects } from "./index.ts";

test("redirect bodies are cancelled instead of buffered", async () => {
  let cancelled = false;
  let attempt = 0;
  const result = await executePinnedHttpsWithSameOriginRedirects({
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    pinnedRequest: async () => {
      attempt += 1;
      if (attempt === 1) {
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { location: "/next" }, status: 302 },
        );
      }
      return new Response("ok", { status: 200 });
    },
    signal: new AbortController().signal,
    url: "https://example.com/start",
    verifiedOrigin: "https://example.com",
  });
  expect(result.finalUrl).toBe("https://example.com/next");
  expect(cancelled).toBe(true);
});

test("a pinned request returns a redirect to the caller without following it", async () => {
  const paths: string[] = [];
  const server = Bun.serve({
    fetch(request) {
      paths.push(new URL(request.url).pathname);
      return new Response(null, { headers: { location: "/next" }, status: 302 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const response = await executePinnedHttpRequest({
      addresses: [{ address: "127.0.0.1", family: 4 }],
      allowHttp: true,
      signal: AbortSignal.timeout(5_000),
      url: `http://localhost:${server.port}/start`,
    });
    expect([response.status, response.headers.get("location"), paths]).toEqual([
      302,
      "/next",
      ["/start"],
    ]);
  } finally {
    await server.stop(true);
  }
});
