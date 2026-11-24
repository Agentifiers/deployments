import { afterEach, describe, expect, test } from "bun:test";
import http from "node:http";
import net from "node:net";
import {
  EGRESS_REFUSED_HEADER,
  startBrowserEgressProxy,
  type EgressLookup,
} from "./egress-proxy.ts";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function originServer() {
  const server = http.createServer((request, response) => {
    response.end(`origin saw ${request.headers.host}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanup.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

async function proxy(exactOrigins: readonly string[], answers: Record<string, string[]> = {}) {
  const denied: string[] = [];
  const lookup: EgressLookup = async (hostname) => {
    const addresses = answers[hostname];
    if (!addresses) throw new Error(`unexpected lookup of ${hostname}`);
    return addresses.map((address) => ({ address, family: net.isIP(address) }));
  };
  const started = await startBrowserEgressProxy({
    exactOrigins,
    lookup,
    onDenied: (host) => denied.push(host),
  });
  cleanup.push(started.close);
  return { denied, url: new URL(started.url) };
}

/** Sends an absolute-form proxy request, as Chromium does for plain http. */
function viaProxy(proxyUrl: URL, target: string) {
  return new Promise<{ body: string; refused: boolean; status: number }>((resolve, reject) => {
    const request = http.request(
      {
        host: proxyUrl.hostname,
        path: target,
        port: proxyUrl.port,
        headers: { host: new URL(target).host },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({
            body,
            refused: response.headers[EGRESS_REFUSED_HEADER] === "1",
            status: response.statusCode ?? 0,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/** Opens a CONNECT tunnel, as Chromium does for https and wss, and returns the status line. */
function connectVia(proxyUrl: URL, authority: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname, () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    socket.once("data", (chunk) => {
      resolve(chunk.toString("latin1").split("\r\n")[0] ?? "");
      socket.destroy();
    });
    socket.on("error", reject);
  });
}

describe("browser egress proxy", () => {
  test("connects to the exact allowed sandbox origin as named", async () => {
    const origin = await originServer();
    const { url } = await proxy([origin]);

    expect(await viaProxy(url, `${origin}/`)).toEqual({
      body: `origin saw ${new URL(origin).host}`,
      refused: false,
      status: 200,
    });
  });

  test("refuses names that resolve to any non-public address, even alongside a public one", async () => {
    const origin = await originServer();
    const port = new URL(origin).port;
    const { denied, url } = await proxy([], {
      "rebind.example": ["127.0.0.1"],
      "metadata.example": ["169.254.169.254"],
      "mixed.example": ["93.184.216.34", "10.0.0.5"],
      "ula.example": ["fd00::1"],
    });

    for (const host of ["rebind.example", "metadata.example", "mixed.example", "ula.example"]) {
      const { refused, status } = await viaProxy(url, `http://${host}:${port}/`);
      // Chromium renders a plain-http 403 as a page; the header is how the driver tells it apart.
      expect({ host, refused, status }).toEqual({ host, refused: true, status: 403 });
      expect(await connectVia(url, `${host}:443`)).toBe("HTTP/1.1 403 Forbidden");
    }
    expect(denied).toContain("rebind.example");
  });

  test("refuses local and private IP literals and localhost, including the control server", async () => {
    const origin = await originServer();
    const { url } = await proxy([origin]);
    const otherPort = Number(new URL(origin).port) + 1;

    for (const target of [
      "http://127.0.0.1:8080/__sandbox/exec",
      `http://127.0.0.1:${otherPort}/`,
      "http://localhost:8080/",
      "http://10.0.3.7:8080/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]:8080/",
    ]) {
      expect({ status: (await viaProxy(url, target)).status, target }).toEqual({
        status: 403,
        target,
      });
    }
    for (const authority of ["127.0.0.1:8080", "localhost:443", "[::ffff:7f00:1]:443"]) {
      expect(await connectVia(url, authority)).toBe("HTTP/1.1 403 Forbidden");
    }
  });
});
