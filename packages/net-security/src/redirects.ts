/* eslint-disable no-await-in-loop -- Redirect and DNS validation must complete serially so every hop is checked before the next request. */

import type {
  ExecutePinnedHttpsWithSameOriginRedirectsOptions,
  ExecutePinnedHttpsWithSameOriginRedirectsResult,
  ResolvedAddress,
} from "./types.ts";
import {
  DEFAULT_PINNED_HTTPS_MAX_REDIRECTS,
  NetSecurityError,
  NetSecurityRedirectError,
} from "./types.ts";
import { resolvePublicHttpsTarget } from "./addresses.ts";
import { executePinnedHttpRequest } from "./pinned-http.ts";

export async function readResponseTextWithByteLimit(
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("Response byte limit must be a positive safe integer.");
  }
  const tooLarge = () => new Error(`${label} was too large.`);
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed) && parsed > maximumBytes) {
      await response.body?.cancel();
      throw tooLarge();
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maximumBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Normalize an absolute HTTPS origin for same-origin redirect comparison.
 * Rejects credentials and non-https schemes.
 */
export function normalizeHttpsOriginForComparison(rawOrigin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch (cause) {
    throw new NetSecurityError("invalid-url", "Origin must be a valid absolute URL.", { cause });
  }
  if (parsed.protocol !== "https:") {
    throw new NetSecurityError("non-https", "Origin must use https.");
  }
  if (parsed.username || parsed.password) {
    throw new NetSecurityError("credentials", "Origin must not include credentials.");
  }
  // URL.origin lowercases host and drops default ports.
  return parsed.origin;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function resolveRedirectLocation(currentUrl: string, locationHeader: string | null): URL {
  if (!locationHeader || !locationHeader.trim()) {
    throw new NetSecurityRedirectError(
      "redirect-invalid",
      "Redirect response is missing a Location header.",
    );
  }
  try {
    return new URL(locationHeader.trim(), currentUrl);
  } catch (cause) {
    throw new NetSecurityRedirectError(
      "redirect-invalid",
      "Redirect Location is not a valid URL.",
      {
        cause,
      },
    );
  }
}

/**
 * Perform a public HTTPS request with per-hop DNS revalidation and address
 * pinning. Redirects are followed only when the Location stays on the verified
 * origin; each hop re-resolves A/AAAA and rejects private/reserved destinations.
 * Hostname / TLS SNI / Host are preserved from the hop URL.
 */
export async function executePinnedHttpsWithSameOriginRedirects(
  args: ExecutePinnedHttpsWithSameOriginRedirectsOptions,
): Promise<ExecutePinnedHttpsWithSameOriginRedirectsResult> {
  const verifiedOrigin = normalizeHttpsOriginForComparison(args.verifiedOrigin);
  const maxRedirects =
    args.maxRedirects === undefined ? DEFAULT_PINNED_HTTPS_MAX_REDIRECTS : args.maxRedirects;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
    throw new NetSecurityRedirectError(
      "redirect-limit",
      "maxRedirects must be a non-negative safe integer.",
    );
  }

  const pinnedRequest = args.pinnedRequest ?? executePinnedHttpRequest;
  let currentUrl =
    typeof args.url === "string" ? new URL(args.url).toString() : args.url.toString();
  let method = args.method ?? (args.body === undefined ? "GET" : "POST");
  let body = args.body;
  let hopCount = 0;
  let lastAddresses: readonly ResolvedAddress[] = [];

  while (true) {
    hopCount += 1;
    if (hopCount > maxRedirects + 1) {
      throw new NetSecurityRedirectError(
        "redirect-limit",
        `Exceeded maximum of ${maxRedirects} redirects.`,
      );
    }

    let hopOrigin: string;
    try {
      hopOrigin = normalizeHttpsOriginForComparison(new URL(currentUrl).origin);
    } catch (cause) {
      if (cause instanceof NetSecurityError) throw cause;
      throw new NetSecurityError("invalid-url", "Request URL must be a valid absolute URL.", {
        cause,
      });
    }
    if (hopOrigin !== verifiedOrigin) {
      throw new NetSecurityRedirectError(
        "redirect-cross-origin",
        "Request URL must stay on the verified origin.",
      );
    }

    const target = await resolvePublicHttpsTarget(
      currentUrl,
      args.dnsLookup ? { dnsLookup: args.dnsLookup } : {},
    );
    // Re-check origin after normalizePublicHttpsUrl (credentials / scheme).
    const resolvedOrigin = normalizeHttpsOriginForComparison(new URL(target.url).origin);
    if (resolvedOrigin !== verifiedOrigin) {
      throw new NetSecurityRedirectError(
        "redirect-cross-origin",
        "Resolved URL must stay on the verified origin.",
      );
    }
    lastAddresses = target.addresses;

    // Drain/ignore body for redirect hops so sockets close promptly.
    const response = await pinnedRequest({
      addresses: target.addresses,
      ...(body !== undefined ? { body } : {}),
      emptyLookupMessage: "Pinned HTTPS target has no resolved addresses.",
      ...(args.headers ? { headers: args.headers } : {}),
      method,
      signal: args.signal,
      url: target.url,
    });

    if (!isRedirectStatus(response.status)) {
      return {
        response,
        finalUrl: target.url,
        hopCount,
        addresses: lastAddresses,
      };
    }

    if (hopCount > maxRedirects) {
      try {
        await response.body?.cancel();
      } catch {
        // Ignore cancellation errors while failing closed on redirect count.
      }
      throw new NetSecurityRedirectError(
        "redirect-limit",
        `Exceeded maximum of ${maxRedirects} redirects.`,
      );
    }

    let next: URL;
    try {
      next = resolveRedirectLocation(target.url, response.headers.get("location"));
    } finally {
      try {
        await response.body?.cancel();
      } catch {
        // Ignore cancellation errors; redirect bodies are never consumed.
      }
    }

    let nextOrigin: string;
    try {
      nextOrigin = normalizeHttpsOriginForComparison(next.origin);
    } catch (cause) {
      if (cause instanceof NetSecurityError && cause.code === "non-https") {
        throw new NetSecurityRedirectError(
          "redirect-cross-origin",
          "Redirect Location must use https on the verified origin.",
          { cause },
        );
      }
      throw cause;
    }
    if (nextOrigin !== verifiedOrigin) {
      throw new NetSecurityRedirectError(
        "redirect-cross-origin",
        "Redirect Location must stay on the verified origin.",
      );
    }

    currentUrl = next.toString();
    // RFC 7231: 303 forces GET; 301/302 historically change POST→GET in browsers.
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) &&
        method !== "GET" &&
        method !== "HEAD")
    ) {
      method = "GET";
      body = undefined;
    }
  }
}
