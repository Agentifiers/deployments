import {
  StreamContractError,
  StreamSessionExpiredError,
  durableStreamHeaders,
  durableStreamReadUrl,
  proxyDurableStreamResponse,
  threadStreamPath,
  verifyThreadStreamSessionToken,
} from "@deployments-ai/streaming";
import { preflightResponse, withCors } from "./cors.ts";

/** Canonical uppercase Crockford ULID, matching `@deployments-ai/db` `Ulid`. */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const THREAD_STREAM_ROUTE = /^\/v1\/threads\/([^/]+)\/stream$/u;

export interface StreamGatewayOptions {
  readonly allowedOrigins: readonly string[];
  readonly durableAuthToken: string;
  readonly durableBaseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly sessionTokenSecret: string;
  /** Aborts every in-flight upstream read, e.g. when the task is draining. */
  readonly shutdownSignal?: AbortSignal;
}

class StreamGatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StreamGatewayError";
  }
}

const ROUTE_NOT_FOUND = new StreamGatewayError(
  404,
  "route_not_found",
  "The requested API route does not exist.",
);

function gatewayError(cause: unknown): StreamGatewayError {
  if (cause instanceof StreamGatewayError) return cause;
  if (cause instanceof StreamSessionExpiredError) {
    return new StreamGatewayError(401, "stream_session_expired", cause.message);
  }
  if (cause instanceof StreamContractError) {
    return cause.field.startsWith("sessionToken")
      ? new StreamGatewayError(401, "invalid_stream_token", cause.message)
      : new StreamGatewayError(400, "invalid_stream_request", cause.message);
  }
  return new StreamGatewayError(500, "internal_error", "Internal server error.");
}

function problem(error: StreamGatewayError, requestId: string | null) {
  return Response.json(
    {
      code: error.code,
      detail: error.message,
      ...(requestId ? { requestId } : {}),
      status: error.status,
      title: error.code.replaceAll("_", " "),
      type: `https://docs.deployments.ai/errors/${error.code.replaceAll("_", "-")}`,
    },
    {
      headers: { "cache-control": "no-store", "content-type": "application/problem+json" },
      status: error.status,
    },
  );
}

function optionalQuery(url: URL, name: string) {
  return url.searchParams.has(name) ? (url.searchParams.get(name) ?? "") : undefined;
}

export function createStreamGateway(options: StreamGatewayOptions) {
  const fetchUpstream = options.fetch ?? globalThis.fetch;

  async function readThreadStream(request: Request, url: URL, rawThreadId: string) {
    if (!ULID_PATTERN.test(rawThreadId)) {
      throw new StreamGatewayError(400, "invalid_id", "threadId must be a canonical ULID.");
    }
    const token = request.headers
      .get("authorization")
      ?.match(/^Bearer\s+(.+)$/iu)?.[1]
      ?.trim();
    if (!token) {
      throw new StreamGatewayError(
        401,
        "unauthorized",
        "A stream session bearer token is required.",
      );
    }
    const claims = verifyThreadStreamSessionToken(token, {
      ...(options.now ? { now: options.now() } : {}),
      secret: options.sessionTokenSecret,
    });
    if (claims.threadId !== rawThreadId) {
      throw new StreamGatewayError(
        403,
        "stream_scope_violation",
        "The stream token does not match this thread.",
      );
    }
    if (!claims.permissions.includes("read")) {
      throw new StreamGatewayError(
        403,
        "stream_scope_violation",
        "The stream token does not permit reads.",
      );
    }
    const live = optionalQuery(url, "live");
    if (live !== undefined && live !== "long-poll" && live !== "sse") {
      throw new StreamGatewayError(
        400,
        "invalid_stream_request",
        "live must be long-poll or sse when provided.",
      );
    }
    const cursor = optionalQuery(url, "cursor");
    const offset = optionalQuery(url, "offset");
    const upstreamUrl = durableStreamReadUrl({
      allowInsecurePrivateHttp: true,
      baseUrl: options.durableBaseUrl,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(live !== undefined ? { live } : {}),
      ...(offset !== undefined ? { offset } : {}),
      streamPath: threadStreamPath(claims),
    });
    const signal = options.shutdownSignal
      ? AbortSignal.any([request.signal, options.shutdownSignal])
      : request.signal;
    let upstream: Response;
    try {
      upstream = await fetchUpstream(upstreamUrl, {
        headers: durableStreamHeaders({ authToken: options.durableAuthToken }),
        signal,
      });
    } catch (cause) {
      if (!signal.aborted) console.error("Durable Streams read failed.", { cause });
      throw new StreamGatewayError(
        503,
        "stream_unavailable",
        "The thread stream is temporarily unavailable.",
      );
    }
    return proxyDurableStreamResponse(upstream);
  }

  async function respond(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get("x-request-id");
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        return new Response("ok", {
          headers: { "cache-control": "no-store", "content-type": "text/plain" },
        });
      }
      const match = THREAD_STREAM_ROUTE.exec(url.pathname);
      if (request.method !== "GET" || !match) return problem(ROUTE_NOT_FOUND, requestId);
      return await readThreadStream(request, url, match[1]!);
    } catch (cause) {
      const error = gatewayError(cause);
      if (error.status >= 500 && error.code !== "stream_unavailable") {
        console.error("Stream gateway request failed.", { cause, path: url.pathname, requestId });
      }
      return problem(error, requestId);
    }
  }

  return async function handle(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      const preflight = THREAD_STREAM_ROUTE.test(new URL(request.url).pathname)
        ? preflightResponse(request, options.allowedOrigins)
        : undefined;
      return preflight ?? problem(ROUTE_NOT_FOUND, request.headers.get("x-request-id"));
    }
    return withCors(await respond(request), request.headers.get("origin"), options.allowedOrigins);
  };
}
