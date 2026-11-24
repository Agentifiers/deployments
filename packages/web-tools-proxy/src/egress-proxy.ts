import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";
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

export interface BrowserEgressProxyOptions {
  readonly allowedPorts?: readonly number[];
  readonly connectTimeoutMs?: number;
  readonly lookup?: typeof lookup;
  readonly onDenied?: (event: BrowserEgressDenialEvent) => void;
}

export interface BrowserEgressDenialEvent {
  readonly destinationHash?: string;
  readonly event: "browser-egress.denied";
  readonly reason:
    | "invalid-target"
    | "no-public-ipv4"
    | "non-public-dns"
    | "non-public-ipv4"
    | "port-not-allowed"
    | "unsupported-protocol";
}

function normalizedHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
}

function denialReason(cause: unknown): BrowserEgressDenialEvent["reason"] {
  if (!(cause instanceof Error)) return "invalid-target";
  if (cause.message === "Browser egress destination is not a public IPv4 address.") {
    return "non-public-ipv4";
  }
  if (cause.message === "Browser egress destination did not resolve exclusively to public IPs.") {
    return "non-public-dns";
  }
  if (cause.message === "Browser egress destination has no public IPv4 address.") {
    return "no-public-ipv4";
  }
  if (cause.message === "Browser egress port is not allowed.") return "port-not-allowed";
  if (cause.message === "Unsupported proxy protocol.") return "unsupported-protocol";
  return "invalid-target";
}

function denialEvent(cause: unknown, hostname?: string): BrowserEgressDenialEvent {
  const normalized = hostname ? normalizedHostname(hostname) : undefined;
  return {
    ...(normalized
      ? { destinationHash: createHash("sha256").update(normalized).digest("hex") }
      : {}),
    event: "browser-egress.denied",
    reason: denialReason(cause),
  };
}

function defaultDenialLogger(event: BrowserEgressDenialEvent) {
  console.warn(JSON.stringify(event));
}

export async function resolveBrowserEgressDestination(
  hostname: string,
  dnsLookup: typeof lookup = lookup,
) {
  const normalized = normalizedHostname(hostname);
  const literalFamily = net.isIP(normalized);
  if (literalFamily !== 0) {
    if (literalFamily !== 4 || !isPublicIpAddress(normalized)) {
      throw new Error("Browser egress destination is not a public IPv4 address.");
    }
    return { address: normalized, family: literalFamily };
  }
  const addresses = await dnsLookup(normalized, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicIpAddress(normalizedHostname(address)))
  ) {
    throw new Error("Browser egress destination did not resolve exclusively to public IPs.");
  }
  const ipv4 = addresses.find(({ address }) => net.isIP(normalizedHostname(address)) === 4);
  if (!ipv4) throw new Error("Browser egress destination has no public IPv4 address.");
  return ipv4;
}

function filteredHeaders(headers: http.IncomingHttpHeaders) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined,
    ),
  );
}

function authority(value: string) {
  const parsed = new URL(`http://${value}`);
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 443;
  return { hostname: parsed.hostname, port };
}

export function createBrowserEgressProxy(options: BrowserEgressProxyOptions = {}) {
  const dnsLookup = options.lookup ?? lookup;
  const allowedPorts = new Set(options.allowedPorts ?? [80, 443]);
  const connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
  const onDenied = options.onDenied ?? defaultDenialLogger;

  const resolve = (hostname: string) => resolveBrowserEgressDestination(hostname, dnsLookup);
  const recordDenial = (cause: unknown, hostname?: string) => {
    try {
      onDenied(denialEvent(cause, hostname));
    } catch {
      // Denial evidence is diagnostic and must never prevent the fail-closed response.
    }
  };

  const server = http.createServer(async (request, response) => {
    let targetHostname: string | undefined;
    try {
      const target = new URL(request.url ?? "");
      targetHostname = target.hostname;
      if (target.protocol !== "http:") throw new Error("Unsupported proxy protocol.");
      const port = target.port ? Number.parseInt(target.port, 10) : 80;
      if (!allowedPorts.has(port)) throw new Error("Browser egress port is not allowed.");
      const destination = await resolve(target.hostname);
      const upstream = http.request(
        {
          family: destination.family,
          headers: { ...filteredHeaders(request.headers), host: target.host },
          hostname: destination.address,
          method: request.method,
          path: `${target.pathname}${target.search}`,
          port,
          timeout: connectTimeoutMs,
        },
        (upstreamResponse) => {
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            filteredHeaders(upstreamResponse.headers),
          );
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("timeout", () => upstream.destroy(new Error("Browser egress timed out.")));
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    } catch (cause) {
      recordDenial(cause, targetHostname);
      response.writeHead(403, { "cache-control": "no-store", connection: "close" });
      response.end();
    }
  });

  server.on("connect", (request, clientSocket, head) => {
    void (async () => {
      let targetHostname: string | undefined;
      try {
        const target = authority(request.url ?? "");
        targetHostname = target.hostname;
        if (!allowedPorts.has(target.port)) throw new Error("Browser egress port is not allowed.");
        const destination = await resolve(target.hostname);
        const upstreamSocket = net.connect({
          family: destination.family,
          host: destination.address,
          port: target.port,
          timeout: connectTimeoutMs,
        });
        upstreamSocket.once("connect", () => {
          upstreamSocket.setTimeout(0);
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) upstreamSocket.write(head);
          upstreamSocket.pipe(clientSocket);
          clientSocket.pipe(upstreamSocket);
        });
        upstreamSocket.once("timeout", () => upstreamSocket.destroy());
        upstreamSocket.once("error", () => clientSocket.destroy());
      } catch (cause) {
        recordDenial(cause, targetHostname);
        clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      }
    })();
  });

  server.headersTimeout = 20_000;
  server.requestTimeout = 70_000;
  return server;
}
