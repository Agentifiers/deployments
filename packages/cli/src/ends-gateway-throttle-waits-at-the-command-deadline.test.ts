import { PlatformTransportError } from "@agentifiers/deployments-sdk";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sdkFor } from "./command-runtime.ts";
import { resolveContext, updateProfile } from "./config.ts";

const realFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];
const temporaryServers: Bun.Server<undefined>[] = [];

afterEach(async () => {
  globalThis.fetch = realFetch;
  await Promise.all(temporaryServers.splice(0).map((server) => server.stop(true)));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function alwaysThrottled(onRequest: (count: number) => void = () => {}) {
  const received: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      received.push(`${request.method} ${new URL(request.url).pathname}`);
      onRequest(received.length);
      return new Response('{"message":"Too Many Requests"}', {
        headers: { "content-type": "application/json" },
        status: 429,
      });
    },
  });
  temporaryServers.push(server);
  return { origin: server.url.toString(), received };
}

/** Records, for each fetch the CLI starts, whether its deadline had already passed. */
function recordFetchDeadlines() {
  const passed: boolean[] = [];
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      passed.push(init?.signal?.aborted ?? false);
      return realFetch(input, init);
    },
    { preconnect: realFetch.preconnect },
  );
  return passed;
}

function causeName(failure: unknown) {
  return failure instanceof PlatformTransportError && failure.cause instanceof Error
    ? failure.cause.name
    : failure;
}

describe("API Gateway throttle waits", () => {
  it("end when the command deadline passes", async () => {
    const deadline = new AbortController();
    const api = alwaysThrottled((count) => {
      if (count !== 4) return;
      // The abort has to land after the fourth answer arrives, inside the real 2 s resend wait.
      setTimeout(() => deadline.abort(), 50);
    });
    const fetchDeadlinePassed = recordFetchDeadlines();

    const failure = await sdkFor(
      { apiUrl: api.origin, mock: false, profileName: "default" },
      { signal: deadline.signal },
    )
      .request({ method: "GET", path: "/v1/whoami" })
      .catch((error: unknown) => error);

    expect(causeName(failure)).toBe("AbortError");
    expect(api.received).toEqual([
      "GET /v1/whoami",
      "GET /v1/whoami",
      "GET /v1/whoami",
      "GET /v1/whoami",
    ]);
    expect(fetchDeadlinePassed).toEqual([false, false, false, false]);
  }, 15_000);

  it("end when the device refresh deadline passes", async () => {
    const api = alwaysThrottled();
    const directory = await mkdtemp(join(tmpdir(), "deployments-cli-"));
    temporaryDirectories.push(directory);
    const env = { DEPLOYMENTS_CONFIG_DIR: directory, NO_COLOR: "1" };
    await updateProfile(
      "default",
      {
        apiKey: "expired.payload.signature",
        apiKeyExpiresAt: "2026-01-01T00:00:00.000Z",
        apiUrl: api.origin,
        mock: false,
        refreshToken: "refresh-token",
      },
      env,
    );
    const fetchDeadlinePassed = recordFetchDeadlines();

    // A 3 s deadline lands inside the 2 s resend wait that starts 1.75 s after the first request.
    const failure = await resolveContext({}, env, {
      deviceRefreshTimeoutMs: 3_000,
      refreshDeviceCredential: true,
    }).catch((error: unknown) => error);

    expect(causeName(failure)).toBe("TimeoutError");
    expect(fetchDeadlinePassed.at(0)).toBe(false);
    expect(fetchDeadlinePassed.includes(true)).toBe(false);
  }, 15_000);
});
