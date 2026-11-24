export const STREAM_EXPOSED_HEADERS = [
  "stream-next-offset",
  "stream-cursor",
  "stream-up-to-date",
  "stream-closed",
  "etag",
] as const;

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

/**
 * An allowed `https://*.<suffix>` entry stands for one DNS label in place of the `*`, the rule the
 * identity provider applies to the same entry in its redirect URIs.
 */
function wildcardOriginMatches(origin: string, entry: string): boolean {
  const suffix = entry.startsWith("https://*.") ? entry.slice("https://*".length) : undefined;
  if (suffix === undefined || !origin.startsWith("https://") || !origin.endsWith(suffix)) {
    return false;
  }
  return DNS_LABEL.test(origin.slice("https://".length, -suffix.length));
}

function isAllowedOrigin(
  origin: string | null,
  allowedOrigins: readonly string[],
): origin is string {
  return (
    origin !== null &&
    allowedOrigins.some((entry) => entry === origin || wildcardOriginMatches(origin, entry))
  );
}

export function corsResponseHeaders(
  origin: string | null,
  allowedOrigins: readonly string[],
): Headers | undefined {
  if (!isAllowedOrigin(origin, allowedOrigins)) return undefined;
  return new Headers({
    "access-control-allow-origin": origin,
    "access-control-expose-headers": STREAM_EXPOSED_HEADERS.join(", "),
    vary: "Origin",
  });
}

export function preflightResponse(
  request: Request,
  allowedOrigins: readonly string[],
): Response | undefined {
  const origin = request.headers.get("origin");
  if (
    !isAllowedOrigin(origin, allowedOrigins) ||
    request.headers.get("access-control-request-method") !== "GET"
  ) {
    return undefined;
  }
  return new Response(null, {
    headers: {
      "access-control-allow-headers": "authorization",
      "access-control-allow-methods": "GET",
      "access-control-allow-origin": origin,
      "access-control-max-age": "600",
      "cache-control": "no-store",
      vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    },
    status: 204,
  });
}

export function withCors(
  response: Response,
  origin: string | null,
  allowedOrigins: readonly string[],
): Response {
  const cors = corsResponseHeaders(origin, allowedOrigins);
  if (!cors) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of cors) {
    if (name === "vary") headers.append(name, value);
    else headers.set(name, value);
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
