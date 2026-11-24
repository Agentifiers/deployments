import { describe, expect, test } from "bun:test";

import { TeamsIngressError, teamsBotFrameworkTokenVerifier } from "./bot-framework-auth.ts";
import {
  fakeBotFrameworkKeyServer,
  TEST_APP_ID,
  TEST_SERVICE_URL,
  testSigningKey,
} from "./bot-framework-auth.fixture.ts";

const nowSeconds = () => Math.floor(Date.now() / 1_000);

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(TeamsIngressError);
  return (error as TeamsIngressError).status;
}

describe("Bot Framework token verification", () => {
  test("accepts a token signed by an endorsed key for the bot audience and serviceUrl", async () => {
    const key = await testSigningKey("kid-valid");
    const server = fakeBotFrameworkKeyServer([key.jwk]);
    const verifier = teamsBotFrameworkTokenVerifier({ fetch: server.fetch });
    const input = {
      appId: TEST_APP_ID,
      authorization: `Bearer ${await key.sign()}`,
      channelId: "msteams",
      serviceUrl: TEST_SERVICE_URL,
    };
    await verifier.verify(input);
    await verifier.verify(input);
    expect(server.state.jwksRequests).toBe(1);
  });

  test("rejects missing bearer tokens, wrong audience, and wrong issuer with 401", async () => {
    const key = await testSigningKey("kid-claims");
    const verifier = teamsBotFrameworkTokenVerifier({
      fetch: fakeBotFrameworkKeyServer([key.jwk]).fetch,
    });
    const base = { appId: TEST_APP_ID, channelId: "msteams", serviceUrl: TEST_SERVICE_URL };
    expect(await rejection(verifier.verify({ ...base, authorization: undefined }))).toBe(401);
    expect(
      await rejection(verifier.verify({ ...base, authorization: `Basic ${await key.sign()}` })),
    ).toBe(401);
    expect(
      await rejection(
        verifier.verify({
          ...base,
          authorization: `Bearer ${await key.sign({ audience: "another-bot" })}`,
        }),
      ),
    ).toBe(401);
    expect(
      await rejection(
        verifier.verify({
          ...base,
          authorization: `Bearer ${await key.sign({ issuer: "https://sts.windows.net/tenant/" })}`,
        }),
      ),
    ).toBe(401);
  });

  test("applies five minutes of clock skew to exp and nbf", async () => {
    const key = await testSigningKey("kid-time");
    const verifier = teamsBotFrameworkTokenVerifier({
      fetch: fakeBotFrameworkKeyServer([key.jwk]).fetch,
    });
    const base = { appId: TEST_APP_ID, channelId: "msteams", serviceUrl: TEST_SERVICE_URL };
    await verifier.verify({
      ...base,
      authorization: `Bearer ${await key.sign({ expiresAt: nowSeconds() - 200 })}`,
    });
    expect(
      await rejection(
        verifier.verify({
          ...base,
          authorization: `Bearer ${await key.sign({ expiresAt: nowSeconds() - 400 })}`,
        }),
      ),
    ).toBe(401);
    expect(
      await rejection(
        verifier.verify({
          ...base,
          authorization: `Bearer ${await key.sign({ notBefore: nowSeconds() + 400 })}`,
        }),
      ),
    ).toBe(401);
  });

  test("returns 403 when the signing key is not endorsed for the activity channel", async () => {
    const key = await testSigningKey("kid-endorse", ["skype"]);
    const verifier = teamsBotFrameworkTokenVerifier({
      fetch: fakeBotFrameworkKeyServer([key.jwk]).fetch,
    });
    expect(
      await rejection(
        verifier.verify({
          appId: TEST_APP_ID,
          authorization: `Bearer ${await key.sign()}`,
          channelId: "msteams",
          serviceUrl: TEST_SERVICE_URL,
        }),
      ),
    ).toBe(403);
  });

  test("rejects a token whose serviceUrl claim differs from the activity", async () => {
    const key = await testSigningKey("kid-service");
    const verifier = teamsBotFrameworkTokenVerifier({
      fetch: fakeBotFrameworkKeyServer([key.jwk]).fetch,
    });
    expect(
      await rejection(
        verifier.verify({
          appId: TEST_APP_ID,
          authorization: `Bearer ${await key.sign()}`,
          channelId: "msteams",
          serviceUrl: "https://smba.trafficmanager.net/emea/",
        }),
      ),
    ).toBe(401);
  });

  test("rejects signatures from a key that is not the advertised key for the kid", async () => {
    const advertised = await testSigningKey("kid-shared");
    const forger = await testSigningKey("kid-shared");
    const verifier = teamsBotFrameworkTokenVerifier({
      fetch: fakeBotFrameworkKeyServer([advertised.jwk]).fetch,
    });
    expect(
      await rejection(
        verifier.verify({
          appId: TEST_APP_ID,
          authorization: `Bearer ${await forger.sign()}`,
          channelId: "msteams",
          serviceUrl: TEST_SERVICE_URL,
        }),
      ),
    ).toBe(401);
  });

  test("refreshes keys once for an unknown kid and rate-limits further refreshes", async () => {
    const original = await testSigningKey("kid-original");
    const rotated = await testSigningKey("kid-rotated");
    const later = await testSigningKey("kid-later");
    const server = fakeBotFrameworkKeyServer([original.jwk]);
    let clock = Date.now();
    const verifier = teamsBotFrameworkTokenVerifier({ fetch: server.fetch, now: () => clock });
    const base = { appId: TEST_APP_ID, channelId: "msteams", serviceUrl: TEST_SERVICE_URL };
    await verifier.verify({ ...base, authorization: `Bearer ${await original.sign()}` });
    expect(server.state.jwksRequests).toBe(1);

    server.state.keys = [original.jwk, rotated.jwk];
    clock += 6 * 60 * 1_000;
    await verifier.verify({ ...base, authorization: `Bearer ${await rotated.sign()}` });
    expect(server.state.jwksRequests).toBe(2);

    server.state.keys = [original.jwk, rotated.jwk, later.jwk];
    expect(
      await rejection(verifier.verify({ ...base, authorization: `Bearer ${await later.sign()}` })),
    ).toBe(401);
    expect(server.state.jwksRequests).toBe(2);
  });

  test("backs off key downloads for 30 seconds after a failed cold-start fetch", async () => {
    const key = await testSigningKey("kid-cold");
    const server = fakeBotFrameworkKeyServer([key.jwk]);
    server.state.unavailable = true;
    let clock = Date.now();
    const verifier = teamsBotFrameworkTokenVerifier({ fetch: server.fetch, now: () => clock });
    const input = {
      appId: TEST_APP_ID,
      authorization: `Bearer ${await key.sign()}`,
      channelId: "msteams",
      serviceUrl: TEST_SERVICE_URL,
    };
    const unavailable = async () => {
      const error = await verifier.verify(input).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(TeamsIngressError);
    };

    await unavailable();
    expect(server.state.requests).toBe(1);
    clock += 29_000;
    await unavailable();
    await unavailable();
    expect(server.state.requests).toBe(1);

    server.state.unavailable = false;
    clock += 1_000;
    await verifier.verify(input);
    expect(server.state.requests).toBe(3);
    expect(server.state.jwksRequests).toBe(1);
  });

  test("keeps serving cached keys after the TTL while refreshes fail and back off", async () => {
    const key = await testSigningKey("kid-stale");
    const server = fakeBotFrameworkKeyServer([key.jwk]);
    let clock = Date.now();
    const verifier = teamsBotFrameworkTokenVerifier({ fetch: server.fetch, now: () => clock });
    const input = {
      appId: TEST_APP_ID,
      // Outlives the simulated 24h key TTL so only key availability decides the outcome.
      authorization: `Bearer ${await key.sign({ expiresAt: nowSeconds() + 2 * 24 * 60 * 60 })}`,
      channelId: "msteams",
      serviceUrl: TEST_SERVICE_URL,
    };
    await verifier.verify(input);
    expect(server.state.requests).toBe(2);

    server.state.unavailable = true;
    clock += 24 * 60 * 60 * 1_000;
    await verifier.verify(input);
    expect(server.state.requests).toBe(3);
    clock += 10_000;
    await verifier.verify(input);
    await verifier.verify(input);
    expect(server.state.requests).toBe(3);

    clock += 20_000;
    await verifier.verify(input);
    expect(server.state.requests).toBe(4);
  });
});
