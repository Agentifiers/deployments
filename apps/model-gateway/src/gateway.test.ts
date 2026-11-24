import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { ModelGatewayRunLease } from "@deployments-ai/db";
import type {
  ModelGatewayRunTokenClaims,
  ModelGatewayServiceTokenClaims,
} from "@deployments-ai/model-gateway";
import { MAX_REQUEST_BODY_BYTES } from "./gateway.ts";
import {
  ALLOWED_MODEL,
  EMBEDDING_MODEL,
  FALLBACK_MODEL,
  PROVIDER_API_KEY,
  TRUSTED_KEY_ARN,
  p256KeyPair,
  runClaims,
  runLease,
  serviceClaims,
  signToken,
  startFakeBifrost,
  startGateway,
} from "./test-support.ts";

const keys = p256KeyPair();
const bifrost = startFakeBifrost();
let logStart = 0;
const usageLogs = () =>
  gateway.logs.slice(logStart).filter((entry) => entry.event === "model_gateway.usage");
const gateway = startGateway({ bifrostUrl: bifrost.url, publicKey: keys.publicKey });
const responseTexts: string[] = [];

afterAll(() => {
  // Nothing the gateway returned or logged during the whole suite may carry a secret.
  const observed = [...responseTexts, ...gateway.logs.map((entry) => JSON.stringify(entry))];
  for (const text of observed) {
    expect(text).not.toContain(gateway.internalVirtualKey);
    expect(text).not.toContain(PROVIDER_API_KEY);
  }
  void gateway.server.stop(true);
  void bifrost.server.stop(true);
});

beforeEach(() => {
  // A monotonic clock an hour apart per test gives every test a fresh run-activity cache window.
  gateway.clock.now += 3_600_000;
  gateway.leases.value = runLease({
    expiresAt: new Date(gateway.clock.now + 60_000).toISOString(),
  });
  gateway.leases.reads = 0;
  gateway.kms.fail = false;
  logStart = gateway.logs.length;
  bifrost.requests.length = 0;
  bifrost.state.respond = (request) =>
    Response.json({
      id: "chatcmpl-1",
      model: request.body.model,
      usage: { completion_tokens: 7, prompt_tokens: 11, total_tokens: 18 },
    });
});

function runToken(overrides: Partial<ModelGatewayRunTokenClaims> = {}) {
  return signToken(runClaims(gateway.clock.now, overrides), keys.privateKey);
}

function serviceToken(overrides: Partial<ModelGatewayServiceTokenClaims> = {}) {
  return signToken(serviceClaims(gateway.clock.now, overrides), keys.privateKey);
}

async function call(
  path: string,
  init: {
    body?: unknown;
    headers?: Record<string, string>;
    keepalive?: boolean;
    method?: string;
    token?: string;
  },
) {
  const body =
    typeof init.body === "string" || init.body instanceof ReadableStream
      ? init.body
      : JSON.stringify(init.body);
  const response = await fetch(`${gateway.url}${path}`, {
    method: init.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...init.headers,
    },
    ...(init.body !== undefined ? { body } : {}),
    ...(init.keepalive !== undefined ? { keepalive: init.keepalive } : {}),
  });
  const text = await response.text();
  responseTexts.push(text);
  return { headers: response.headers, status: response.status, text };
}

interface GatewayErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly type: string };
}

function errorCode(text: string) {
  const body: GatewayErrorBody = JSON.parse(text);
  return body.error;
}

const chat = (model: string = ALLOWED_MODEL, extra: Record<string, unknown> = {}) => ({
  messages: [{ content: "hello", role: "user" }],
  model,
  ...extra,
});

describe("routing and health", () => {
  test("unknown paths and methods are 404", async () => {
    for (const [method, path] of [
      ["POST", "/v1/completions"],
      ["GET", "/v1/responses"],
      ["GET", "/v1/chat/completions"],
      ["POST", "/api/governance/virtual-keys"],
      ["GET", "/"],
    ] as const) {
      const response = await call(path, { method, token: serviceToken() });
      expect(response.status).toBe(404);
      expect(errorCode(response.text)).toEqual({
        code: "not_found",
        message: "Not found.",
        type: "model_gateway_error",
      });
    }
    expect(bifrost.requests).toHaveLength(0);
  });

  test("/livez is always up and /health follows Bifrost", async () => {
    expect((await call("/livez", { method: "GET" })).status).toBe(200);
    expect((await call("/health", { method: "GET" })).status).toBe(200);

    const down = startGateway({ bifrostUrl: "http://127.0.0.1:1", publicKey: keys.publicKey });
    try {
      const response = await fetch(`${down.url}/health`);
      expect(response.status).toBe(503);
      expect((await fetch(`${down.url}/livez`)).status).toBe(200);
    } finally {
      void down.server.stop(true);
    }
  });
});

