import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, resolveContext, updateProfile } from "./config.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface DeviceApi {
  readonly token: (exchange: number, refreshToken: string) => Response | Promise<Response>;
  readonly whoami?: (call: number) => Response | Promise<Response>;
}

async function expiringDeviceProfile(api: DeviceApi) {
  const directory = await mkdtemp(join(tmpdir(), "deployments-cli-refresh-retry-"));
  const env = { DEPLOYMENTS_CONFIG_DIR: directory, NO_COLOR: "1" };
  const refreshTokens: string[] = [];
  let whoamiCalls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/v1/device-authorizations/token") {
        const body: unknown = await request.json();
        const refreshToken =
          typeof body === "object" && body !== null && "refreshToken" in body
            ? String(body.refreshToken)
            : "missing";
        refreshTokens.push(refreshToken);
        return api.token(refreshTokens.length, refreshToken);
      }
      whoamiCalls += 1;
      return api.whoami?.(whoamiCalls) ?? Response.json({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAY" });
    },
  });
  cleanups.push(
    () => server.stop(true),
    () => rm(directory, { force: true, recursive: true }),
  );
  await updateProfile(
    "default",
    {
      apiKey: "expired.payload.signature",
      apiKeyExpiresAt: "2026-01-01T00:00:00.000Z",
      apiUrl: server.url.toString(),
      mock: false,
      refreshToken: "refresh-token",
    },
    env,
  );
  const refresh = (deviceRefreshTimeoutMs = 5_000) =>
    resolveContext({}, env, { deviceRefreshTimeoutMs, refreshDeviceCredential: true }).then(
      (context) => context.apiKey,
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
  const storedProfile = async () =>
    JSON.parse(await readFile(configPath(env), "utf8")).profiles.default as Record<string, unknown>;
  return { env, refresh, refreshTokens, storedProfile };
}

const refreshedToken = (exchange: number) =>
  Response.json({
    bearerToken: `refreshed-${exchange}.payload.signature`,
    expiresIn: 600,
    refreshToken: `rotated-refresh-token-${exchange}`,
    tokenType: "Bearer",
  });

const unavailable = () =>
  Response.json(
    {
      code: "device_authorization_unavailable",
      detail: "The identity provider is unavailable.",
      status: 503,
      title: "Service Unavailable",
    },
    { status: 503 },
  );

