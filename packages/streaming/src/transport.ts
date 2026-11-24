import {
  assertEventsMatchThreadScope,
  createThreadStreamEvent,
  threadStreamEventJson,
  type ThreadStreamEvent,
} from "./events.ts";
import { StreamContractError } from "./errors.ts";
import { parseThreadStreamPath, threadStreamPath, type ThreadStreamScope } from "./paths.ts";

export const DURABLE_STREAM_CONTENT_TYPE = "application/json" as const;
export const DURABLE_STREAM_RESPONSE_HEADER_ALLOWLIST = [
  "content-type",
  "etag",
  "stream-closed",
  "stream-cursor",
  "stream-next-offset",
  "stream-up-to-date",
] as const;

export interface DurableStreamServerConfig {
  readonly allowInsecurePrivateHttp?: boolean;
  readonly authHeaderName?: string;
  readonly authToken?: string;
  readonly baseUrl: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

export interface DurableThreadStreamTarget {
  readonly contentType: typeof DURABLE_STREAM_CONTENT_TYPE;
  readonly headers: Readonly<Record<string, string>>;
  readonly path: string;
  readonly readUrl: string;
  readonly writeUrl: string;
}

export interface DurableStreamAppendInput {
  readonly entries: readonly string[];
  readonly producerId: string;
  readonly signal?: AbortSignal;
  readonly streamPath: string;
}

export interface DurableStreamAppendResult {
  readonly finalOffset?: string;
  readonly lastSuccessfulOffset?: string;
}

export interface DurableStreamTransport {
  readonly append: (input: DurableStreamAppendInput) => Promise<DurableStreamAppendResult>;
  readonly currentOffset: (streamPath: string) => Promise<string>;
}

export interface AppendThreadStreamEventsInput {
  readonly events: readonly ThreadStreamEvent[];
  readonly producerId: string;
  readonly producerType: "api" | "channel" | "worker";
  readonly signal?: AbortSignal;
  readonly scope: ThreadStreamScope;
  readonly transport: DurableStreamTransport;
}

function baseUrl(value: string, allowInsecurePrivateHttp = false): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new StreamContractError("baseUrl", "Durable Streams baseUrl must be an absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new StreamContractError("baseUrl", "Durable Streams baseUrl must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new StreamContractError(
      "baseUrl",
      "Durable Streams baseUrl must not include username or password credentials.",
    );
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const ipv4 = hostname.split(".").map(Number);
  const loopback =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    (ipv4.length === 4 &&
      ipv4[0] === 127 &&
      ipv4.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255));
  if (url.protocol === "http:" && !loopback && !allowInsecurePrivateHttp) {
    throw new StreamContractError(
      "baseUrl",
      "Durable Streams baseUrl must use HTTPS outside loopback development.",
    );
  }
  return url;
}

export function durableStreamUrl(
  config: Pick<DurableStreamServerConfig, "allowInsecurePrivateHttp" | "baseUrl"> & {
    readonly streamPath: string;
  },
): string {
  const path = threadStreamPath(parseThreadStreamPath(config.streamPath));
  const url = baseUrl(config.baseUrl, config.allowInsecurePrivateHttp);
  const prefix = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${prefix}${path}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function durableStreamReadUrl(
  config: Pick<DurableStreamServerConfig, "allowInsecurePrivateHttp" | "baseUrl"> & {
    readonly cursor?: string;
    readonly live?: "long-poll" | "sse";
    readonly offset?: string;
    readonly streamPath: string;
  },
): string {
  const url = new URL(durableStreamUrl(config));
  if (config.cursor !== undefined) {
    if (config.cursor.length === 0) {
      throw new StreamContractError("cursor", "Durable Streams cursor must not be empty.");
    }
    url.searchParams.set("cursor", config.cursor);
  }
  if (config.offset !== undefined) {
    if (config.offset.length === 0) {
      throw new StreamContractError("offset", "Durable Streams offset must not be empty.");
    }
    url.searchParams.set("offset", config.offset);
  }
  if (config.live) url.searchParams.set("live", config.live);
  return url.toString();
}

export function durableStreamHeaders(
  config: Omit<DurableStreamServerConfig, "baseUrl">,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(config.extraHeaders ?? {})) {
    if (name.trim() && value.trim()) headers[name.trim().toLowerCase()] = value.trim();
  }
  if (config.authToken?.trim()) {
    const name = (config.authHeaderName ?? "authorization").trim().toLowerCase();
    headers[name] =
      name === "authorization" ? `Bearer ${config.authToken.trim()}` : config.authToken.trim();
  }
  return headers;
}

export function durableThreadStreamTarget(
  config: DurableStreamServerConfig & ThreadStreamScope,
): DurableThreadStreamTarget {
  const path = threadStreamPath(config);
  const url = durableStreamUrl({
    ...(config.allowInsecurePrivateHttp ? { allowInsecurePrivateHttp: true } : {}),
    baseUrl: config.baseUrl,
    streamPath: path,
  });
  return {
    contentType: DURABLE_STREAM_CONTENT_TYPE,
    headers: durableStreamHeaders(config),
    path,
    readUrl: url,
    writeUrl: url,
  };
}

export async function deleteDurableThreadStream(
  config: DurableStreamServerConfig & { readonly fetch?: typeof globalThis.fetch },
  scope: ThreadStreamScope,
): Promise<void> {
  const target = durableThreadStreamTarget({ ...config, ...scope });
  const response = await (config.fetch ?? globalThis.fetch)(target.writeUrl, {
    headers: target.headers,
    method: "DELETE",
  });
  if (response.ok || response.status === 404 || response.status === 410) return;
  throw new Error(`Durable stream delete failed with HTTP ${response.status}.`);
}

export function streamProducerId(input: {
  readonly producerId: string;
  readonly producerType: "api" | "channel" | "worker";
}): string {
  const producerId = input.producerId.trim();
  if (!producerId) throw new StreamContractError("producerId", "producerId is required.");
  return `${input.producerType}:${encodeURIComponent(producerId)}`;
}

export function streamEventIdempotencyKey(input: {
  readonly eventId: string;
  readonly streamPath: string;
}): string {
  const eventId = input.eventId.trim();
  if (!eventId) throw new StreamContractError("eventId", "eventId is required.");
  const path = threadStreamPath(parseThreadStreamPath(input.streamPath));
  return `durable-stream:${encodeURIComponent(path)}:event:${encodeURIComponent(eventId)}`;
}

export async function appendThreadStreamEvents(
  input: AppendThreadStreamEventsInput,
): Promise<
  DurableStreamAppendResult & { readonly appendedCount: number; readonly streamPath: string }
> {
  const streamPath = threadStreamPath(input.scope);
  const events = assertEventsMatchThreadScope(
    input.scope,
    input.events.map((event) => createThreadStreamEvent(event)),
  );
  if (events.length === 0) return { appendedCount: 0, streamPath };
  const result = await input.transport.append({
    entries: events.map(threadStreamEventJson),
    producerId: streamProducerId(input),
    ...(input.signal ? { signal: input.signal } : {}),
    streamPath,
  });
  return { ...result, appendedCount: events.length, streamPath };
}

/**
 * Streams a Durable Streams read response to a public client without buffering, forwarding only
 * the stream protocol headers and marking the response uncacheable.
 */
export function proxyDurableStreamResponse(upstream: Response): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  for (const name of DURABLE_STREAM_RESPONSE_HEADER_ALLOWLIST) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, {
    headers,
    status: upstream.status,
    statusText: upstream.statusText,
  });
}