describe("token verification", () => {
  test("a missing or non-bearer token is 401 missing_token", async () => {
    for (const headers of [{}, { authorization: "Basic abc" }, { authorization: "Bearer" }]) {
      const response = await call("/v1/chat/completions", { body: chat(), headers });
      expect(response.status).toBe(401);
      expect(errorCode(response.text).code).toBe("missing_token");
    }
  });

  test("bad signature, expired, wrong audience, and untrusted keys are 401", async () => {
    const other = p256KeyPair();
    const cases: [string, string][] = [
      [signToken(runClaims(gateway.clock.now), other.privateKey), "bad_signature"],
      [
        runToken({
          exp: Math.floor(gateway.clock.now / 1000) - 60,
          iat: Math.floor(gateway.clock.now / 1000) - 600,
        }),
        "expired",
      ],
      [
        signToken({ ...runClaims(gateway.clock.now), aud: "bifrost" }, keys.privateKey),
        "wrong_audience",
      ],
      [
        signToken(runClaims(gateway.clock.now), keys.privateKey, `${TRUSTED_KEY_ARN}0`),
        "unknown_key",
      ],
      ["not-a-jwt", "malformed"],
    ];
    for (const [token, reason] of cases) {
      const response = await call("/v1/chat/completions", { body: chat(), token });
      expect(response.status).toBe(401);
      expect(errorCode(response.text)).toMatchObject({ code: reason, type: "model_gateway_error" });
    }
    expect(bifrost.requests).toHaveLength(0);
    expect(gateway.kmsCalls.every((arn) => arn === TRUSTED_KEY_ARN)).toBe(true);
  });

  test("a KMS failure is 502 signing_key_unavailable and is not cached", async () => {
    const isolated = startGateway({ bifrostUrl: bifrost.url, publicKey: keys.publicKey });
    try {
      isolated.kms.fail = true;
      const token = signToken(serviceClaims(isolated.clock.now), keys.privateKey);
      const send = () =>
        fetch(`${isolated.url}/v1/chat/completions`, {
          body: JSON.stringify(chat()),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          method: "POST",
        });
      const failed = await send();
      expect(failed.status).toBe(502);
      expect(errorCode(await failed.text()).code).toBe("signing_key_unavailable");
      isolated.kms.fail = false;
      expect((await send()).status).toBe(200);
      expect((await send()).status).toBe(200);
      expect(isolated.kmsCalls).toEqual([TRUSTED_KEY_ARN, TRUSTED_KEY_ARN]);
    } finally {
      void isolated.server.stop(true);
    }
  });
});

describe("request validation and model authorization", () => {
  test("a foreign primary or fallback model is 403 model_not_allowed", async () => {
    for (const body of [
      chat("openai/gpt-5"),
      chat(ALLOWED_MODEL, {
        fallbacks: [FALLBACK_MODEL, "bedrock/us.anthropic.claude-opus-4-1-20250805-v1:0"],
      }),
    ]) {
      const response = await call("/v1/chat/completions", { body, token: runToken() });
      expect(response.status).toBe(403);
      expect(errorCode(response.text).code).toBe("model_not_allowed");
    }
    expect(bifrost.requests).toHaveLength(0);
    expect(gateway.leases.reads).toBe(0);
  });

  test("invalid bodies and model ids are 400 invalid_request", async () => {
    for (const body of [
      "{not json",
      "[]",
      { messages: [] },
      chat(""),
      chat("bedrock/"),
      chat(ALLOWED_MODEL, { fallbacks: "openai/gpt-4o" }),
      chat(ALLOWED_MODEL, { fallbacks: [42] }),
    ]) {
      const response = await call("/v1/chat/completions", { body, token: serviceToken() });
      expect(response.status).toBe(400);
      expect(errorCode(response.text).code).toBe("invalid_request");
    }
    expect(bifrost.requests).toHaveLength(0);
  });

  test("a body over 32 MiB is 413 request_too_large, declared or streamed", async () => {
    const oversized = JSON.stringify({
      input: "x".repeat(MAX_REQUEST_BODY_BYTES),
      model: EMBEDDING_MODEL,
    });
    const chunk = new TextEncoder().encode("x".repeat(1024 * 1024));
    let sent = 0;
    const streamed = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ > 40) controller.close();
        else controller.enqueue(chunk);
      },
    });
    // Bun's fetch client cannot reuse a socket whose upload the server stopped reading.
    for (const body of [oversized, streamed]) {
      const response = await call("/v1/embeddings", {
        body,
        keepalive: false,
        token: serviceToken(),
      });
      expect(response.status).toBe(413);
      expect(response.headers.get("connection")).toBe("close");
      expect(errorCode(response.text).code).toBe("request_too_large");
    }
    expect(bifrost.requests).toHaveLength(0);
  });
});

