/* eslint-disable no-await-in-loop -- Redirect and DNS validation must complete serially so every hop is checked before the next request. */

import { Agent as HttpAgent, request as nodeHttpRequest } from "node:http";
import { Agent as HttpsAgent, request as nodeHttpsRequest } from "node:https";

import { Readable } from "node:stream";

import type {
  ExecutePinnedHttpRequestOptions,
  PinnedLookupOptions,
  ResolvedAddress,
} from "./types.ts";
import { NetSecurityError } from "./types.ts";
import { createPinnedLookup, isLocalhostHostname, normalizeHostname } from "./addresses.ts";

export type PinnedRequestAgent = HttpAgent | HttpsAgent;

/**
 * Build a per-request agent that never keep-alives sockets and pins TCP connect
 * via the validated address set. Avoids reusing the global agent's pooled
 * sockets (which are keyed by host:port, not by resolved address).
 */
export function createPinnedRequestAgent(
  protocol: "http:" | "https:",
  addresses: readonly ResolvedAddress[],
  options: PinnedLookupOptions = {},
): PinnedRequestAgent {
  const agentOptions = {
    keepAlive: false as const,
    lookup: createPinnedLookup(addresses, options),
  };
  return protocol === "http:" ? new HttpAgent(agentOptions) : new HttpsAgent(agentOptions);
}

function responseHeadersFromIncoming(headers: Record<string, string | string[] | undefined>) {
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) responseHeaders.append(name, entry);
    } else if (value !== undefined) {
      responseHeaders.set(name, value);
    }
  }
  return responseHeaders;
}

/**
 * Perform an HTTP(S) request pinned to pre-validated addresses.
 *
 * Hostname / TLS SNI are taken from `url` so certificate validation still uses
 * the original host. Redirects are never followed (Node does not auto-follow).
 *
 * Each call uses a dedicated non-pooled agent so a prior keep-alive socket for
 * the same host:port cannot be reused outside the current validated address set.
 * The agent is destroyed only after the response body finishes (or on error/abort)
 * so streaming consumers can fully drain multi-chunk bodies.
 */
// ---------------------------------------------------------------------------
// Bounded raw request body reading (ingress)
// ---------------------------------------------------------------------------

export function executePinnedHttpRequest(args: ExecutePinnedHttpRequestOptions): Promise<Response> {
  return new Promise((resolve, reject) => {
    const parsed = typeof args.url === "string" ? new URL(args.url) : new URL(args.url.toString());
    if (parsed.username || parsed.password) {
      reject(new NetSecurityError("credentials", "URL must not include credentials."));
      return;
    }

    const hostname = normalizeHostname(parsed.hostname);
    if (parsed.protocol === "https:") {
      // allowed
    } else if (args.allowHttp && parsed.protocol === "http:" && isLocalhostHostname(hostname)) {
      // cleartext only for localhost / *.localhost under explicit allowHttp
    } else {
      reject(new NetSecurityError("non-https", "URL must use https."));
      return;
    }

    const protocol = parsed.protocol === "http:" ? "http:" : "https:";
    const lookupOptions = args.emptyLookupMessage ? { emptyMessage: args.emptyLookupMessage } : {};
    // Per-request agent: keepAlive false + pinned lookup (not globalAgent).
    const agent = createPinnedRequestAgent(protocol, args.addresses, lookupOptions);
    let agentDestroyed = false;
    let responseReceived = false;
    const destroyAgent = () => {
      if (agentDestroyed) return;
      agentDestroyed = true;
      agent.destroy();
    };

    const settleError = (error: unknown) => {
      destroyAgent();
      reject(error);
    };

    const requestImpl = protocol === "http:" ? nodeHttpRequest : nodeHttpsRequest;
    const request = requestImpl(
      parsed,
      {
        agent,
        headers: args.headers,
        // Request-level lookup mirrors the agent so connect cannot fall back to DNS.
        lookup: createPinnedLookup(args.addresses, lookupOptions),
        method: args.method ?? (args.body === undefined ? "GET" : "POST"),
        signal: args.signal,
      },
      (incoming) => {
        responseReceived = true;
        const status = incoming.statusCode ?? 500;
        const responseInit: ResponseInit = {
          headers: responseHeadersFromIncoming(incoming.headers),
          status,
          ...(incoming.statusMessage ? { statusText: incoming.statusMessage } : {}),
        };

        // Keep the dedicated agent alive until the body stream fully settles so
        // slow multi-chunk consumers are not cut off by early agent.destroy().
        const onBodySettled = () => {
          destroyAgent();
        };
        incoming.on("close", onBodySettled);
        incoming.on("error", onBodySettled);

        if (status === 204 || status === 304) {
          incoming.resume();
          resolve(new Response(null, responseInit));
          return;
        }
        resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, responseInit));
      },
    );

    request.on("error", settleError);
    // If the request closes without ever receiving a response (abort, connect
    // failure already handled via error, etc.), ensure the agent does not linger.
    request.on("close", () => {
      if (!responseReceived) destroyAgent();
    });

    if (args.body === undefined) {
      request.end();
    } else {
      request.end(args.body);
    }
  });
}
