import type { ProblemDetails } from "@deployments-ai/api-contract/primitives";
import type { CreateArtifactUploadResponse } from "@deployments-ai/api-contract/runtime";
import { createAgentEmailSdk, type AgentEmailContext, type AgentEmailSdk } from "./agent-email.ts";
import { durableStreamSseBatches } from "./durable-stream-sse.ts";
import { createEmailSdk, type EmailContext, type EmailSdk } from "./email.ts";
import { resendGatewayThrottles } from "./gateway-throttle.ts";
import {
  createEvaluationsSdk,
  type EvaluationsContext,
  type EvaluationsSdk,
} from "./evaluations.ts";
import { createMemorySdk, type MemoryContext, type MemorySdk } from "./memory.ts";
import {
  createObservabilitySdk,
  type ObservabilityContext,
  type ObservabilitySdk,
} from "./observability.ts";
import { createRuntimeSdk, type RuntimeContext, type RuntimeSdk } from "./runtime.ts";
export * from "./memory.ts";
export * from "./runtime.ts";
export * from "./observability.ts";
export * from "./evaluations.ts";
export * from "./email.ts";
export * from "./brain-upload.ts";
export { MOCK_TENANCY_CONTEXT, MOCK_TENANCY_FIXTURE_IDS } from "./tenancy-mock.ts";
export { emailEndUserId } from "@deployments-ai/agent-email";
export type { ProblemDetails } from "@deployments-ai/api-contract/primitives";

export interface PlatformContext {
  readonly organizationId?: string;
  readonly projectId?: string;
  readonly environmentId?: string;
  readonly workspaceId?: string;
}

export interface PlatformRequest {
  readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  readonly path: string;
  readonly context?: PlatformContext;
  readonly query?: Readonly<Record<string, boolean | number | string | undefined>>;
  readonly body?: unknown;
  readonly contentType?: string;
  readonly rawBody?: Uint8Array;
  readonly idempotencyKey?: string;
  /** Override the SDK credential for this request, such as with a stream-session token. */
  readonly bearerToken?: string;
  /**
   * Origin serving this request instead of the configured API, such as the stream gateway origin
   * of a session's `streamUrl`. Held to the same HTTPS-or-loopback rules as the API URL.
   */
  readonly origin?: string;
  readonly signal?: AbortSignal;
}

export interface PlatformResponse<T = unknown> {
  readonly data: T;
  readonly requestId: string;
  readonly mocked: boolean;
}

export interface PlatformStreamPage<T = unknown> {
  readonly items: readonly T[];
  readonly requestId: string;
  readonly nextOffset?: string;
  readonly cursor?: string;
  readonly upToDate?: boolean;
  readonly closed?: boolean;
}

/** A presigned storage URL and the exact headers it was signed with. */
export type PresignedUpload = Pick<CreateArtifactUploadResponse["upload"], "headers" | "url">;

export interface PlatformSdk {
  request<T = unknown>(request: PlatformRequest): Promise<PlatformResponse<T>>;
  stream<T = unknown>(request: PlatformRequest): AsyncIterable<T>;
  streamPage<T = unknown>(request: PlatformRequest): Promise<PlatformStreamPage<T>>;
  /**
   * Opens one Durable Streams SSE read and yields a page per control event, with the data events
   * that preceded it. Ends when the server closes the connection.
   */
  streamBatches<T = unknown>(request: PlatformRequest): AsyncIterable<PlatformStreamPage<T>>;
  /**
   * Sends bytes to a presigned storage URL with only its signed headers, through `storageFetch`
   * rather than `fetch`. Storage rejects a request that also carries the platform credential as a
   * second authentication scheme, and a caller's `fetch` may add that credential.
   */
  uploadPresigned(upload: PresignedUpload, body: Uint8Array): Promise<void>;
  agentEmail(context: AgentEmailContext): AgentEmailSdk;
  email(context: EmailContext): EmailSdk;
  evaluations(context: EvaluationsContext): EvaluationsSdk;
  memory(context: MemoryContext): MemorySdk;
  observability(context: ObservabilityContext): ObservabilitySdk;
  runtime(context: RuntimeContext): RuntimeSdk;
}