describe("run activity", () => {
  const inactiveLeases = (now: number): Record<string, ModelGatewayRunLease | undefined> => ({
    "lease missing": undefined,
    "held by another owner": runLease({
      expiresAt: new Date(now + 60_000).toISOString(),
      owner: "worker-b/claim-9",
    }),
    "held by another run": runLease({
      expiresAt: new Date(now + 60_000).toISOString(),
      runId: "01ARZ3NDEKTSV4RRFFQ69G0099",
    }),
    expired: runLease({ expiresAt: new Date(now - 1).toISOString() }),
  });

  for (const name of Object.keys(inactiveLeases(0))) {
    test(`a run token is 403 run_inactive when the lease is ${name}`, async () => {
      gateway.leases.value = inactiveLeases(gateway.clock.now)[name];
      const response = await call("/v1/chat/completions", { body: chat(), token: runToken() });
      expect(response.status).toBe(403);
      expect(errorCode(response.text).code).toBe("run_inactive");
      expect(bifrost.requests).toHaveLength(0);
    });
  }

  test("lease answers are cached for five seconds per run and never past the lease expiry", async () => {
    const leaseExpiry = gateway.clock.now + 60_000;
    gateway.leases.value = runLease({ expiresAt: new Date(leaseExpiry).toISOString() });
    expect((await call("/v1/chat/completions", { body: chat(), token: runToken() })).status).toBe(
      200,
    );
    gateway.leases.value = runLease({
      expiresAt: new Date(leaseExpiry).toISOString(),
      owner: "worker-b",
    });
    gateway.clock.now += 4_999;
    expect((await call("/v1/chat/completions", { body: chat(), token: runToken() })).status).toBe(
      200,
    );
    expect(gateway.leases.reads).toBe(1);
    gateway.clock.now += 2;
    const revoked = await call("/v1/chat/completions", { body: chat(), token: runToken() });
    expect(revoked.status).toBe(403);
    expect(gateway.leases.reads).toBe(2);

    gateway.clock.now += 3_600_000;
    gateway.leases.value = runLease({
      expiresAt: new Date(gateway.clock.now + 1_000).toISOString(),
    });
    expect((await call("/v1/chat/completions", { body: chat(), token: runToken() })).status).toBe(
      200,
    );
    gateway.clock.now += 1_000;
    expect((await call("/v1/chat/completions", { body: chat(), token: runToken() })).status).toBe(
      403,
    );
    expect(gateway.leases.reads).toBe(4);
  });

  test("a lease read failure is 502 run_state_unavailable and is not cached", async () => {
    gateway.leases.value = new Error("DynamoDB throttled");
    const failed = await call("/v1/chat/completions", { body: chat(), token: runToken() });
    expect(failed.status).toBe(502);
    expect(errorCode(failed.text).code).toBe("run_state_unavailable");
    expect(bifrost.requests).toHaveLength(0);
    gateway.leases.value = runLease({
      expiresAt: new Date(gateway.clock.now + 60_000).toISOString(),
    });
    expect((await call("/v1/chat/completions", { body: chat(), token: runToken() })).status).toBe(
      200,
    );
    expect(gateway.leases.reads).toBe(2);
  });

  test("service tokens never read the lease", async () => {
    gateway.leases.value = new Error("must not be read");
    expect(
      (await call("/v1/chat/completions", { body: chat(), token: serviceToken() })).status,
    ).toBe(200);
    expect(gateway.leases.reads).toBe(0);
  });
});

