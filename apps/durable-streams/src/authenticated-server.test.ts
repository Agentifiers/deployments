import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AuthenticatedDurableStreamsServer,
  durableStreamsServerUrl,
  originFormTarget,
} from "./authenticated-server.ts";

const servers: AuthenticatedDurableStreamsServer[] = [];
const directories: string[] = [];

function rawStatus(baseUrl: string, path: string, authorization: string) {
  const url = new URL(baseUrl);
  return new Promise<number>((resolve, reject) => {
    const outgoing = request(
      {
        headers: { authorization },
        host: url.hostname,
        method: "GET",
        path,
        port: url.port,
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("authenticated Durable Streams server", () => {
  test("formats supported IPv4 and IPv6 listener URLs", () => {
    expect(durableStreamsServerUrl("127.0.0.1", 4437)).toBe("http://127.0.0.1:4437");
    expect(durableStreamsServerUrl("::1", 4437)).toBe("http://[::1]:4437");
  });

  test("allows health checks but requires bearer auth for the data plane", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "durable-streams-"));
    directories.push(dataDir);
    const token = "test-token-with-at-least-thirty-two-characters";
    const server = new AuthenticatedDurableStreamsServer({
      authToken: token,
      dataDir,
      host: "127.0.0.1",
      longPollTimeoutMs: 100,
      port: 0,
    });
    servers.push(server);
    const baseUrl = await server.start();

    expect(fetch(`${baseUrl}/healthz`).then((response) => response.status)).resolves.toBe(200);
    expect(fetch(`${baseUrl}/v1/stream/test`).then((response) => response.status)).resolves.toBe(
      401,
    );
    expect(
      fetch(`${baseUrl}/v1/stream/test`, {
        headers: { authorization: `Bearer ${token}` },
        method: "HEAD",
      }).then((response) => response.status),
    ).resolves.toBe(404);
    expect(
      fetch(`${baseUrl}/_test/inject-error`, {
        headers: { authorization: `Bearer ${token}` },
      }).then((response) => response.status),
    ).resolves.toBe(404);
    expect(
      rawStatus(baseUrl, "http://169.254.169.254/latest/meta-data", `Bearer ${token}`),
    ).resolves.toBe(400);
    expect(() => originFormTarget("//example.invalid/stream")).toThrow("origin form");
  });
});
