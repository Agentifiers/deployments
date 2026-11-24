import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  executePinnedHttpsWithSameOriginRedirects,
  defaultDnsLookup,
  NetSecurityError,
  NetSecurityRedirectError,
  normalizeHttpsOriginForComparison,
  readResponseTextWithByteLimit,
  type DnsLookup,
} from "@deployments-ai/net-security";
import {
  DEFAULT_REMOTE_MCP_TIMEOUT_MS,
  RemoteMcpError,
  type RemoteMcpEndpointRequest,
  type RemoteMcpPinnedRequest,
  type RemoteMcpServerMetadata,
} from "./remote-client-types.ts";
import { isRecord } from "./type-guards.ts";

const BLOCKED_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type CompatibleBodyInit = ArrayBuffer | Uint8Array | string;

function positiveTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_REMOTE_MCP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new RemoteMcpError("configuration", "MCP timeout must be a positive safe integer.");
  }
  return timeout;
}

export function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RemoteMcpError("configuration", `${label} must be a positive safe integer.`);
  }
  return resolved;
}

function endpointUrl(originValue: string, pathValue: string): URL {
  const rawOrigin = originValue.trim();
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(rawOrigin);
  } catch (cause) {
    throw new RemoteMcpError("configuration", "MCP endpointOrigin is invalid.", { cause });
  }
  if (parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash) {
    throw new RemoteMcpError(
      "configuration",
      "MCP endpointOrigin must contain only scheme, host, and optional port.",
    );
  }
  const origin = normalizeHttpsOriginForComparison(rawOrigin);
  const path = pathValue.trim();
  if (!path.startsWith("/") || path.includes("#")) {
    throw new RemoteMcpError(
      "configuration",
      "MCP endpointPath must be an absolute path without a fragment.",
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(path, `${origin}/`);
  } catch (cause) {
    throw new RemoteMcpError("configuration", "MCP endpoint is invalid.", { cause });
  }
  if (endpoint.origin !== origin) {
    throw new RemoteMcpError("configuration", "MCP endpoint escaped its configured origin.");
  }
  return endpoint;
}

function requestHeaders(value: RequestInit["headers"]): Record<string, string> {
  const result: Record<string, string> = {};
  const headers = new Headers(value);
  for (const [name, headerValue] of headers) {
    const normalized = name.toLowerCase();
    if (BLOCKED_REQUEST_HEADERS.has(normalized)) {
      throw new RemoteMcpError(
        "configuration",
        `MCP request header ${normalized} is controlled by the transport.`,
      );
    }
    result[normalized] = headerValue;
  }
  return result;
}

function requestBody(
  value: CompatibleBodyInit | null | undefined,
): string | Uint8Array | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new RemoteMcpError("transport", "MCP transport produced an unsupported request body.");
}

function combinedSignal(...signals: readonly (AbortSignal | null | undefined)[]) {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0)
    return { cleanup: () => undefined, signal: new AbortController().signal };
  if (active.length === 1) return { cleanup: () => undefined, signal: active[0]! };
  const controller = new AbortController();
  const abort = (event: Event) => {
    const source = event.target as AbortSignal;
    controller.abort(source.reason);
  };
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return {
    cleanup: () => {
      for (const signal of active) signal.removeEventListener("abort", abort);
    },
    signal: controller.signal,
  };
}

function deadlineSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new RemoteMcpError("timeout", `MCP call exceeded ${timeoutMs} ms.`)),
    timeoutMs,
  );
  return {
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abortFromParent);
    },
    signal: controller.signal,
  };
}

function isSchemaValidationError(value: unknown): boolean {
  return (
    value instanceof SyntaxError ||
    (isRecord(value) &&
      (value.name === "ZodError" || Array.isArray(value.issues) || Array.isArray(value.errors)))
  );
}

function boundedMetadata(value: string | undefined, maximumCharacters: number) {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maximumCharacters);
}

function normalizedResponseHeaders(value: Headers) {
  const headers = new Headers(value);
  const contentType = headers.get("content-type");
  if (contentType) headers.set("content-type", contentType.toLowerCase());
  return headers;
}

