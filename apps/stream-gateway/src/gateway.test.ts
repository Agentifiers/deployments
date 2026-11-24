import { afterEach, describe, expect, test } from "bun:test";
import { signThreadStreamSessionToken, threadStreamPath } from "@deployments-ai/streaming";
import { withCors } from "./cors.ts";
import { createStreamGateway } from "./gateway.ts";

const secret = "stream-session-secret-with-at-least-32-characters";
const durableAuthToken = "durable-token";
const scope = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
} as const;
const consoleOrigin = "https://app.example.com";
const consoleReadCors = {
  "access-control-allow-origin": consoleOrigin,
  "access-control-expose-headers":
    "stream-next-offset, stream-cursor, stream-up-to-date, stream-closed, etag",
  vary: "Origin",
};
const noCors = {
  "access-control-allow-origin": null,
  "access-control-expose-headers": null,
  vary: null,
};

function token(
  overrides: Partial<{
    expiresAt: string;
    permissions: readonly ("append" | "read")[];
    threadId: string;
  }> = {},
) {
  return signThreadStreamSessionToken(
    { ...scope, expiresAt: "2099-01-01T00:00:00.000Z", permissions: ["read"], ...overrides },
    { secret },
  );
}

interface UpstreamRequest {
  readonly authorization: string | null;
  readonly url: URL;
}