describe("device credential refresh after a transient failure", () => {
  test.each([
    ["a 503", unavailable],
    [
      "a 200 cut off before its body",
      () => new Response(null, { headers: { "content-type": "application/json" } }),
    ],
    [
      "a 200 cut off inside its body",
      () =>
        new Response('{"bearerToken":"refreshed-1.payl', {
          headers: { "content-type": "application/json" },
        }),
    ],
  ])("retries a rotation lost to %s inside the reuse window", async (_, lostAnswer) => {
    const identity = {
      compromised: false,
      live: "refresh-token",
      previous: undefined as string | undefined,
      rotatedAt: 0,
      rotations: 0,
    };
    const device = await expiringDeviceProfile({
      token: (exchange, refreshToken) => {
        if (refreshToken === identity.live) {
          identity.previous = refreshToken;
          identity.rotatedAt = Date.now();
        } else if (refreshToken !== identity.previous || Date.now() - identity.rotatedAt > 60_000) {
          identity.compromised = true;
          return Response.json({ code: "invalid_grant" }, { status: 400 });
        }
        identity.rotations += 1;
        identity.live = `rotated-refresh-token-${identity.rotations}`;
        if (exchange === 1) return lostAnswer();
        return Response.json({
          bearerToken: `refreshed-${exchange}.payload.signature`,
          expiresIn: 600,
          refreshToken: identity.live,
          tokenType: "Bearer",
        });
      },
    });

    expect(await device.refresh()).toBe("refreshed-2.payload.signature");
    expect(device.refreshTokens).toEqual(["refresh-token", "refresh-token"]);
    expect(identity.compromised).toBe(false);
    expect(await device.storedProfile()).toMatchObject({
      apiKey: "refreshed-2.payload.signature",
      refreshToken: "rotated-refresh-token-2",
    });
  });

  // Real timers: Bun cancels an AbortSignal.timeout timer once its last abort listener is removed.
  test("stops a resend that is still unanswered at the refresh deadline", async () => {
    const device = await expiringDeviceProfile({
      token: (exchange) => (exchange === 1 ? unavailable() : new Promise<Response>(() => {})),
    });

    const startedAt = performance.now();
    const outcome = await device.refresh(600);
    const elapsedMs = performance.now() - startedAt;

    expect(outcome).toBe("rejected: Unable to reach the Deployments.ai API.");
    expect(elapsedMs).toBeLessThan(900);
    expect(device.refreshTokens).toEqual(["refresh-token", "refresh-token"]);
    expect(await device.storedProfile()).toMatchObject({
      apiKey: "expired.payload.signature",
      refreshToken: "refresh-token",
    });
  });

  test("stops identity validation that is still unanswered at the refresh deadline", async () => {
    const device = await expiringDeviceProfile({
      token: (exchange) => (exchange === 1 ? unavailable() : refreshedToken(exchange)),
      whoami: () => new Promise<Response>(() => {}),
    });

    const startedAt = performance.now();
    const outcome = await device.refresh(600);
    const elapsedMs = performance.now() - startedAt;

    expect(outcome).toBe("rejected: Unable to reach the Deployments.ai API.");
    expect(elapsedMs).toBeLessThan(900);
    expect(await device.storedProfile()).toMatchObject({
      apiKey: "expired.payload.signature",
      refreshToken: "rotated-refresh-token-2",
    });
  });

  test("keeps the stored credential when the token endpoint stays unavailable", async () => {
    const device = await expiringDeviceProfile({
      token: (exchange) => (exchange <= 3 ? unavailable() : refreshedToken(exchange)),
    });

    expect(await device.refresh()).toBe("rejected: The identity provider is unavailable.");
    expect(device.refreshTokens).toEqual(["refresh-token", "refresh-token", "refresh-token"]);
    expect(await device.storedProfile()).toMatchObject({
      apiKey: "expired.payload.signature",
      refreshToken: "refresh-token",
    });
    expect(await device.refresh()).toBe("refreshed-4.payload.signature");
    expect(await device.storedProfile()).toMatchObject({
      apiKey: "refreshed-4.payload.signature",
      refreshToken: "rotated-refresh-token-4",
    });
  });

  test("returns the new login when a rejection arrives after the user logged in again", async () => {
    let logInAgain = async () => {};
    const device = await expiringDeviceProfile({
      token: async () => {
        await logInAgain();
        return Response.json(
          { code: "invalid_grant", detail: "Refresh token is invalid." },
          { status: 400 },
        );
      },
    });
    logInAgain = async () => {
      await updateProfile(
        "default",
        {
          apiKey: "new-login.payload.signature",
          apiKeyExpiresAt: "2099-01-01T00:00:00.000Z",
          refreshToken: "new-login-refresh-token",
        },
        device.env,
      );
    };

    expect(await device.refresh()).toBe("new-login.payload.signature");
    const stored = await device.storedProfile();
    expect([stored.apiKey, stored.refreshToken, stored.credentialState]).toEqual([
      "new-login.payload.signature",
      "new-login-refresh-token",
      undefined,
    ]);
  });

  test("refreshes again on the next call after the token request times out", async () => {
    const device = await expiringDeviceProfile({
      token: (exchange) =>
        exchange === 1 ? new Promise<Response>(() => {}) : refreshedToken(exchange),
    });

    expect(await device.refresh(20)).toStartWith("rejected: ");
    expect(await device.refresh()).toBe("refreshed-2.payload.signature");
    expect(device.refreshTokens).toEqual(["refresh-token", "refresh-token"]);
  });

  test("keeps the rotated refresh token when identity validation fails after the exchange", async () => {
    const device = await expiringDeviceProfile({
      token: refreshedToken,
      whoami: (call) =>
        call === 1
          ? Response.json({ title: "Service Unavailable", status: 503 }, { status: 503 })
          : Response.json({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAY" }),
    });

    expect(await device.refresh()).toStartWith("rejected: ");
    expect(await device.storedProfile()).toMatchObject({
      apiKey: "expired.payload.signature",
      refreshToken: "rotated-refresh-token-1",
    });
    expect(await device.refresh()).toBe("refreshed-2.payload.signature");
    expect(device.refreshTokens).toEqual(["refresh-token", "rotated-refresh-token-1"]);
  });
});
