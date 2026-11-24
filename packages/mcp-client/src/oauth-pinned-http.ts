import {
  defaultDnsLookup,
  executePinnedHttpsWithSameOriginRedirects,
  NetSecurityRedirectError,
  readResponseTextWithByteLimit,
  type DnsLookup,
} from "@deployments-ai/net-security";
import { abortableDnsLookup } from "./remote-client-transport.ts";
import type { RemoteMcpPinnedRequest } from "./remote-client-types.ts";
import { isRecord } from "./type-guards.ts";

const OAUTH_HTTP_MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_OAUTH_HTTP_TIMEOUT_MS = 10_000;

const BODY_LABEL = "OAuth response body";

/** Injectable network seams shared by MCP OAuth discovery and registration. */
export interface OAuthHttpInput {
  readonly dnsLookup?: DnsLookup;
  readonly pinnedRequest?: RemoteMcpPinnedRequest;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface OAuthHttpContext {
  /** Clears the operation deadline; call once the operation settles. */
  readonly close: () => void;
  readonly dnsLookup: DnsLookup;
  readonly pinnedRequest?: RemoteMcpPinnedRequest;
  readonly signal: AbortSignal;
}

export type OAuthHttpOutcome =
  | { readonly kind: "redirect" }
  | { readonly kind: "too-large"; readonly status: number }
  | {
      readonly body: string;
      readonly headers: Headers;
      readonly kind: "response";
      readonly status: number;
    };

/** Builds the per-operation context; `timeoutMs` bounds the whole operation. */
export function oauthHttpContext(input: OAuthHttpInput): OAuthHttpContext {
  const timeoutMs = input.timeoutMs ?? DEFAULT_OAUTH_HTTP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("OAuth timeout must be a positive safe integer.");
  }
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abortFromParent();
  else input.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Exceeded ${timeoutMs} ms.`, "TimeoutError")),
    timeoutMs,
  );
  return {
    close: () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abortFromParent);
    },
    dnsLookup: input.dnsLookup ?? defaultDnsLookup,
    ...(input.pinnedRequest ? { pinnedRequest: input.pinnedRequest } : {}),
    signal: controller.signal,
  };
}

/**
 * Parses an absolute `https:` URL without credentials or fragment, or returns undefined.
 * Public-address enforcement happens per request through DNS pinning.
 */
export function parseHttpsUrl(value: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return undefined;
  return url;
}

/**
 * One DNS-pinned HTTPS request that never follows redirects. With `readBody` the body is
 * read up to 64 KiB; otherwise it is discarded. Network, DNS-policy, and abort failures
 * propagate as thrown errors.
 */
export async function pinnedOAuthRequest(
  context: OAuthHttpContext,
  request: {
    readonly body?: string;
    readonly headers: Record<string, string>;
    readonly method: "GET" | "POST";
    readonly readBody: boolean;
    readonly url: URL;
  },
): Promise<OAuthHttpOutcome> {
  let response: Response;
  try {
    ({ response } = await executePinnedHttpsWithSameOriginRedirects({
      ...(request.body === undefined ? {} : { body: request.body }),
      dnsLookup: (hostname) => abortableDnsLookup(hostname, context.dnsLookup, context.signal),
      headers: request.headers,
      maxRedirects: 0,
      method: request.method,
      ...(context.pinnedRequest ? { pinnedRequest: context.pinnedRequest } : {}),
      signal: context.signal,
      url: request.url,
      verifiedOrigin: request.url.origin,
    }));
  } catch (cause) {
    if (cause instanceof NetSecurityRedirectError) return { kind: "redirect" };
    throw cause;
  }
  if (!request.readBody) {
    await response.body?.cancel().catch(() => undefined);
    return { body: "", headers: response.headers, kind: "response", status: response.status };
  }
  try {
    const body = await readResponseTextWithByteLimit(
      response,
      OAUTH_HTTP_MAX_RESPONSE_BYTES,
      BODY_LABEL,
    );
    return { body, headers: response.headers, kind: "response", status: response.status };
  } catch (cause) {
    if (cause instanceof Error && cause.message === `${BODY_LABEL} was too large.`) {
      return { kind: "too-large", status: response.status };
    }
    throw cause;
  }
}

/** Parses a JSON object body, or returns undefined for anything else. */
export function parseJsonObject(body: string): Readonly<Record<string, unknown>> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}
