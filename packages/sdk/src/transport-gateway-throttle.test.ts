import { afterEach, describe, expect, it } from "bun:test";
import { createPlatformSdk, PlatformApiError, PlatformTransportError } from "./index.ts";

interface CannedAnswer {
  readonly body: string;
  readonly contentType: string;
  readonly status: number;
}

const GATEWAY_THROTTLE: CannedAnswer = {
  body: '{"message":"Too Many Requests"}',
  contentType: "application/json",
  status: 429,
};
const PLATFORM_THROTTLE: CannedAnswer = {
  body: JSON.stringify({
    title: "The organization exceeded its API request rate limit.",
    status: 429,
    code: "organization_rate_limited",
    requestId: "req_platform",
  }),
  contentType: "application/problem+json",
  status: 429,
};
const IDENTITY_SLOW_DOWN: CannedAnswer = {
  body: '{"error":"slow_down","error_description":"Too many authentication requests."}',
  contentType: "application/json; charset=utf-8",
  status: 429,
};
const PROJECT: CannedAnswer = {
  body: '{"id":"prj_1"}',
  contentType: "application/json",
  status: 200,
};

const servers: Bun.Server<undefined>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

function platformApi(
  leading: readonly CannedAnswer[],
  then: CannedAnswer,
  onRequest: (count: number) => void = () => {},
) {
  const received: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const answer = leading.at(received.length) ?? then;
      const body = await request.text();
      received.push(`${request.method} ${new URL(request.url).pathname} ${body}`.trimEnd());
      onRequest(received.length);
      return new Response(answer.body, {
        headers: { "content-type": answer.contentType, "x-request-id": "req_header" },
        status: answer.status,
      });
    },
  });
  servers.push(server);
  return { received, sdk: createPlatformSdk({ baseUrl: server.url.toString() }) };
}

async function problemOf(pending: Promise<unknown>) {
  try {
    await pending;
  } catch (error) {
    if (error instanceof PlatformApiError) return error.problem;
    throw error;
  }
  throw new Error("The request resolved instead of failing.");
}

describe("API Gateway throttle answers", () => {
  it("resends a throttled request until the platform answers", async () => {
    const api = platformApi([GATEWAY_THROTTLE, GATEWAY_THROTTLE], PROJECT);

    const response = await api.sdk.request({ method: "GET", path: "/v1/projects/prj_1" });

    expect(response).toEqual({ data: { id: "prj_1" }, requestId: "req_header", mocked: false });
    expect(api.received).toEqual([
      "GET /v1/projects/prj_1",
      "GET /v1/projects/prj_1",
      "GET /v1/projects/prj_1",
    ]);
  });

  it("resends a POST with its body intact", async () => {
    const api = platformApi([GATEWAY_THROTTLE], PROJECT);

    await api.sdk.request({
      method: "POST",
      path: "/v1/projects",
      contentType: "application/octet-stream",
      rawBody: new TextEncoder().encode("project bytes"),
    });

    expect(api.received).toEqual([
      "POST /v1/projects project bytes",
      "POST /v1/projects project bytes",
    ]);
  });

  it("returns the platform's own 429 without a resend", async () => {
    const api = platformApi([PLATFORM_THROTTLE], PROJECT);

    const problem = await problemOf(api.sdk.request({ method: "GET", path: "/v1/projects" }));

    expect(problem).toEqual({
      title: "The organization exceeded its API request rate limit.",
      status: 429,
      requestId: "req_platform",
      code: "organization_rate_limited",
    });
    expect(api.received).toEqual(["GET /v1/projects"]);
  });

  it("returns an identity slow_down 429 without a resend", async () => {
    const api = platformApi([IDENTITY_SLOW_DOWN], PROJECT);

    const problem = await problemOf(
      api.sdk.request({ method: "POST", path: "/v1/device-authorizations/token", body: {} }),
    );

    expect(problem).toEqual({ title: "Too Many Requests", status: 429, requestId: "req_header" });
    expect(api.received).toEqual(["POST /v1/device-authorizations/token {}"]);
  });

  it("returns the gateway's 429 after five throttled resends", async () => {
    const api = platformApi([], GATEWAY_THROTTLE);

    const problem = await problemOf(api.sdk.request({ method: "GET", path: "/v1/projects" }));

    expect(problem).toEqual({ title: "Too Many Requests", status: 429, requestId: "req_header" });
    expect(api.received).toHaveLength(6);
  }, 15_000);

  it("stops waiting to resend when the caller aborts", async () => {
    const caller = new AbortController();
    let abortedAt = 0;
    const api = platformApi([], GATEWAY_THROTTLE, (count) => {
      if (count !== 3) return;
      // The abort has to land after the third answer arrives, inside the real 1 s resend wait.
      setTimeout(() => {
        abortedAt = performance.now();
        caller.abort();
      }, 50);
    });

    const failure = await api.sdk
      .request({ method: "GET", path: "/v1/projects", signal: caller.signal })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PlatformTransportError);
    expect(api.received).toHaveLength(3);
    expect(performance.now() - abortedAt).toBeLessThan(300);
  });

  it("stops before a resend when the caller already aborted and fetch ignored the signal", async () => {
    const reason = new Error("caller gave up");
    let sends = 0;
    const sdk = createPlatformSdk({
      baseUrl: "https://api.example.test",
      fetch: (async () => {
        sends += 1;
        return new Response(GATEWAY_THROTTLE.body, {
          headers: { "content-type": GATEWAY_THROTTLE.contentType },
          status: GATEWAY_THROTTLE.status,
        });
      }) as unknown as typeof fetch,
    });

    const failure = await sdk
      .request({ method: "GET", path: "/v1/projects", signal: AbortSignal.abort(reason) })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PlatformTransportError);
    expect(failure instanceof Error ? failure.cause : undefined).toBe(reason);
    expect(sends).toBe(1);
  }, 15_000);

  it("stops a wait when the abort lands while the throttled answer is discarded", async () => {
    const caller = new AbortController();
    let abortedAt = 0;
    let sends = 0;
    const sdk = createPlatformSdk({
      baseUrl: "https://api.example.test",
      fetch: (async () => {
        sends += 1;
        const response = new Response(GATEWAY_THROTTLE.body, {
          headers: { "content-type": GATEWAY_THROTTLE.contentType },
          status: GATEWAY_THROTTLE.status,
        });
        if (sends !== 4) return response;
        const discarded = new ReadableStream({
          cancel() {
            abortedAt = performance.now();
            caller.abort();
          },
        });
        return Object.defineProperty(response, "body", { get: () => discarded });
      }) as unknown as typeof fetch,
    });

    const failure = await sdk
      .request({ method: "GET", path: "/v1/projects", signal: caller.signal })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PlatformTransportError);
    expect(failure instanceof Error && failure.cause instanceof Error && failure.cause.name).toBe(
      "AbortError",
    );
    expect(sends).toBe(4);
    // Without the check the 2 s wait after the fourth answer runs to its end.
    expect(performance.now() - abortedAt).toBeLessThan(1_000);
  }, 15_000);
});
