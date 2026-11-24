import { LambdaClient } from "@aws-sdk/client-lambda";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { lambdaModelTokenIssuer, makeModelGatewayTokenCache } from "@deployments-ai/model-gateway";
import { isPublicIpAddress } from "@deployments-ai/net-security";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Caller credentials Firecrawl may send; the proxy replaces them with its own service token. */
const INBOUND_CREDENTIAL_HEADERS: Record<string, true> = { authorization: true, "x-bf-vk": true };

export interface ModelGatewayProxyOptions {
  readonly baseUrl?: string;
  readonly hostname?: string;
  readonly lookup?: typeof lookup;
  readonly port?: number;
  readonly timeoutMs?: number;
  /**
   * Returns the bearer token presented upstream. Defaults to a cached `web-tools` service token
   * from the `tokenIssuer` Lambda function.
   */
  readonly token?: () => Promise<string>;
  /** Name of the `web-tools` model token issuer function, invoked with the task role. */
  readonly tokenIssuer?: string;
}

/**
 * Firecrawl only calls the models it is configured with, which are exactly the `web-tools`
 * issuer's service models, so the proxy requests the issuer's default models (no `models` list)
 * and shares one cached token across requests.
 */
function webToolsServiceToken(tokenIssuer: string | undefined) {
  const functionName = tokenIssuer?.trim();
  if (!functionName) return undefined;
  const tokens = makeModelGatewayTokenCache(
    lambdaModelTokenIssuer(new LambdaClient({}), functionName),
  );
  return () => tokens({ kind: "service" });
}

function filteredHeaders(
  headers: Headers,
  options: { readonly omitCompression?: boolean; readonly omitHost?: boolean } = {},
) {
  const filtered = new Headers();
  for (const [name, value] of headers) {
    const normalized = name.toLowerCase();
    if (
      (options.omitHost && normalized === "host") ||
      (options.omitCompression &&
        (normalized === "content-encoding" || normalized === "content-length")) ||
      HOP_BY_HOP_HEADERS.has(normalized) ||
      INBOUND_CREDENTIAL_HEADERS[normalized]
    ) {
      continue;
    }
    filtered.append(name, value);
  }
  return filtered;
}

function normalizedBaseUrl(value: string | undefined) {
  if (!value?.trim()) return undefined;
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Model gateway base URL must be an HTTP or HTTPS origin path.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return parsed;
}

async function privateHttpDestination(hostname: string, dnsLookup: typeof lookup) {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  const family = net.isIP(normalized);
  if (family !== 0) {
    if (family !== 4 || isPublicIpAddress(normalized)) {
      throw new Error("Plaintext model gateways must use private IPv4 destinations.");
    }
    return { address: normalized, family };
  }
  const addresses = await dnsLookup(normalized, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPublicIpAddress(address))) {
    throw new Error("Plaintext model gateways must resolve only to private addresses.");
  }
  const ipv4 = addresses.find(({ address }) => net.isIP(address) === 4);
  if (!ipv4) throw new Error("Plaintext model gateways require private IPv4 connectivity.");
  return ipv4;
}

function requestUrl(base: URL, request: Request, destination?: { readonly address: string }) {
  const incoming = new URL(request.url);
  const target = new URL(base);
  const prefix = base.pathname === "/" ? "" : base.pathname;
  target.pathname = `${prefix}${incoming.pathname}`.replaceAll(/\/{2,}/gu, "/");
  target.search = incoming.search;
  if (destination) target.hostname = destination.address;
  return target;
}

export function createModelGatewayProxy(options: ModelGatewayProxyOptions = {}) {
  const base = normalizedBaseUrl(options.baseUrl);
  const token = options.token ?? webToolsServiceToken(options.tokenIssuer);
  const dnsLookup = options.lookup ?? lookup;
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 600_000, 600_000));

  return Bun.serve({
    fetch: async (request) => {
      if (!base || !token) {
        return new Response(null, {
          headers: { "cache-control": "no-store", connection: "close" },
          status: 503,
        });
      }
      try {
        const destination =
          base.protocol === "http:"
            ? await privateHttpDestination(base.hostname, dnsLookup)
            : undefined;
        const headers = filteredHeaders(request.headers, { omitHost: true });
        headers.set("authorization", `Bearer ${await token()}`);
        headers.set("host", base.host);
        const upstream = await fetch(requestUrl(base, request, destination), {
          ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }),
          headers,
          method: request.method,
          redirect: "manual",
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
        });
        if (upstream.status >= 300 && upstream.status < 400) {
          await upstream.body?.cancel();
          return new Response(null, {
            headers: { "cache-control": "no-store", connection: "close" },
            status: 502,
          });
        }
        return new Response(upstream.body, {
          headers: filteredHeaders(upstream.headers, { omitCompression: true }),
          status: upstream.status,
          statusText: upstream.statusText,
        });
      } catch {
        return new Response(null, {
          headers: { "cache-control": "no-store", connection: "close" },
          status: 502,
        });
      }
    },
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
  });
}