export interface CreatePlatformSdkOptions {
  /** Bearer credential. The standalone memory API requires a tenant-scoped JWT. */
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Sends presigned storage uploads. Defaults to the global `fetch`, never to `fetch` above. */
  readonly storageFetch?: typeof globalThis.fetch;
  /** Aborts every request this SDK sends, including the wait before a throttled request is resent. */
  readonly signal?: AbortSignal;
  readonly userAgent?: string;
}

export class PlatformApiError extends Error {
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
    this.name = "PlatformApiError";
    this.problem = problem;
  }
}

export class PlatformTransportError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "PlatformTransportError";
  }
}

export class PlatformRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformRequestError";
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (normalized === "::1" || normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }
  const octets = normalized.split(".");
  return (
    octets.length === 4 && octets[0] === "127" && octets.every((octet) => /^\d{1,3}$/u.test(octet))
  );
}

export function validateRequestPath(path: string) {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new PlatformRequestError(
      "Platform request paths must be relative API paths beginning with one slash.",
    );
  }
  if (path.includes("?") || path.includes("#")) {
    throw new PlatformRequestError("Platform request paths must not contain a query or fragment.");
  }
  for (const segment of path.split("/")) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new PlatformRequestError("Platform request paths must use valid percent encoding.");
    }
    if (decoded.includes("/") || decoded.includes("\\")) {
      throw new PlatformRequestError("Platform request paths must not contain encoded separators.");
    }
    if (decoded === "." || decoded === "..") {
      throw new PlatformRequestError("Platform request paths must not contain dot segments.");
    }
  }
}

export function validatePlatformBaseUrl(baseUrl: string): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new PlatformRequestError(`Invalid platform API URL: ${baseUrl}`);
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new PlatformRequestError("Platform API URLs must use HTTP or HTTPS.");
  }
  if (base.protocol !== "https:" && !isLoopbackHostname(base.hostname)) {
    throw new PlatformRequestError(
      "Platform API requests require HTTPS unless the API host is loopback.",
    );
  }
  if (base.username || base.password) {
    throw new PlatformRequestError("Platform API URLs must not contain credentials.");
  }
  if (base.pathname !== "/" || base.search || base.hash) {
    throw new PlatformRequestError(
      "Platform API URLs must be an origin without a path, query, or fragment.",
    );
  }
  return base;
}

function presignedUploadUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PlatformRequestError("The artifact upload URL is invalid.");
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    return url;
  }
  throw new PlatformRequestError(
    "Artifact uploads require HTTPS unless the storage host is loopback.",
  );
}