export function abortableDnsLookup(
  hostname: string,
  lookup: DnsLookup,
  signal: AbortSignal,
): Promise<readonly { readonly address: string; readonly family: 4 | 6 }[]> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(lookup(hostname))
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", abort);
      });
  });
}

function boundedStreamingResponse(
  response: Response,
  maximumBytes: number,
  label: string,
  cleanup: () => void,
): Response {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed) && parsed > maximumBytes) {
      void response.body?.cancel();
      cleanup();
      throw new RemoteMcpError("protocol", `${label} was too large.`);
    }
  }
  if (!response.body) {
    cleanup();
    return response;
  }
  const reader = response.body.getReader();
  let bytesRead = 0;
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    cleanup();
  };
  const stream = new ReadableStream<Uint8Array>({
    cancel: async (reason) => {
      try {
        await reader.cancel(reason);
      } finally {
        settle();
      }
    },
    pull: async (controller) => {
      try {
        const { done, value } = await reader.read();
        if (done) {
          settle();
          controller.close();
          return;
        }
        bytesRead += value.byteLength;
        if (bytesRead > maximumBytes) {
          await reader.cancel();
          settle();
          controller.error(new RemoteMcpError("protocol", `${label} was too large.`));
          return;
        }
        controller.enqueue(value);
      } catch (cause) {
        settle();
        controller.error(cause);
      }
    },
  });
  const headers = normalizedResponseHeaders(response.headers);
  return new Response(stream, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export interface RemoteMcpSessionSettings {
  readonly clientInfo: { readonly name: string; readonly version: string };
  readonly dnsLookup?: DnsLookup;
  readonly maxResponseBytes: number;
  readonly pinnedRequest?: RemoteMcpPinnedRequest;
}

interface RemoteMcpRequestOptions {
  readonly maxTotalTimeout: number;
  readonly signal: AbortSignal;
  readonly timeout: number;
}

export interface RemoteMcpSession {
  readonly client: Client;
  readonly metadata: () => RemoteMcpServerMetadata;
  readonly requestOptions: RemoteMcpRequestOptions;
}

function pinnedMcpFetch(settings: RemoteMcpSessionSettings, endpoint: URL, deadline: AbortSignal) {
  const verifiedOrigin = endpoint.origin;
  return async (url: string | URL, init: RequestInit = {}) => {
    const requested = new URL(url.toString());
    if (requested.origin !== verifiedOrigin || requested.toString() !== endpoint.toString()) {
      throw new RemoteMcpError(
        "transport",
        "MCP SDK request did not match the configured endpoint.",
      );
    }
    const signal = combinedSignal(deadline, init.signal);
    let streamingResponse = false;
    try {
      const body = requestBody(init.body as CompatibleBodyInit | null | undefined);
      const response = await executePinnedHttpsWithSameOriginRedirects({
        ...(body === undefined ? {} : { body }),
        dnsLookup: (hostname) =>
          abortableDnsLookup(hostname, settings.dnsLookup ?? defaultDnsLookup, signal.signal),
        headers: requestHeaders(init.headers),
        maxRedirects: 0,
        ...(init.method ? { method: init.method } : {}),
        ...(settings.pinnedRequest ? { pinnedRequest: settings.pinnedRequest } : {}),
        signal: signal.signal,
        url: endpoint,
        verifiedOrigin,
      });
      const remoteResponse = response.response;
      if (remoteResponse.status === 204 || remoteResponse.status === 304) {
        return remoteResponse;
      }
      if (remoteResponse.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
        streamingResponse = true;
        return boundedStreamingResponse(
          remoteResponse,
          settings.maxResponseBytes,
          "MCP response body",
          signal.cleanup,
        );
      }
      let responseBody: string;
      try {
        responseBody = await readResponseTextWithByteLimit(
          remoteResponse,
          settings.maxResponseBytes,
          "MCP response body",
        );
      } catch (cause) {
        if (cause instanceof Error && cause.message === "MCP response body was too large.") {
          throw new RemoteMcpError("protocol", cause.message, { cause });
        }
        throw cause;
      }
      return new Response(responseBody, {
        headers: normalizedResponseHeaders(remoteResponse.headers),
        status: remoteResponse.status,
        statusText: remoteResponse.statusText,
      });
    } finally {
      if (!streamingResponse) signal.cleanup();
    }
  };
}

function remoteMcpFailure(cause: unknown, deadline: AbortSignal): RemoteMcpError {
  if (cause instanceof RemoteMcpError) return cause;
  if (deadline.aborted) {
    const reason: unknown = deadline.reason;
    return reason instanceof RemoteMcpError
      ? reason
      : new RemoteMcpError("transport", "MCP request was aborted.");
  }
  if (cause instanceof NetSecurityError || cause instanceof NetSecurityRedirectError) {
    return new RemoteMcpError("configuration", cause.message, { cause });
  }
  if (cause instanceof StreamableHTTPError) {
    return new RemoteMcpError(
      "http",
      cause.code === undefined
        ? "MCP endpoint returned an HTTP error."
        : `MCP endpoint returned HTTP ${cause.code}.`,
      cause.code === undefined ? {} : { statusCode: cause.code },
    );
  }
  if (cause instanceof McpError) {
    const retryable =
      cause.code === ErrorCode.ConnectionClosed ||
      cause.code === ErrorCode.InternalError ||
      cause.code === ErrorCode.RequestTimeout;
    return new RemoteMcpError(
      retryable ? "transport" : "protocol",
      `MCP request failed with protocol code ${cause.code}.`,
    );
  }
  if (isSchemaValidationError(cause)) {
    return new RemoteMcpError("protocol", "MCP server returned an invalid protocol message.");
  }
  return new RemoteMcpError("transport", "Remote MCP transport failed.");
}

/**
 * Opens a DNS-pinned Streamable HTTP MCP session against the configured endpoint, requires
 * the tools capability, runs `use`, and always terminates the session. Every failure is
 * normalized to `RemoteMcpError`.
 */
export async function withRemoteMcpSession<T>(
  settings: RemoteMcpSessionSettings,
  input: RemoteMcpEndpointRequest,
  use: (session: RemoteMcpSession) => Promise<T>,
): Promise<T> {
  const timeoutMs = positiveTimeout(input.timeoutMs);
  const endpoint = endpointUrl(input.endpointOrigin, input.endpointPath);
  const deadline = deadlineSignal(input.signal, timeoutMs);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: pinnedMcpFetch(settings, endpoint, deadline.signal),
    ...(input.headers ? { requestInit: { headers: input.headers } } : {}),
    reconnectionOptions: {
      initialReconnectionDelay: 250,
      maxReconnectionDelay: 1_000,
      maxRetries: 0,
      reconnectionDelayGrowFactor: 1,
    },
  });
  const client = new Client(settings.clientInfo, { capabilities: {} });
  const requestOptions = {
    maxTotalTimeout: timeoutMs,
    signal: deadline.signal,
    timeout: timeoutMs,
  };
  try {
    await client.connect(transport as Parameters<typeof client.connect>[0], requestOptions);
    if (!client.getServerCapabilities()?.tools) {
      throw new RemoteMcpError("protocol", "MCP server did not advertise the tools capability.");
    }
    return await use({
      client,
      metadata: () => {
        const protocolVersion = boundedMetadata(transport.protocolVersion, 64);
        const serverName = client.getServerVersion()?.name.trim();
        const serverVersion = client.getServerVersion()?.version.trim();
        return {
          ...(protocolVersion ? { protocolVersion } : {}),
          ...(serverName ? { serverName } : {}),
          ...(serverVersion ? { serverVersion } : {}),
        };
      },
      requestOptions,
    });
  } catch (cause) {
    throw remoteMcpFailure(cause, deadline.signal);
  } finally {
    await transport.terminateSession().catch(() => undefined);
    deadline.cleanup();
    await client.close().catch(() => undefined);
  }
}
