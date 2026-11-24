import { Context, Effect, Layer } from "effect";
import { setTimeout as delay } from "node:timers/promises";
import { HttpRequestError } from "./errors.ts";

const MAX_RESPONSE_BYTES = 6 * 1_024 * 1_024;
const GATEWAY_THROTTLE_RESEND_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const;

export interface HttpRequest {
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method: string;
  readonly path: string;
  readonly timeoutMs?: number;
}

export interface HttpResult {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly json: unknown;
  readonly status: number;
}

export interface E2eHttpClientService {
  readonly request: (request: HttpRequest) => Effect.Effect<HttpResult, HttpRequestError>;
}

export class E2eHttpClient extends Context.Service<E2eHttpClient, E2eHttpClientService>()(
  "@deployments-ai/e2e/HttpClient",
) {}

function parseJson(body: string): unknown {
  if (!body.trim()) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Both API Gateway flavors answer a throttled request with this body before any integration
 * runs. The platform's problem+json 429 and the identity service's `slow_down` 429 come from
 * the integration and have other bodies.
 */
function isGatewayThrottleBody(body: string): boolean {
  const json = parseJson(body);
  return (
    typeof json === "object" &&
    json !== null &&
    "message" in json &&
    json.message === "Too Many Requests"
  );
}

/**
 * `fetch` that resends a request API Gateway throttled, which is safe for any method because
 * the route never ran. After the last resend it returns whatever answered. `init.signal`
 * bounds the whole exchange, waits included, and `init.body` must be replayable.
 */
export async function fetchResendingGatewayThrottles(
  url: URL | string,
  init: RequestInit = {},
): Promise<Response> {
  let response = await fetch(url, init);
  for (const delayMs of GATEWAY_THROTTLE_RESEND_DELAYS_MS) {
    if (response.status !== 429) return response;
    const body = await response.text();
    if (!isGatewayThrottleBody(body)) {
      return new Response(body, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    }
    await delay(delayMs, undefined, init.signal ? { signal: init.signal } : {});
    response = await fetch(url, init);
  }
  return response;
}

export function httpClientLayer(baseUrl: string): Layer.Layer<E2eHttpClient> {
  const normalizedBase = new URL(baseUrl);
  normalizedBase.pathname = normalizedBase.pathname.replace(/\/$/u, "");
  return Layer.succeed(E2eHttpClient, {
    request: (request) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetchResendingGatewayThrottles(
            new URL(request.path, normalizedBase),
            {
              method: request.method,
              headers: {
                ...(request.body === undefined ? {} : { "content-type": "application/json" }),
                ...request.headers,
              },
              ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
              signal: AbortSignal.timeout(request.timeoutMs ?? 30_000),
            },
          );
          const body = await response.text();
          if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
            throw new Error(`HTTP response exceeded ${String(MAX_RESPONSE_BYTES)} bytes.`);
          }
          return {
            body,
            headers: Object.fromEntries(response.headers.entries()),
            json: parseJson(body),
            status: response.status,
          };
        },
        catch: (cause) =>
          new HttpRequestError({
            cause,
            message: `${request.method} ${request.path} failed before receiving a response.`,
          }),
      }),
  });
}