describe("forwarding", () => {
  test("a valid run token forwards with only allowlisted headers plus the internal key", async () => {
    const upstreamBody = '{"id":"chatcmpl-9",  "choices":[],"usage":{"prompt_tokens":3}}';
    bifrost.state.respond = () =>
      new Response(upstreamBody, {
        headers: { "content-type": "application/json", "x-bf-debug": "1" },
      });
    const response = await call("/v1/chat/completions", {
      body: chat("gpt-4o-mini", { fallbacks: [` ${FALLBACK_MODEL}`] }),
      headers: {
        accept: "application/json",
        cookie: "session=1",
        "x-bf-passthrough-extra-params": "true",
        "x-bf-vk": "sk-bf-caller-supplied-key-value",
        "x-forwarded-for": "10.0.0.1",
      },
      token: runToken(),
    });
    expect(response.status).toBe(200);
    expect(response.text).toBe(upstreamBody);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-bf-debug")).toBeNull();

    const [forwarded] = bifrost.requests;
    expect(forwarded?.path).toBe("/v1/chat/completions");
    expect(forwarded?.headers["x-bf-vk"]).toBe(gateway.internalVirtualKey);
    expect(forwarded?.headers.authorization).toBeUndefined();
    expect(forwarded?.headers.cookie).toBeUndefined();
    expect(forwarded?.headers["x-forwarded-for"]).toBeUndefined();
    expect(forwarded?.headers["x-bf-passthrough-extra-params"]).toBe("true");
    expect(forwarded?.headers.accept).toBe("application/json");
    expect(forwarded?.body).toMatchObject({ fallbacks: [FALLBACK_MODEL], model: ALLOWED_MODEL });
    expect(usageLogs()).toHaveLength(0);
  });

  test("a streamed response is byte-identical and incremental, then records service usage", async () => {
    const first = 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n';
    const rest = [
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2,"cost":0.0004}}\n\n',
      "data: [DONE]\n\n",
    ];
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const encoder = new TextEncoder();
    bifrost.state.respond = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(first));
            await released;
            for (const chunk of rest) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      body: JSON.stringify(chat(ALLOWED_MODEL, { stream: true })),
      headers: { authorization: `Bearer ${serviceToken()}`, "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const received: Uint8Array[] = [];
    const firstRead = await reader.read();
    received.push(firstRead.value!);
    expect(new TextDecoder().decode(firstRead.value)).toBe(first);
    expect(usageLogs()).toHaveLength(0);
    release();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received.push(value);
    }
    const text = Buffer.concat(received).toString("utf8");
    responseTexts.push(text);
    expect(text).toBe(first + rest.join(""));

    const usage = usageLogs();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      InputTokens: 11,
      OutputTokens: 2,
      Requests: 1,
      Service: "memory",
      _aws: {
        CloudWatchMetrics: [
          {
            Dimensions: [["Service"]],
            Metrics: [
              { Name: "Requests", Unit: "Count" },
              { Name: "InputTokens", Unit: "Count" },
              { Name: "OutputTokens", Unit: "Count" },
            ],
            Namespace: "DeploymentsAi/ModelGateway",
          },
        ],
      },
      costUsdMicros: 400,
      endpoint: "/v1/chat/completions",
      model: ALLOWED_MODEL,
      organizationId: "01ARZ3NDEKTSV4RRFFQ69G0004",
      outcome: "completed",
      service: "memory",
      status: 200,
    });
  });

  test("a JSON service response records usage once; run tokens record none", async () => {
    const embeddings = await call("/v1/embeddings", {
      body: { input: ["a"], model: EMBEDDING_MODEL },
      token: serviceToken(),
    });
    expect(embeddings.status).toBe(200);
    expect(bifrost.requests[0]?.path).toBe("/v1/embeddings");
    expect(usageLogs()).toHaveLength(1);
    expect(usageLogs()[0]).toMatchObject({
      InputTokens: 11,
      OutputTokens: 7,
      endpoint: "/v1/embeddings",
      model: EMBEDDING_MODEL,
    });

    expect((await call("/v1/chat/completions", { body: chat(), token: runToken() })).status).toBe(
      200,
    );
    expect(usageLogs()).toHaveLength(1);
  });

  test("Responses API calls are model-checked, forwarded, and metered from JSON usage", async () => {
    const denied = await call("/v1/responses", {
      body: { input: "hi", model: "openai/gpt-5" },
      token: serviceToken(),
    });
    expect(denied.status).toBe(403);
    expect(errorCode(denied.text).code).toBe("model_not_allowed");
    const deniedFallback = await call("/v1/responses", {
      body: { fallbacks: ["openai/gpt-5"], input: "hi", model: ALLOWED_MODEL },
      token: serviceToken(),
    });
    expect(deniedFallback.status).toBe(403);
    expect(bifrost.requests).toHaveLength(0);

    bifrost.state.respond = () =>
      Response.json({
        object: "response",
        output: [],
        usage: { input_tokens: 21, output_tokens: 5, total_tokens: 26 },
      });
    const response = await call("/v1/responses", {
      body: { input: "hi", model: "gpt-4o-mini" },
      token: serviceToken(),
    });
    expect(response.status).toBe(200);
    const [forwarded] = bifrost.requests;
    expect(forwarded?.path).toBe("/v1/responses");
    expect(forwarded?.headers["x-bf-vk"]).toBe(gateway.internalVirtualKey);
    expect(forwarded?.headers.authorization).toBeUndefined();
    expect(forwarded?.body).toMatchObject({ input: "hi", model: ALLOWED_MODEL });
    expect(usageLogs()).toHaveLength(1);
    expect(usageLogs()[0]).toMatchObject({
      InputTokens: 21,
      OutputTokens: 5,
      endpoint: "/v1/responses",
      model: ALLOWED_MODEL,
      outcome: "completed",
    });
  });

  test("a streamed Responses API call is byte-identical and metered from response.completed", async () => {
    const events = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","usage":null}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":13,"output_tokens":4,"total_tokens":17}}}\n\n',
    ];
    bifrost.state.respond = () =>
      new Response(events.join(""), { headers: { "content-type": "text/event-stream" } });
    const response = await call("/v1/responses", {
      body: { input: "hi", model: ALLOWED_MODEL, stream: true },
      token: serviceToken(),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.text).toBe(events.join(""));
    expect(usageLogs()).toHaveLength(1);
    expect(usageLogs()[0]).toMatchObject({
      InputTokens: 13,
      OutputTokens: 4,
      endpoint: "/v1/responses",
      Service: "memory",
    });
  });

  test("upstream error bodies keep their status but never echo the internal or provider key", async () => {
    bifrost.state.respond = (request) =>
      Response.json(
        {
          error: {
            message: `virtual key ${request.headers["x-bf-vk"]} rejected; provider said: Incorrect API key ${PROVIDER_API_KEY}; Authorization: Bearer ${PROVIDER_API_KEY}`,
          },
        },
        { status: 401 },
      );
    const response = await call("/v1/chat/completions", { body: chat(), token: serviceToken() });
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.text).toContain("[redacted]");
    expect(response.text).not.toContain(gateway.internalVirtualKey);
    expect(response.text).not.toContain(PROVIDER_API_KEY);
  });

  test("an unreachable Bifrost is 502 upstream_unavailable", async () => {
    const isolated = startGateway({ bifrostUrl: "http://127.0.0.1:1", publicKey: keys.publicKey });
    try {
      const response = await fetch(`${isolated.url}/v1/chat/completions`, {
        body: JSON.stringify(chat()),
        headers: {
          authorization: `Bearer ${signToken(serviceClaims(isolated.clock.now), keys.privateKey)}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      expect(response.status).toBe(502);
      expect(errorCode(await response.text()).code).toBe("upstream_unavailable");
    } finally {
      void isolated.server.stop(true);
    }
  });

  test("request logs carry identifiers but no tokens", async () => {
    const token = serviceToken();
    await call("/v1/chat/completions", { body: chat(), token });
    const entry = gateway.logs.findLast((log) => log.event === "model_gateway.request");
    expect(entry).toMatchObject({
      method: "POST",
      model: ALLOWED_MODEL,
      path: "/v1/chat/completions",
      service: "memory",
      status: 200,
      tokenKind: "service",
    });
    expect(gateway.logs.map((log) => JSON.stringify(log)).join("\n")).not.toContain(
      token.split(".")[2]!,
    );
  });
});
