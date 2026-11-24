import { afterEach, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import type { lookup } from "node:dns/promises";
import type { AddressInfo } from "node:net";
import http from "node:http";
import { createModelGatewayProxy } from "./model-gateway-proxy.ts";

const servers: http.Server[] = [];
const proxyServers: Bun.Server<undefined>[] = [];

afterEach(async () => {
  await Promise.all(proxyServers.splice(0).map((server) => server.stop(true)));
  for (const server of servers) server.closeAllConnections();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(server: http.Server) {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

const serviceToken = async () => "service-token";

describe("fixed model gateway proxy", () => {
  test("replaces inbound credentials with the web-tools service token", async () => {
    let received:
      | { authorization?: string; bifrostVirtualKey?: string; body: string; path: string }
      | undefined;
    const upstream = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        received = {
          ...(typeof request.headers.authorization === "string"
            ? { authorization: request.headers.authorization }
            : {}),
          ...(typeof request.headers["x-bf-vk"] === "string"
            ? { bifrostVirtualKey: request.headers["x-bf-vk"] }
            : {}),
          body,
          path: request.url ?? "",
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
      });
    });
    const upstreamPort = await listen(upstream);
    const proxy = createModelGatewayProxy({
      baseUrl: `http://model.internal:${upstreamPort}/v1`,
      lookup: (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as typeof lookup,
      token: serviceToken,
    });
    proxyServers.push(proxy);
    const proxyPort = proxy.port;

    const response = await fetch(`http://127.0.0.1:${proxyPort}/responses?trace=1`, {
      body: '{"model":"test"}',
      headers: {
        authorization: "Bearer firecrawl-placeholder",
        "content-type": "application/json",
        "x-bf-vk": "forged-virtual-key",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(received).toEqual({
      authorization: "Bearer service-token",
      body: '{"model":"test"}',
      path: "/v1/responses?trace=1",
    });
  });

  test("fails closed without leaking token issuer failures", async () => {
    let upstreamCalls = 0;
    const upstream = http.createServer((_request, response) => {
      upstreamCalls += 1;
      response.end();
    });
    const upstreamPort = await listen(upstream);
    const proxy = createModelGatewayProxy({
      baseUrl: `http://model.internal:${upstreamPort}/v1`,
      lookup: (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as typeof lookup,
      token: async () => {
        throw new Error("issuer arn:aws:lambda:secret-detail refused");
      },
    });
    proxyServers.push(proxy);

    const response = await fetch(`http://127.0.0.1:${proxy.port}/chat/completions`, {
      body: "{}",
      method: "POST",
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("");
    expect(upstreamCalls).toBe(0);
  });

  test("rejects plaintext public upstreams and missing configuration", async () => {
    const publicProxy = createModelGatewayProxy({
      baseUrl: "http://models.example.com/v1",
      token: serviceToken,
      lookup: (async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as typeof lookup,
    });
    proxyServers.push(publicProxy);
    const publicProxyPort = publicProxy.port;
    expect((await fetch(`http://127.0.0.1:${publicProxyPort}/responses`)).status).toBe(502);

    const disabledProxy = createModelGatewayProxy({ token: serviceToken });
    proxyServers.push(disabledProxy);
    const disabledProxyPort = disabledProxy.port;
    expect((await fetch(`http://127.0.0.1:${disabledProxyPort}/responses`)).status).toBe(503);

    const issuerlessProxy = createModelGatewayProxy({
      baseUrl: "http://model.internal/v1",
    });
    proxyServers.push(issuerlessProxy);
    expect((await fetch(`http://127.0.0.1:${issuerlessProxy.port}/responses`)).status).toBe(503);
  });

  test("does not expose upstream redirects to the internal Firecrawl client", async () => {
    const upstream = http.createServer((_request, response) => {
      response.writeHead(302, { location: "http://api:3002/private" });
      response.end();
    });
    const upstreamPort = await listen(upstream);
    const proxy = createModelGatewayProxy({
      baseUrl: `http://model.internal:${upstreamPort}/v1`,
      token: serviceToken,
      lookup: (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as typeof lookup,
    });
    proxyServers.push(proxy);

    const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, {
      redirect: "manual",
    });
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
  });

  test("removes stale compression headers after Bun decompresses the response", async () => {
    const compressed = gzipSync('{"ok":true}');
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, {
        "content-encoding": "gzip",
        "content-length": String(compressed.byteLength),
        "content-type": "application/json",
      });
      response.end(compressed);
    });
    const upstreamPort = await listen(upstream);
    const proxy = createModelGatewayProxy({
      baseUrl: `http://model.internal:${upstreamPort}/v1`,
      token: serviceToken,
      lookup: (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as typeof lookup,
    });
    proxyServers.push(proxy);

    const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBe(String('{"ok":true}'.length));
  });

  test("cancels the upstream model request when the downstream disconnects", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const upstream = http.createServer((request) => {
      request.resume();
      request.once("end", () => markStarted?.());
    });
    const upstreamPort = await listen(upstream);
    const proxy = createModelGatewayProxy({
      baseUrl: `http://model.internal:${upstreamPort}/v1`,
      token: serviceToken,
      lookup: (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as typeof lookup,
    });
    proxyServers.push(proxy);
    const proxyPort = proxy.port;
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${proxyPort}/responses`, {
      body: '{"model":"test"}',
      method: "POST",
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await started;
    controller.abort();
    expect(await pending).toBeInstanceOf(Error);
    servers.splice(servers.indexOf(upstream), 1);
    await Promise.race([
      new Promise<void>((resolve) => upstream.close(() => resolve())),
      Bun.sleep(1_000).then(() => {
        throw new Error("Upstream request was not canceled.");
      }),
    ]);
  });
});
