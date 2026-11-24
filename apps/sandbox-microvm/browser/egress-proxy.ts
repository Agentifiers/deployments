// Loopback HTTP proxy that Chromium uses for every request in any-public mode. Each destination is
// resolved here and the connection goes to the resolved address only when every answer is public,
// so a public-looking name that resolves (or rebinds) to loopback, the guest's own interface, a
// private network, or link-local metadata is refused for every frame, subresource, and websocket.

import { lookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { isPublicAddress, normalizeHost } from "./job-rules.ts";

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
const CONNECT_TIMEOUT_MS = 15_000;
/**
 * Set on the proxy's own refusal of a plain-http request. Chromium renders that 403 as a loaded
 * page, so the driver reads this header to tell a refused main frame from a site's own 403.
 */
export const EGRESS_REFUSED_HEADER = "x-deployments-egress-refused";

export type EgressLookup = (
  hostname: string,
  options: { readonly all: true; readonly verbatim: true },
) => Promise<readonly { readonly address: string; readonly family: number }[]>;

class EgressDenied extends Error {}

export interface BrowserEgressProxy {
  /** `http://127.0.0.1:<port>`, for Chromium's `--proxy-server`. */
  readonly url: string;
  readonly close: () => Promise<void>;
}

function defaultPort(protocol: string) {
  return protocol === "https:" || protocol === "wss:" ? 443 : 80;
}

/** `host:port` of an origin, matching how proxy requests name their destination. */
function authorityKey(hostname: string, port: number) {
  return `${normalizeHost(hostname)}:${port}`;
}

/**
 * Starts the proxy on an ephemeral loopback port. `exactOrigins` are origins the worker already
 * validated (the thread sandbox's own `http://127.0.0.1:<port>` server); they connect as named.
 * Every other destination must resolve exclusively to public addresses. `onDenied` receives the
 * host of each refused destination; DNS failures are not denials.
 */
export async function startBrowserEgressProxy(options: {
  readonly exactOrigins: Iterable<string>;
  readonly lookup?: EgressLookup;
  readonly onDenied?: (host: string) => void;
}): Promise<BrowserEgressProxy> {
  const dnsLookup: EgressLookup = options.lookup ?? ((hostname, flags) => lookup(hostname, flags));
  const exact = new Set(
    [...options.exactOrigins].map((origin) => {
      const parsed = new URL(origin);
      return authorityKey(
        parsed.hostname,
        parsed.port ? Number(parsed.port) : defaultPort(parsed.protocol),
      );
    }),
  );

  const destination = async (hostname: string, port: number) => {
    const host = normalizeHost(hostname);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new EgressDenied();
    if (exact.has(authorityKey(host, port))) return { address: host, family: net.isIP(host) || 4 };
    if (net.isIP(host) !== 0) {
      if (!isPublicAddress(host)) throw new EgressDenied();
      return { address: host, family: net.isIP(host) };
    }
    if (!host || host === "localhost" || host.endsWith(".localhost")) throw new EgressDenied();
    const addresses = await dnsLookup(host, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new EgressDenied();
    }
    return addresses.find(({ family }) => family === 4) ?? addresses[0]!;
  };

  const refused = (cause: unknown, host: string | undefined) => {
    if (cause instanceof EgressDenied && host !== undefined)
      options.onDenied?.(normalizeHost(host));
    return cause instanceof EgressDenied ? 403 : 502;
  };

  const server = http.createServer(async (request, response) => {
    let host: string | undefined;
    try {
      const target = new URL(request.url ?? "");
      host = target.hostname;
      if (target.protocol !== "http:") throw new EgressDenied();
      const port = target.port ? Number(target.port) : 80;
      const resolved = await destination(target.hostname, port);
      const upstream = http.request(
        {
          family: resolved.family,
          headers: {
            ...Object.fromEntries(
              Object.entries(request.headers).filter(
                ([name, value]) => !HOP_BY_HOP_HEADERS.has(name) && value !== undefined,
              ),
            ),
            host: target.host,
          },
          host: resolved.address,
          method: request.method,
          path: `${target.pathname}${target.search}`,
          port,
          timeout: CONNECT_TIMEOUT_MS,
        },
        (upstreamResponse) => {
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            Object.fromEntries(
              Object.entries(upstreamResponse.headers).filter(
                ([name, value]) => !HOP_BY_HOP_HEADERS.has(name) && value !== undefined,
              ),
            ),
          );
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    } catch (cause) {
      const status = refused(cause, host);
      response.writeHead(status, {
        connection: "close",
        ...(status === 403 ? { [EGRESS_REFUSED_HEADER]: "1" } : {}),
      });
      response.end();
    }
  });

  server.on("connect", (request: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    void (async () => {
      let host: string | undefined;
      try {
        const target = new URL(`http://${request.url ?? ""}`);
        host = target.hostname;
        const port = target.port ? Number(target.port) : 443;
        const resolved = await destination(target.hostname, port);
        const upstream = net.connect({
          family: resolved.family,
          host: resolved.address,
          port,
          timeout: CONNECT_TIMEOUT_MS,
        });
        upstream.once("connect", () => {
          upstream.setTimeout(0);
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.once("timeout", () => upstream.destroy());
        upstream.once("error", () => client.destroy());
        client.once("error", () => upstream.destroy());
      } catch (cause) {
        const status = refused(cause, host);
        client.end(
          `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Gateway"}\r\nConnection: close\r\n\r\n`,
        );
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as net.AddressInfo;
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    url: `http://127.0.0.1:${address.port}`,
  };
}
