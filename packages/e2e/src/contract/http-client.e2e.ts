import { expect, it } from "@effect/vitest";
import { createServer } from "node:http";
import { Effect } from "effect";
import {
  E2eHttpClient,
  fetchResendingGatewayThrottles,
  httpClientLayer,
} from "../harness/http-client.ts";

interface CannedResponse {
  readonly body: string;
  readonly contentType: string;
  readonly status: number;
}

const GATEWAY_THROTTLE: CannedResponse = {
  body: '{"message":"Too Many Requests"}',
  contentType: "application/json",
  status: 429,
};
const PLATFORM_UNAUTHORIZED: CannedResponse = {
  body: '{"status":401,"title":"Unauthorized"}',
  contentType: "application/problem+json",
  status: 401,
};
const PLATFORM_THROTTLE: CannedResponse = {
  body: '{"status":429,"title":"Too Many Requests"}',
  contentType: "application/problem+json",
  status: 429,
};
const IDENTITY_SLOW_DOWN: CannedResponse = {
  body: '{"error":"slow_down","error_description":"Too many authentication requests."}',
  contentType: "application/json",
  status: 429,
};

/** Serves `leading` in order, then `then` for every later request, and records each request. */
const cannedServer = (leading: readonly CannedResponse[], then: CannedResponse) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const received: string[] = [];
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const canned = leading.at(received.length) ?? then;
          received.push(`${request.method} ${request.url} ${Buffer.concat(chunks).toString()}`);
          response.writeHead(canned.status, { "content-type": canned.contentType });
          response.end(canned.body);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("The canned server did not bind a TCP port.");
      }
      return { origin: `http://127.0.0.1:${String(address.port)}`, received, server };
    }),
    ({ server }) =>
      Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

const probe = (origin: string) =>
  Effect.gen(function* () {
    const http = yield* E2eHttpClient;
    return yield* http.request({ body: {}, method: "POST", path: "/v1/organizations" });
  }).pipe(Effect.provide(httpClientLayer(origin)));

it.effect("resends a request API Gateway throttled until the route answers", () =>
  Effect.gen(function* () {
    const server = yield* cannedServer([GATEWAY_THROTTLE, GATEWAY_THROTTLE], PLATFORM_UNAUTHORIZED);
    const result = yield* probe(server.origin);
    expect({ body: result.body, status: result.status }).toEqual({
      body: '{"status":401,"title":"Unauthorized"}',
      status: 401,
    });
    expect(server.received).toEqual([
      "POST /v1/organizations {}",
      "POST /v1/organizations {}",
      "POST /v1/organizations {}",
    ]);
  }),
);

it.effect("returns the platform's own 429 without resending it", () =>
  Effect.gen(function* () {
    const server = yield* cannedServer([PLATFORM_THROTTLE], PLATFORM_UNAUTHORIZED);
    const result = yield* probe(server.origin);
    expect({ body: result.body, status: result.status }).toEqual({
      body: '{"status":429,"title":"Too Many Requests"}',
      status: 429,
    });
    expect(server.received).toEqual(["POST /v1/organizations {}"]);
  }),
);

it.effect("returns the identity service's own 429 without resending it", () =>
  Effect.gen(function* () {
    const server = yield* cannedServer([IDENTITY_SLOW_DOWN], PLATFORM_UNAUTHORIZED);
    const result = yield* probe(server.origin);
    expect({ body: result.body, status: result.status }).toEqual({
      body: '{"error":"slow_down","error_description":"Too many authentication requests."}',
      status: 429,
    });
    expect(server.received).toEqual(["POST /v1/organizations {}"]);
  }),
);

it.effect(
  "returns API Gateway's 429 once five resends are also throttled",
  () =>
    Effect.gen(function* () {
      const server = yield* cannedServer([], GATEWAY_THROTTLE);
      const result = yield* probe(server.origin);
      expect({ body: result.body, status: result.status }).toEqual({
        body: '{"message":"Too Many Requests"}',
        status: 429,
      });
      expect(server.received).toHaveLength(6);
    }),
  20_000,
);

it.effect("resends a direct fetch with its body and returns the answer readable", () =>
  Effect.gen(function* () {
    const server = yield* cannedServer([GATEWAY_THROTTLE], IDENTITY_SLOW_DOWN);
    const answer = yield* Effect.promise(async () => {
      const response = await fetchResendingGatewayThrottles(
        new URL("/v1/auth/sign-in", server.origin),
        {
          body: new TextEncoder().encode('{"email":"e2e@example.com"}'),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      return { body: await response.text(), status: response.status };
    });
    expect(answer).toEqual({
      body: '{"error":"slow_down","error_description":"Too many authentication requests."}',
      status: 429,
    });
    expect(server.received).toEqual([
      'POST /v1/auth/sign-in {"email":"e2e@example.com"}',
      'POST /v1/auth/sign-in {"email":"e2e@example.com"}',
    ]);
  }),
);
