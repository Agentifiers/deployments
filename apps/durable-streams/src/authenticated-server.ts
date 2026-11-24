import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as createUpstreamRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { DurableStreamTestServer } from "@durable-streams/server";

import type { DurableStreamsRuntimeConfig } from "./config.ts";

function authorized(header: string | undefined, token: string): boolean {
  const candidate = header?.match(/^Bearer\s+(.+)$/iu)?.[1]?.trim();
  if (!candidate) return false;
  const actual = Buffer.from(candidate);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function upstreamHeaders(headers: IncomingHttpHeaders, host: string): IncomingHttpHeaders {
  const forwarded: Record<string, string | string[] | undefined> = { ...headers, host };
  delete forwarded.connection;
  delete forwarded["proxy-authorization"];
  delete forwarded["proxy-connection"];
  delete forwarded["transfer-encoding"];
  return forwarded;
}

export function originFormTarget(value: string | undefined): string {
  const target = value ?? "/";
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\")) {
    throw new TypeError("Durable Streams request target must use origin form.");
  }
  const parsed = new URL(target, "http://durable-streams.local");
  if (parsed.origin !== "http://durable-streams.local" || parsed.hash) {
    throw new TypeError("Durable Streams request target must use origin form.");
  }
  return `${parsed.pathname}${parsed.search}`;
}

export function durableStreamsServerUrl(host: string, port: number): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export class AuthenticatedDurableStreamsServer {
  readonly #backend: DurableStreamTestServer;
  readonly #config: DurableStreamsRuntimeConfig;
  #backendUrl: URL | undefined;
  #server: Server | undefined;

  constructor(config: DurableStreamsRuntimeConfig) {
    this.#config = config;
    this.#backend = new DurableStreamTestServer({
      dataDir: config.dataDir,
      host: "127.0.0.1",
      longPollTimeout: config.longPollTimeoutMs,
      port: 0,
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let target: string;
    try {
      target = originFormTarget(request.url);
    } catch {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("Invalid request target");
      return;
    }
    const path = new URL(target, "http://durable-streams.local").pathname;
    if (request.method === "GET" && path === "/healthz") {
      response.writeHead(200, { "cache-control": "no-store", "content-type": "text/plain" });
      response.end("ok");
      return;
    }
    if (path.startsWith("/_test/")) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not found");
      return;
    }
    if (!authorized(request.headers.authorization, this.#config.authToken)) {
      response.writeHead(401, {
        "cache-control": "no-store",
        "content-type": "text/plain",
        "www-authenticate": 'Bearer realm="durable-streams"',
      });
      response.end("Unauthorized");
      return;
    }
    const backendUrl = this.#backendUrl;
    if (!backendUrl) throw new Error("Durable Streams backend is not running.");
    const upstreamUrl = new URL(backendUrl);
    const parsedTarget = new URL(target, "http://durable-streams.local");
    upstreamUrl.pathname = parsedTarget.pathname;
    upstreamUrl.search = parsedTarget.search;
    const upstream = createUpstreamRequest(
      upstreamUrl,
      {
        headers: upstreamHeaders(request.headers, backendUrl.host),
        method: request.method,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", (cause) => {
      if (response.headersSent) {
        response.destroy(cause);
        return;
      }
      response.writeHead(502, { "content-type": "text/plain" });
      response.end("Durable Streams backend unavailable");
    });
    request.pipe(upstream);
  }

  async start(): Promise<string> {
    if (this.#server) throw new Error("Durable Streams server is already running.");
    this.#backendUrl = new URL(await this.#backend.start());
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((cause) => {
        if (response.headersSent) {
          response.destroy(cause instanceof Error ? cause : undefined);
          return;
        }
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("Internal server error");
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(this.#config.port, this.#config.host, resolve);
    });
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("Server address is unavailable.");
    return durableStreamsServerUrl(this.#config.host, address.port);
  }

  async stop(): Promise<void> {
    await closeServer(this.#server);
    this.#server = undefined;
    await this.#backend.stop();
    this.#backendUrl = undefined;
  }
}