function requestUrl(options: CreatePlatformSdkOptions, request: PlatformRequest): URL {
  validateRequestPath(request.path);
  const base = validatePlatformBaseUrl(request.origin ?? options.baseUrl);
  const url = new URL(request.path, base);
  if (url.origin !== base.origin) {
    throw new PlatformRequestError("Platform request paths must remain on the requested origin.");
  }
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

function contextHeaders(context: PlatformContext | undefined): Record<string, string> {
  return {
    ...(context?.organizationId ? { "x-deployments-organization": context.organizationId } : {}),
    ...(context?.projectId ? { "x-deployments-project": context.projectId } : {}),
    ...(context?.environmentId ? { "x-deployments-environment": context.environmentId } : {}),
    ...(context?.workspaceId ? { "x-deployments-workspace": context.workspaceId } : {}),
  };
}

async function decodeResponse(response: Response): Promise<unknown> {
  try {
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (response.status === 204) return null;
    if (contentType.includes("application/json") || contentType.includes("+json")) {
      return await response.json();
    }
    return await response.text();
  } catch (cause) {
    throw new PlatformTransportError("The Deployments.ai API response was interrupted.", cause);
  }
}

function requestInit(options: CreatePlatformSdkOptions, request: PlatformRequest): RequestInit {
  if (request.body !== undefined && request.rawBody !== undefined) {
    throw new PlatformRequestError("A platform request cannot contain JSON and raw bodies.");
  }
  const bearerToken = request.bearerToken ?? options.apiKey;
  const signal =
    request.signal && options.signal
      ? AbortSignal.any([request.signal, options.signal])
      : (request.signal ?? options.signal);
  return {
    method: request.method,
    redirect: "error",
    headers: {
      accept: "application/json, application/x-ndjson, text/event-stream",
      ...(request.body === undefined && request.rawBody === undefined
        ? {}
        : { "content-type": request.contentType ?? "application/json" }),
      ...(request.rawBody === undefined
        ? {}
        : { "content-length": String(request.rawBody.byteLength) }),
      ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
      ...(request.idempotencyKey ? { "idempotency-key": request.idempotencyKey } : {}),
      ...(options.userAgent ? { "user-agent": options.userAgent } : {}),
      ...contextHeaders(request.context),
    },
    ...(request.rawBody !== undefined
      ? { body: request.rawBody }
      : request.body === undefined
        ? {}
        : { body: JSON.stringify(request.body) }),
    ...(signal ? { signal } : {}),
  };
}

async function fetchResponse(
  fetchImpl: typeof globalThis.fetch,
  options: CreatePlatformSdkOptions,
  request: PlatformRequest,
): Promise<Response> {
  const url = requestUrl(options, request);
  const init = requestInit(options, request);
  try {
    return await resendGatewayThrottles(() => fetchImpl(url, init), init.signal ?? undefined);
  } catch (cause) {
    throw new PlatformTransportError("Unable to reach the Deployments.ai API.", cause);
  }
}

async function throwApiError(response: Response): Promise<never> {
  let payload: unknown = {};
  try {
    const body = await response.text();
    if (body) {
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (contentType.includes("application/json") || contentType.includes("+json")) {
        try {
          payload = JSON.parse(body);
        } catch {
          payload = { detail: body };
        }
      } else {
        payload = { detail: body };
      }
    }
  } catch {
    payload = {};
  }
  const requestId = response.headers.get("x-request-id") ?? "unknown";
  const problem =
    typeof payload === "object" && payload !== null
      ? (payload as Partial<ProblemDetails>)
      : { detail: String(payload) };
  throw new PlatformApiError({
    title: problem.title || response.statusText || "Platform API request failed",
    status: response.status,
    ...(problem.type ? { type: problem.type } : {}),
    ...(problem.detail ? { detail: problem.detail } : {}),
    ...(problem.instance ? { instance: problem.instance } : {}),
    ...(problem.requestId ? { requestId: problem.requestId } : { requestId }),
    ...(problem.code ? { code: problem.code } : {}),
  });
}

function streamPayload(payload: string, strict = false): unknown {
  if (!payload || payload === "[DONE]") return undefined;
  try {
    return JSON.parse(payload);
  } catch (cause) {
    if (strict) {
      throw new PlatformTransportError("The Deployments.ai API returned malformed NDJSON.", cause);
    }
    return payload;
  }
}

async function* responseLines(response: Response): AsyncIterable<string> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let reachedEnd = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      let lineEnd = buffered.search(/[\r\n]/u);
      while (lineEnd >= 0) {
        if (buffered[lineEnd] === "\r" && lineEnd === buffered.length - 1 && !done) break;
        const separatorLength =
          buffered[lineEnd] === "\r" && buffered[lineEnd + 1] === "\n" ? 2 : 1;
        yield buffered.slice(0, lineEnd);
        buffered = buffered.slice(lineEnd + separatorLength);
        lineEnd = buffered.search(/[\r\n]/u);
      }
      if (done) {
        reachedEnd = true;
        break;
      }
    }
    if (buffered) yield buffered.replace(/\r$/u, "");
  } catch (cause) {
    throw new PlatformTransportError("The Deployments.ai API event stream was interrupted.", cause);
  } finally {
    if (!reachedEnd) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the original stream result when cancellation itself fails.
      }
    }
    reader.releaseLock();
  }
}

async function* decodeEventStream<T>(response: Response): AsyncIterable<T> {
  if (response.status === 204) return;
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    const payload = await decodeResponse(response);
    if (Array.isArray(payload)) {
      for (const item of payload) yield item as T;
      return;
    }
    if (
      typeof payload === "object" &&
      payload !== null &&
      Array.isArray((payload as { items?: unknown }).items)
    ) {
      for (const item of (payload as { items: unknown[] }).items) yield item as T;
      return;
    }
    yield payload as T;
    return;
  }
  if (contentType.includes("text/event-stream")) {
    let dataLines: string[] = [];
    for await (const line of responseLines(response)) {
      if (line === "") {
        const parsed = streamPayload(dataLines.join("\n"));
        dataLines = [];
        if (parsed !== undefined) yield parsed as T;
        continue;
      }
      if (line.startsWith(":")) continue;
      if (line === "data") dataLines.push("");
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /u, ""));
    }
    const parsed = streamPayload(dataLines.join("\n"));
    if (parsed !== undefined) yield parsed as T;
    return;
  }
  if (
    !contentType.includes("application/x-ndjson") &&
    !contentType.includes("application/ndjson")
  ) {
    throw new PlatformTransportError(
      `Unsupported Deployments.ai API event stream content type: ${contentType || "missing"}.`,
      new TypeError("Unsupported event stream content type"),
    );
  }
  for await (const line of responseLines(response)) {
    const parsed = streamPayload(line.trim(), true);
    if (parsed !== undefined) yield parsed as T;
  }
}

