import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { lookup } from "node:dns/promises";
import type http from "node:http";
import net, { type AddressInfo } from "node:net";
import {
  createBrowserEgressProxy,
  resolveBrowserEgressDestination,
  type BrowserEgressDenialEvent,
} from "./egress-proxy.ts";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("browser egress proxy", () => {
  test("rejects IPv6 literals in the IPv4-only runtime without DNS lookup", async () => {
    let lookups = 0;
    expect(
      resolveBrowserEgressDestination("[2606:4700:4700::1111]", (async () => {
        lookups += 1;
        return [];
      }) as unknown as typeof lookup),
    ).rejects.toThrow("public IPv4");
    expect(lookups).toBe(0);
  });

  test("prefers a public IPv4 answer for dual-stack destinations", async () => {
    const destination = await resolveBrowserEgressDestination("example.com", (async () => [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as typeof lookup);

    expect(destination).toEqual({ address: "93.184.216.34", family: 4 });
  });

  test("rejects destinations with any non-public DNS answer", async () => {
    expect(
      resolveBrowserEgressDestination("example.com", (async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ]) as unknown as typeof lookup),
    ).rejects.toThrow("exclusively to public IPs");
  });

  test("blocks CONNECT destinations resolving to private addresses", async () => {
    const denials: BrowserEgressDenialEvent[] = [];
    const proxy = createBrowserEgressProxy({
      lookup: (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as typeof lookup,
      onDenied: (event) => denials.push(event),
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    servers.push(proxy);
    const port = (proxy.address() as AddressInfo).port;

    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      let body = "";
      socket.once("connect", () => {
        socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
      });
      socket.on("data", (chunk) => {
        body += chunk.toString("utf8");
      });
      socket.once("end", () => resolve(body));
      socket.once("error", reject);
    });

    expect(response).toStartWith("HTTP/1.1 403 Forbidden");
    expect(denials).toEqual([
      {
        destinationHash: createHash("sha256").update("example.com").digest("hex"),
        event: "browser-egress.denied",
        reason: "non-public-dns",
      },
    ]);
    expect(JSON.stringify(denials)).not.toContain("example.com");
  });
});