const servers: { stop(force?: boolean): unknown }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function startUpstream(respond: (request: Request) => Response | Promise<Response>) {
  const requests: UpstreamRequest[] = [];
  const server = Bun.serve({
    fetch: (request) => {
      requests.push({
        authorization: request.headers.get("authorization"),
        url: new URL(request.url),
      });
      return respond(request);
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.port}`, requests };
}

function startGateway(
  durableBaseUrl: string,
  {
    allowedOrigins = [],
    shutdownSignal,
  }: { allowedOrigins?: readonly string[]; shutdownSignal?: AbortSignal } = {},
) {
  const server = Bun.serve({
    fetch: createStreamGateway({
      allowedOrigins,
      durableAuthToken,
      durableBaseUrl,
      sessionTokenSecret: secret,
      ...(shutdownSignal ? { shutdownSignal } : {}),
    }),
    hostname: "127.0.0.1",
    port: 0,
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function streamUrl(gateway: string, query = "", threadId: string = scope.threadId) {
  return `${gateway}/v1/threads/${threadId}/stream${query}`;
}

async function problemCode(response: Response) {
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  const body: unknown = await response.json();
  return body && typeof body === "object" && "code" in body ? body.code : undefined;
}

function corsHeaders(response: Response) {
  return {
    "access-control-allow-origin": response.headers.get("access-control-allow-origin"),
    "access-control-expose-headers": response.headers.get("access-control-expose-headers"),
    vary: response.headers.get("vary"),
  };
}

describe("stream gateway authorization", () => {
  test.each([
    ["a missing bearer token", undefined, 401, "unauthorized"],
    ["a malformed token", "not-a-token", 401, "invalid_stream_token"],
    ["a forged signature", `${token().slice(0, -4)}AAAA`, 401, "invalid_stream_token"],
    [
      "an expired session",
      token({ expiresAt: "2000-01-01T00:00:00.000Z" }),
      401,
      "stream_session_expired",
    ],
    [
      "another thread's session",
      token({ threadId: "01ARZ3NDEKTSV4RRFFQ69G5FB0" }),
      403,
      "stream_scope_violation",
    ],
    ["a session without read", token({ permissions: ["append"] }), 403, "stream_scope_violation"],
  ])("rejects %s without reading upstream", async (_label, bearer, status, code) => {
    const upstream = startUpstream(() => new Response("[]"));
    const gateway = startGateway(upstream.baseUrl);

    const response = await fetch(streamUrl(gateway), {
      headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
    });

    expect(response.status).toBe(status);
    expect(await problemCode(response)).toBe(code);
    expect(upstream.requests).toHaveLength(0);
  });

  test("rejects non-canonical thread ids", async () => {
    const upstream = startUpstream(() => new Response("[]"));
    const gateway = startGateway(upstream.baseUrl);

    const response = await fetch(streamUrl(gateway, "", scope.threadId.toLowerCase()), {
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.status).toBe(400);
    expect(await problemCode(response)).toBe("invalid_id");
    expect(upstream.requests).toHaveLength(0);
  });
});

describe("stream gateway request validation", () => {
  test.each([
    ["an unknown live mode", "?live=longpoll"],
    ["an empty cursor", "?cursor="],
    ["an empty offset", "?offset="],
  ])("rejects %s before reading upstream", async (_label, query) => {
    const upstream = startUpstream(() => new Response("[]"));
    const gateway = startGateway(upstream.baseUrl);

    const response = await fetch(streamUrl(gateway, query), {
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.status).toBe(400);
    expect(await problemCode(response)).toBe("invalid_stream_request");
    expect(upstream.requests).toHaveLength(0);
  });

  test.each(["long-poll", "sse"])(
    "reads the session's thread stream with live=%s",
    async (live) => {
      const upstream = startUpstream(() => new Response("[]"));
      const gateway = startGateway(upstream.baseUrl);

      const response = await fetch(streamUrl(gateway, `?offset=12&cursor=c1&live=${live}`), {
        headers: { authorization: `Bearer ${token()}` },
      });

      expect(response.status).toBe(200);
      const [request] = upstream.requests;
      expect(request?.authorization).toBe(`Bearer ${durableAuthToken}`);
      expect(request?.url.pathname).toBe(threadStreamPath(scope));
      expect(Object.fromEntries(request?.url.searchParams ?? [])).toEqual({
        cursor: "c1",
        live,
        offset: "12",
      });
    },
  );

  test("serves health checks and rejects other routes", async () => {
    const gateway = startGateway("http://127.0.0.1:9");

    const health = await fetch(`${gateway}/healthz`);
    expect(health.status).toBe(200);
    const unknown = await fetch(`${gateway}/v1/threads`);
    expect(unknown.status).toBe(404);
    expect(await problemCode(unknown)).toBe("route_not_found");
    const post = await fetch(streamUrl(gateway), {
      headers: { authorization: `Bearer ${token()}` },
      method: "POST",
    });
    expect(post.status).toBe(404);
  });
});

describe("stream gateway proxying", () => {
  test("forwards only stream protocol headers and the upstream status", async () => {
    const upstream = startUpstream(
      () =>
        new Response('{"code":"not_found"}', {
          headers: {
            "cache-control": "public, max-age=60",
            "content-type": "application/json",
            etag: '"e1"',
            "set-cookie": "internal=1",
            "stream-closed": "true",
            "stream-cursor": "c2",
            "stream-next-offset": "42",
            "stream-up-to-date": "true",
            "x-internal": "secret",
          },
          status: 404,
        }),
    );
    const gateway = startGateway(upstream.baseUrl);

    const response = await fetch(streamUrl(gateway), {
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"code":"not_found"}');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("etag")).toBe('"e1"');
    expect(response.headers.get("stream-closed")).toBe("true");
    expect(response.headers.get("stream-cursor")).toBe("c2");
    expect(response.headers.get("stream-next-offset")).toBe("42");
    expect(response.headers.get("stream-up-to-date")).toBe("true");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-internal")).toBeNull();
  });

  test.each([
    ["without an origin", undefined, noCors],
    ["for the console origin", consoleOrigin, consoleReadCors],
  ])(
    "delivers SSE events %s before the upstream response completes",
    async (_label, origin, cors) => {
      const encoder = new TextEncoder();
      const { promise: released, resolve: release } = Promise.withResolvers<void>();
      const upstream = startUpstream(
        () =>
          new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(encoder.encode('event: data\ndata: [{"n":1}]\n\n'));
                await released;
                controller.enqueue(
                  encoder.encode('event: control\ndata: {"streamNextOffset":"1"}\n\n'),
                );
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      const gateway = startGateway(upstream.baseUrl, { allowedOrigins: [consoleOrigin] });

      const response = await fetch(streamUrl(gateway, "?live=sse"), {
        headers: { authorization: `Bearer ${token()}`, ...(origin ? { origin } : {}) },
      });
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(corsHeaders(response)).toEqual(cors);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let received = "";
      while (!received.includes("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("stream ended before the first event");
        received += decoder.decode(chunk.value, { stream: true });
      }
      expect(received).toBe('event: data\ndata: [{"n":1}]\n\n');

      release();
      let rest = "";
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        rest += decoder.decode(chunk.value, { stream: true });
      }
      expect(rest).toContain('"streamNextOffset":"1"');
    },
  );

  test("aborts the upstream read when the client disconnects", async () => {
    const { promise: upstreamAborted, resolve: markAborted } = Promise.withResolvers<void>();
    const upstream = startUpstream((request) => {
      request.signal.addEventListener("abort", () => markAborted(), { once: true });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: data\ndata: []\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const gateway = startGateway(upstream.baseUrl);
    const client = new AbortController();

    const response = await fetch(streamUrl(gateway, "?live=sse"), {
      headers: { authorization: `Bearer ${token()}` },
      signal: client.signal,
    });
    await response.body!.getReader().read();
    client.abort();

    await upstreamAborted;
  });

  test("closes in-flight live reads when the gateway shuts down", async () => {
    const { promise: upstreamAborted, resolve: markAborted } = Promise.withResolvers<void>();
    const upstream = startUpstream((request) => {
      request.signal.addEventListener("abort", () => markAborted(), { once: true });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: data\ndata: []\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const shutdown = new AbortController();
    const gateway = startGateway(upstream.baseUrl, { shutdownSignal: shutdown.signal });

    const response = await fetch(streamUrl(gateway, "?live=sse"), {
      headers: { authorization: `Bearer ${token()}` },
    });
    const reader = response.body!.getReader();
    await reader.read();
    shutdown.abort();

    await upstreamAborted;
    const ended = await reader.read().then(
      (chunk) => chunk.done,
      () => true,
    );
    expect(ended).toBe(true);
  });

  test("reports an unreachable Durable Streams service as unavailable", async () => {
    const upstream = startUpstream(() => new Response("[]"));
    servers.pop()?.stop(true);
    const gateway = startGateway(upstream.baseUrl);

    const response = await fetch(streamUrl(gateway), {
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.status).toBe(503);
    expect(await problemCode(response)).toBe("stream_unavailable");
  });
});

describe("stream gateway CORS", () => {
  test("approves the console origin's preflight without a token or an upstream read", async () => {
    const upstream = startUpstream(() => new Response("[]"));
    const gateway = startGateway(upstream.baseUrl, { allowedOrigins: [consoleOrigin] });

    const response = await fetch(streamUrl(gateway, "?offset=12&live=sse"), {
      headers: {
        "access-control-request-headers": "authorization",
        "access-control-request-method": "GET",
        origin: consoleOrigin,
      },
      method: "OPTIONS",
    });

    expect(response.status).toBe(204);
    const {
      "content-length": _contentLength,
      date: _date,
      ...headers
    } = Object.fromEntries(response.headers);
    expect(headers).toEqual({
      "access-control-allow-headers": "authorization",
      "access-control-allow-methods": "GET",
      "access-control-allow-origin": consoleOrigin,
      "access-control-max-age": "600",
      "cache-control": "no-store",
      vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    });
    expect(upstream.requests).toHaveLength(0);
  });

  test("approves a preflight from one label under a wildcard origin", async () => {
    const origin = "https://preview-1.example.net";
    const gateway = startGateway("http://127.0.0.1:9", {
      allowedOrigins: [consoleOrigin, "https://*.example.net"],
    });

    const response = await fetch(streamUrl(gateway), {
      headers: { "access-control-request-method": "GET", origin },
      method: "OPTIONS",
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  });

  test.each([
    ["another origin", "https://other.example.com", "GET"],
    ["the console origin for a POST", consoleOrigin, "POST"],
    ["two labels under a wildcard", "https://a.b.example.net", "GET"],
    ["a wildcard's bare domain", "https://example.net", "GET"],
    ["a lookalike of a wildcard's domain", "https://evilexample.net", "GET"],
    ["plain http under a wildcard", "http://preview-1.example.net", "GET"],
  ])("rejects a preflight from %s", async (_label, origin, method) => {
    const gateway = startGateway("http://127.0.0.1:9", {
      allowedOrigins: [consoleOrigin, "https://*.example.net"],
    });

    const response = await fetch(streamUrl(gateway), {
      headers: { "access-control-request-method": method, origin },
      method: "OPTIONS",
    });

    expect(response.status).toBe(404);
    expect(await problemCode(response)).toBe("route_not_found");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test.each([
    ["the console origin", consoleOrigin, consoleReadCors],
    ["another origin", "https://other.example.com", noCors],
    ["no origin", undefined, noCors],
  ])("labels reads and problems for %s", async (_label, origin, cors) => {
    const upstream = startUpstream(
      () =>
        new Response('[{"n":1}]', {
          headers: { "content-type": "application/json", "stream-next-offset": "42" },
        }),
    );
    const gateway = startGateway(upstream.baseUrl, { allowedOrigins: [consoleOrigin] });
    const originHeader = origin ? { origin } : {};

    const read = await fetch(streamUrl(gateway), {
      headers: { authorization: `Bearer ${token()}`, ...originHeader },
    });
    expect(read.status).toBe(200);
    expect(await read.text()).toBe('[{"n":1}]');
    expect(read.headers.get("stream-next-offset")).toBe("42");
    expect(corsHeaders(read)).toEqual(cors);

    const expired = await fetch(streamUrl(gateway), {
      headers: {
        authorization: `Bearer ${token({ expiresAt: "2000-01-01T00:00:00.000Z" })}`,
        ...originHeader,
      },
    });
    expect(expired.status).toBe(401);
    expect(await problemCode(expired)).toBe("stream_session_expired");
    expect(corsHeaders(expired)).toEqual(cors);
  });

  test("appends Origin to a response's existing Vary header", () => {
    const response = withCors(
      new Response("ok", { headers: { vary: "Accept-Encoding" } }),
      consoleOrigin,
      [consoleOrigin],
    );

    expect(response.headers.get("vary")).toBe("Accept-Encoding, Origin");
  });
});