export function createPlatformSdk(options: CreatePlatformSdkOptions): PlatformSdk {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sdk: PlatformSdk = {
    async request<T>(request: PlatformRequest): Promise<PlatformResponse<T>> {
      const response = await fetchResponse(fetchImpl, options, request);
      if (!response.ok) await throwApiError(response);
      const payload = await decodeResponse(response);
      const requestId = response.headers.get("x-request-id") ?? "unknown";
      return { data: payload as T, requestId, mocked: false };
    },
    async *stream<T>(request: PlatformRequest): AsyncIterable<T> {
      const response = await fetchResponse(fetchImpl, options, request);
      if (!response.ok) await throwApiError(response);
      yield* decodeEventStream<T>(response);
    },
    async streamPage<T>(request: PlatformRequest): Promise<PlatformStreamPage<T>> {
      const response = await fetchResponse(fetchImpl, options, request);
      if (!response.ok) await throwApiError(response);
      const items: T[] = [];
      for await (const item of decodeEventStream<T>(response)) items.push(item);
      const booleanHeader = (name: string) => {
        const value = response.headers.get(name);
        if (value === null) return undefined;
        return value.toLowerCase() === "true";
      };
      const nextOffset = response.headers.get("stream-next-offset") ?? undefined;
      const cursor = response.headers.get("stream-cursor") ?? undefined;
      const upToDate = booleanHeader("stream-up-to-date");
      const closed = booleanHeader("stream-closed");
      return {
        items,
        requestId: response.headers.get("x-request-id") ?? "unknown",
        ...(nextOffset ? { nextOffset } : {}),
        ...(cursor ? { cursor } : {}),
        ...(upToDate === undefined ? {} : { upToDate }),
        ...(closed === undefined ? {} : { closed }),
      };
    },
    async *streamBatches<T>(request: PlatformRequest): AsyncIterable<PlatformStreamPage<T>> {
      const response = await fetchResponse(fetchImpl, options, request);
      if (!response.ok) await throwApiError(response);
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (!contentType.includes("text/event-stream")) {
        await response.body?.cancel();
        throw new PlatformTransportError(
          `Expected a Deployments.ai event stream, received ${contentType || "no content type"}.`,
          new TypeError("Unsupported event stream content type"),
        );
      }
      yield* durableStreamSseBatches<T>(
        responseLines(response),
        response.headers.get("x-request-id") ?? "unknown",
      );
    },
    async uploadPresigned(upload: PresignedUpload, body: Uint8Array): Promise<void> {
      const url = presignedUploadUrl(upload.url);
      let response: Response;
      try {
        response = await (options.storageFetch ?? globalThis.fetch)(url, {
          method: "PUT",
          redirect: "error",
          headers: upload.headers,
          body,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (cause) {
        throw new PlatformTransportError("Unable to reach artifact storage.", cause);
      }
      await response.body?.cancel();
      if (!response.ok) {
        throw new PlatformApiError({
          title: "Artifact storage rejected the upload.",
          status: response.status,
          requestId: response.headers.get("x-amz-request-id") ?? "unknown",
        });
      }
    },
    agentEmail: (context) => createAgentEmailSdk(sdk, context),
    email: (context) => createEmailSdk(sdk, context),
    evaluations: (context) => createEvaluationsSdk(sdk, context),
    memory: (context) => createMemorySdk(sdk, context),
    observability: (context) => createObservabilitySdk(sdk, context),
    runtime: (context) => createRuntimeSdk(sdk, context),
  };
  return sdk;
}

export * from "./mock.ts";
