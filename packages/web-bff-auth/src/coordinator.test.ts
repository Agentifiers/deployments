import { describe, expect, test } from "bun:test";
import {
  type CallbackFailureReason,
  type CompleteCallbackInput as CallbackInput,
  WebBffCallbackError,
  WebBffReauthenticationRequiredError,
} from "./coordinator.ts";
import {
  makeWebBffTestHarness,
  type WebBffTestHarness,
  type WebBffTestHarnessOptions,
} from "./testing/fake-identity.ts";

const PRINCIPAL = "01JZ8Y7Q3M2K4N6P8R0T2V4X6Z";
const FAST_WAIT = {
  refreshWaitInitialDelayMilliseconds: 2,
  refreshWaitMaximumDelayMilliseconds: 10,
};

async function harness(options: WebBffTestHarnessOptions = {}) {
  const value = await makeWebBffTestHarness({ policy: FAST_WAIT, ...options });
  value.setFence(PRINCIPAL, { sessionEpoch: 1, version: 1 });
  return value;
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Holds token responses until released; `entered` resolves once a request reaches the issuer. */
function holdTokenResponses(value: WebBffTestHarness) {
  const entered = deferred();
  const gate = deferred();
  value.server.control.tokenGate = () => {
    entered.release();
    return gate.promise;
  };
  return { entered: entered.promise, release: gate.release };
}

function advance(clock: { now: Date }, seconds: number) {
  clock.now = new Date(clock.now.getTime() + seconds * 1_000);
}

async function sessionRecord(value: WebBffTestHarness, cookie: string) {
  return value.repository.bffSessionForHash(value.hash(cookie));
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to fail.");
}

describe("web BFF login", () => {
  test("creates an encrypted session bound to the fence and returns the validated path", async () => {
    const value = await harness();
    const login = await value.auth.beginLogin({ returnTo: "https://console.test/orgs?tab=1" });
    const authorizeUrl = new URL(login.authorizationUrl);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe("https://auth.test/oauth2/authorize");
    expect(authorizeUrl.searchParams.get("scope")).toBe("offline_access openid organizations:read");
    const callback = value.server.authorize(login.authorizationUrl, {
      principalId: PRINCIPAL,
      sessionEpoch: 1,
    });
    const result = await value.auth.completeCallback({
      code: callback.code,
      error: undefined,
      iss: callback.iss,
      state: callback.state,
      transactionCookie: login.transactionCookie,
    });
    expect(result.postLoginPath).toBe("/orgs?tab=1");
    const access = await value.auth.requireAccessToken(result.sessionCookie);
    expect(access.principalId).toBe(PRINCIPAL);

    const stored = JSON.stringify(value.dynamo.items("identity"));
    for (const secret of [
      access.accessToken,
      result.sessionCookie,
      login.transactionCookie,
      callback.state,
      callback.code,
    ]) {
      expect(stored).not.toContain(secret);
    }
    const session = await sessionRecord(value, result.sessionCookie);
    expect(session?.data).toMatchObject({
      refreshState: "idle",
      sessionEpoch: 1,
      status: "active",
    });
  });

  test("exactly one concurrent callback consumes the transaction and exchanges the code", async () => {
    const value = await harness();
    const login = await value.auth.beginLogin({ returnTo: "/" });
    const callback = value.server.authorize(login.authorizationUrl, {
      principalId: PRINCIPAL,
      sessionEpoch: 1,
    });
    const input = {
      code: callback.code,
      error: undefined,
      iss: callback.iss,
      state: callback.state,
      transactionCookie: login.transactionCookie,
    };
    const outcomes = await Promise.allSettled([
      value.auth.completeCallback(input),
      value.auth.completeCallback(input),
      value.auth.completeCallback(input),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect((outcome.reason as WebBffCallbackError).reason).toBe("duplicate-callback");
      }
    }
    expect(value.server.stats.tokenRequests.authorization_code).toBe(1);
    expect(
      ((await rejection(value.auth.completeCallback(input))) as WebBffCallbackError).reason,
    ).toBe("duplicate-callback");
  });

  test("rejects missing or mismatched bindings before any token request", async () => {
    const value = await harness();
    const login = await value.auth.beginLogin({ returnTo: "/" });
    const callback = value.server.authorize(login.authorizationUrl, {
      principalId: PRINCIPAL,
      sessionEpoch: 1,
    });
    const base: CallbackInput = {
      code: callback.code,
      error: undefined,
      iss: callback.iss,
      state: callback.state,
      transactionCookie: login.transactionCookie,
    };
    const cases: [Partial<CallbackInput>, CallbackFailureReason][] = [
      [{ iss: undefined }, "binding-mismatch"],
      [{ iss: "https://evil.test" }, "binding-mismatch"],
      [{ state: "forged" }, "binding-mismatch"],
      [{ transactionCookie: undefined }, "missing-transaction-cookie"],
      [{ transactionCookie: "other-browser" }, "unknown-transaction"],
    ];
    for (const [override, reason] of cases) {
      const error = await rejection(value.auth.completeCallback({ ...base, ...override }));
      expect((error as WebBffCallbackError).reason).toBe(reason);
    }
    advance(value.clock, 11 * 60);
    expect(
      ((await rejection(value.auth.completeCallback(base))) as WebBffCallbackError).reason,
    ).toBe("binding-mismatch");
    expect(value.server.stats.tokenRequests.authorization_code).toBe(0);
  });

  test.each([
    ["nonce", { nonce: "attacker-nonce" }],
    ["issuer", { iss: "https://evil.test" }],
    ["audience", { aud: "deployments-cli" }],
    ["session epoch", { "https://deployments.ai/session_epoch": "1" }],
    ["signature", undefined],
  ] as const)("rejects an ID token with a bad %s and revokes the grant", async (_name, claims) => {
    const value = await harness();
    if (claims) value.server.control.idTokenOverrides = claims;
    else value.server.control.signNextIdTokenWithRogueKey = true;
    const error = await rejection(value.signIn({ principalId: PRINCIPAL, sessionEpoch: 1 }));
    expect((error as WebBffCallbackError).reason).toBe("id-token-invalid");
    expect(value.server.stats.revoked).toHaveLength(1);
    expect(value.dynamo.items("identity").some((item) => item.itemType === "web-bff-session")).toBe(
      false,
    );
  });

  test("rejects a login whose epoch the fence no longer admits and revokes the grant", async () => {
    const value = await harness();
    value.setFence(PRINCIPAL, { sessionEpoch: 2, version: 2 });
    const error = await rejection(value.signIn({ principalId: PRINCIPAL, sessionEpoch: 1 }));
    expect((error as WebBffCallbackError).reason).toBe("fence-rejected");
    expect(value.server.stats.revoked).toHaveLength(1);
  });
});

describe("web BFF session", () => {
  test("a fence epoch change forces reauthentication and clears the credentials", async () => {
    const value = await harness();
    const { sessionCookie } = await value.signIn({ principalId: PRINCIPAL, sessionEpoch: 1 });
    value.setFence(PRINCIPAL, { sessionEpoch: 2, version: 2 });
    const error = await rejection(value.auth.requireAccessToken(sessionCookie));
    expect((error as WebBffReauthenticationRequiredError).reason).toBe("fence-rejected");
    const session = await sessionRecord(value, sessionCookie);
    expect(session?.data.status).toBe("reauthentication-required");
    expect(session?.data).not.toHaveProperty("protectedCredentials");
  });

  test("a disabled principal cannot use an existing session", async () => {
    const value = await harness();
    const { sessionCookie } = await value.signIn({ principalId: PRINCIPAL, sessionEpoch: 1 });
    value.setFence(PRINCIPAL, { principalStatus: "disabled", sessionEpoch: 1, version: 2 });
    const error = await rejection(value.auth.requireAccessToken(sessionCookie));
    expect((error as WebBffReauthenticationRequiredError).reason).toBe("fence-rejected");
  });

  test("refreshes a nearly expired access token and rotates the stored credential", async () => {
    const value = await harness();
    const { sessionCookie } = await value.signIn({ principalId: PRINCIPAL, sessionEpoch: 1 });
    const first = await value.auth.requireAccessToken(sessionCookie);
    advance(value.clock, 9 * 60 + 30);
    const second = await value.auth.requireAccessToken(sessionCookie);
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(value.server.stats.tokenRequests.refresh_token).toBe(1);
    const session = await sessionRecord(value, sessionCookie);
    expect(session?.data).toMatchObject({
      refreshCredentialVersion: 2,
      refreshState: "idle",
      status: "active",
    });
  });

  test("exactly one concurrent caller holds the lease and calls the token endpoint", async () => {
    const value = await harness();
    const { sessionCookie } = await value.signIn({ principalId: PRINCIPAL, sessionEpoch: 1 });
    advance(value.clock, 10 * 60);
    const held = holdTokenResponses(value);
    const callers = Array.from({ length: 6 }, () => value.auth.requireAccessToken(sessionCookie));
    await held.entered;
    held.release();
    const results = await Promise.all(callers);
    expect(value.server.stats.tokenRequests.refresh_token).toBe(1);
    expect(new Set(results.map((result) => result.accessToken)).size).toBe(1);
  });

  test("a stale lease holder cannot overwrite a revoked session", async () => {
    const value = await harness();
    const { sessionCookie } = await value.signIn({ principalId: PRINCIPAL, sessionEpoch: 1 });
    advance(value.clock, 10 * 60);
    const held = holdTokenResponses(value);
    const holder = value.auth.requireAccessToken(sessionCookie);
    await held.entered;
    await value.auth.logout(sessionCookie);
    held.release();
    const error = await rejection(holder);
    expect((error as WebBffReauthenticationRequiredError).reason).toBe("refresh-commit-failed");
    const session = await sessionRecord(value, sessionCookie);
    expect(session?.data.status).toBe("revoked");
    // Both the logout's credential and the holder's replacement were revoked at the issuer.
    expect(value.server.stats.revoked).toHaveLength(2);
  });

  test("an expired lease forces reauthentication and the late holder cannot resurrect it", async () => {
    const value = await harness();
    const { sessionCookie } = await value.signIn({ principalId: PRINCIPAL, sessionEpoch: 1 });
    advance(value.clock, 10 * 60);
    const held = holdTokenResponses(value);
    const holder = value.auth.requireAccessToken(sessionCookie);
    await held.entered;
    advance(value.clock, 31);
    const error = await rejection(value.auth.requireAccessToken(sessionCookie));
    expect((error as WebBffReauthenticationRequiredError).reason).toBe("refresh-lease-expired");
    held.release();
    expect(((await rejection(holder)) as WebBffReauthenticationRequiredError).reason).toBe(
      "refresh-commit-failed",
    );
    const session = await sessionRecord(value, sessionCookie);
    expect(session?.data.status).toBe("reauthentication-required");
    expect(value.server.stats.tokenRequests.refresh_token).toBe(1);
  });

  test.each(["invalid_grant", "ambiguous", "network"] as const)(
    "a %s refresh outcome requires reauthentication without retrying",
    async (failure) => {
      const value = await harness();
      const { sessionCookie } = await value.signIn({ principalId: PRINCIPAL, sessionEpoch: 1 });
      advance(value.clock, 10 * 60);
      value.server.control.failNext = { grant: "refresh_token", kind: failure };
      const error = await rejection(value.auth.requireAccessToken(sessionCookie));
      expect((error as WebBffReauthenticationRequiredError).reason).toBe("refresh-failed");
      expect(value.server.stats.tokenRequests.refresh_token).toBe(1);
      const session = await sessionRecord(value, sessionCookie);
      expect(session?.data.status).toBe("reauthentication-required");
      expect(session?.data).not.toHaveProperty("protectedCredentials");
      await rejection(value.auth.requireAccessToken(sessionCookie));
      expect(value.server.stats.tokenRequests.refresh_token).toBe(1);
    },
  );

  test("idle and absolute expiry are enforced logically", async () => {
    const value = await harness();
    const idle = await value.signIn({ principalId: PRINCIPAL, sessionEpoch: 1 });
    advance(value.clock, 7 * 24 * 60 * 60 + 1);
    expect(
      (
        (await rejection(
          value.auth.requireAccessToken(idle.sessionCookie),
        )) as WebBffReauthenticationRequiredError
      ).reason,
    ).toBe("session-expired");
  });
});

describe("web BFF logout", () => {
  test("revokes locally first, revokes the refresh family, and cannot be resurrected", async () => {
    const value = await harness();
    const { sessionCookie } = await value.signIn({ principalId: PRINCIPAL, sessionEpoch: 1 });
    await value.auth.logout(sessionCookie);
    const session = await sessionRecord(value, sessionCookie);
    expect(session?.data.status).toBe("revoked");
    expect(session?.data).not.toHaveProperty("protectedCredentials");
    expect(value.server.stats.revoked).toHaveLength(1);
    expect(value.server.familyActiveForToken(value.server.stats.revoked[0]!)).toBe(false);
    expect(
      (
        (await rejection(
          value.auth.requireAccessToken(sessionCookie),
        )) as WebBffReauthenticationRequiredError
      ).reason,
    ).toBe("revoked");
    await value.auth.logout(sessionCookie);
    expect((await sessionRecord(value, sessionCookie))?.data.version).toBe(session?.data.version);
  });

  test("logout still commits when the issuer revocation fails", async () => {
    const value = await harness();
    const { sessionCookie } = await value.signIn({ principalId: PRINCIPAL, sessionEpoch: 1 });
    value.server.control.failRevocations = true;
    await value.auth.logout(sessionCookie);
    expect((await sessionRecord(value, sessionCookie))?.data.status).toBe("revoked");
    expect(value.server.stats.revoked).toHaveLength(0);
  });
});
