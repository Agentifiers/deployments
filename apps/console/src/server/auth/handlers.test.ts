import { describe, expect, test } from "bun:test";
import {
  makeWebBffTestHarness,
  type WebBffTestHarness,
} from "@deployments-ai/web-bff-auth/testing";
import {
  type AuthRouteContext,
  handleCallback,
  handleLogin,
  handleLogout,
  loginPrompt,
  postLogoutLocation,
} from "./handlers.ts";
import { CONSOLE_OAUTH_SCOPES } from "./scopes.ts";

const ORIGIN = "https://console.test";
const PRINCIPAL = "01JZ8Y7Q3M2K4N6P8R0T2V4X6Z";

async function setup() {
  const harness = await makeWebBffTestHarness();
  harness.setFence(PRINCIPAL, { sessionEpoch: 1, version: 1 });
  const issuerSignOuts: string[] = [];
  const context: AuthRouteContext = {
    auth: harness.auth,
    endIssuerSession: async (accessToken) => {
      issuerSignOuts.push(accessToken);
    },
    publicOrigin: ORIGIN,
  };
  return { context, harness, issuerSignOuts };
}

function cookieValue(setCookie: string) {
  return setCookie.slice(setCookie.indexOf("=") + 1, setCookie.indexOf(";"));
}

async function signIn(harness: WebBffTestHarness, context: AuthRouteContext, returnTo: string) {
  const login = await handleLogin(
    new Request(`${ORIGIN}/auth/login?returnTo=${encodeURIComponent(returnTo)}`),
    context,
  );
  const transactionCookie = login.headers.getSetCookie()[0]!;
  const callback = harness.server.authorize(login.headers.get("location")!, {
    principalId: PRINCIPAL,
    sessionEpoch: 1,
  });
  const query = new URLSearchParams(callback);
  return {
    callbackRequest: (overrides: Readonly<Record<string, string>> = {}) =>
      new Request(`${ORIGIN}/auth/callback?${new URLSearchParams({ ...callback, ...overrides })}`, {
        headers: { cookie: `__Host-deployments-authorization=${cookieValue(transactionCookie)}` },
      }),
    login,
    query,
    transactionCookie,
  };
}

async function sessionStatus(harness: WebBffTestHarness, cookie: string) {
  const record = await harness.repository.bffSessionForHash(harness.hash(cookie));
  return record?.data.status;
}

describe("console auth routes", () => {
  test("requests openid, offline access, and the first-party API scopes only", () => {
    expect(CONSOLE_OAUTH_SCOPES).toContain("openid");
    expect(CONSOLE_OAUTH_SCOPES).toContain("offline_access");
    expect(CONSOLE_OAUTH_SCOPES).toContain("organizations:read");
    expect(CONSOLE_OAUTH_SCOPES).toContain("channels:read");
    expect(CONSOLE_OAUTH_SCOPES).not.toContain("channels:write");
    expect(CONSOLE_OAUTH_SCOPES).not.toContain("managed-skills:admin");
    expect(CONSOLE_OAUTH_SCOPES).not.toContain("memory:execute");
  });

  test("login sets a host-only transaction cookie and redirects to the issuer", async () => {
    const { context, harness } = await setup();
    const { login, transactionCookie } = await signIn(harness, context, "/o/1");
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toStartWith("https://auth.test/oauth2/authorize?");
    expect(transactionCookie).toMatch(
      /^__Host-deployments-authorization=[\w-]{43}; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/u,
    );
  });

  test("a login that cannot persist its transaction renders the failure page without a cookie", async () => {
    const { context } = await setup();
    const failing: AuthRouteContext = {
      ...context,
      auth: { ...context.auth, beginLogin: () => Promise.reject(new Error("kms unavailable")) },
    };
    const response = await handleLogin(new Request(`${ORIGIN}/auth/login?returnTo=/o/1`), failing);
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toStartWith("text/html");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await response.text()).toContain("Sign-in could not be completed.");
  });

  test("callback sets the session cookie only after success and clears the transaction", async () => {
    const { context, harness } = await setup();
    const flow = await signIn(harness, context, `${ORIGIN}/o/1?tab=members`);
    const response = await handleCallback(flow.callbackRequest(), context);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/o/1?tab=members`);
    const [clearTransaction, session] = response.headers.getSetCookie();
    expect(clearTransaction).toStartWith("__Host-deployments-authorization=; Max-Age=0;");
    expect(session).toMatch(
      /^__Host-deployments-session=[\w-]{43}; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/u,
    );
    expect(await sessionStatus(harness, cookieValue(session!))).toBe("active");

    const replay = await handleCallback(flow.callbackRequest(), context);
    expect(replay.status).toBe(400);
    expect(replay.headers.getSetCookie()).toHaveLength(1);
  });

  test("a callback with a mismatched issuer fails closed before the token endpoint", async () => {
    const { context, harness } = await setup();
    const flow = await signIn(harness, context, "/");
    const response = await handleCallback(
      flow.callbackRequest({ iss: "https://evil.test" }),
      context,
    );
    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie()).toEqual([
      "__Host-deployments-authorization=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
    ]);
    expect(harness.server.stats.tokenRequests.authorization_code).toBe(0);
  });

  test("logout requires the console origin, revokes the session, and clears the cookie", async () => {
    const { context, harness, issuerSignOuts } = await setup();
    const flow = await signIn(harness, context, "/");
    const callback = await handleCallback(flow.callbackRequest(), context);
    const session = cookieValue(callback.headers.getSetCookie()[1]!);
    const cookie = `__Host-deployments-session=${session}`;

    for (const headers of [
      { cookie, origin: "https://evil.test" },
      { cookie, origin: "null" },
      { cookie },
      { cookie, "sec-fetch-site": "cross-site" },
    ]) {
      const rejected = await handleLogout(
        new Request(`${ORIGIN}/auth/logout`, { headers, method: "POST" }),
        context,
      );
      expect(rejected.status).toBe(403);
    }
    expect(await sessionStatus(harness, session)).toBe("active");

    const response = await handleLogout(
      new Request(`${ORIGIN}/auth/logout`, {
        headers: { cookie, "sec-fetch-site": "same-origin" },
        method: "POST",
      }),
      context,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/`);
    expect(response.headers.getSetCookie()).toEqual([
      "__Host-deployments-session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
    ]);
    expect(await sessionStatus(harness, session)).toBe("revoked");
    expect(harness.server.stats.revoked).toHaveLength(1);
    // The issuer's browser session ends too, so `/` cannot silently sign the browser back in.
    expect(issuerSignOuts).toHaveLength(1);
  });

  test("logout still signs out of the console when the issuer cannot end its session", async () => {
    const { context, harness } = await setup();
    const flow = await signIn(harness, context, "/");
    const callback = await handleCallback(flow.callbackRequest(), context);
    const session = cookieValue(callback.headers.getSetCookie()[1]!);
    const failing: AuthRouteContext = {
      ...context,
      endIssuerSession: () => Promise.reject(new Error("identity unavailable")),
    };
    const response = await handleLogout(
      new Request(`${ORIGIN}/auth/logout`, {
        headers: {
          cookie: `__Host-deployments-session=${session}`,
          "sec-fetch-site": "same-origin",
        },
        method: "POST",
      }),
      failing,
    );
    expect(response.status).toBe(303);
    expect(await sessionStatus(harness, session)).toBe("revoked");
  });

  test("login forwards prompt=login to the issuer only when asked", async () => {
    const { context } = await setup();
    const authorizeUrl = async (query: string) => {
      const login = await handleLogin(new Request(`${ORIGIN}/auth/login?${query}`), context);
      return new URL(login.headers.get("location")!);
    };
    expect((await authorizeUrl("prompt=login&returnTo=/")).searchParams.get("prompt")).toBe(
      "login",
    );
    expect((await authorizeUrl("returnTo=/")).searchParams.has("prompt")).toBe(false);
  });

  test("switching accounts revokes the session, then forces sign-in back to returnTo", async () => {
    const { context, harness } = await setup();
    const flow = await signIn(harness, context, "/");
    const callback = await handleCallback(flow.callbackRequest(), context);
    const session = cookieValue(callback.headers.getSetCookie()[1]!);

    const response = await handleLogout(
      new Request(`${ORIGIN}/auth/logout`, {
        body: "prompt=login&returnTo=/x",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `__Host-deployments-session=${session}`,
          "sec-fetch-site": "same-origin",
        },
        method: "POST",
      }),
      context,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://console.test/auth/login?prompt=login&returnTo=%2Fx",
    );
    expect(await sessionStatus(harness, session)).toBe("revoked");
  });
});

describe("account switch locations", () => {
  test("only prompt=login forces the sign-in form", () => {
    expect(loginPrompt(new URLSearchParams("prompt=login"))).toBe("login");
    expect(loginPrompt(new URLSearchParams("prompt=none"))).toBeUndefined();
    expect(loginPrompt(new URLSearchParams(""))).toBeUndefined();
  });

  test("logout lands on the console root unless it switches accounts", () => {
    expect(postLogoutLocation("https://console.test", new URLSearchParams(""))).toBe(
      "https://console.test/",
    );
    expect(
      postLogoutLocation(
        "https://console.test",
        new URLSearchParams({
          prompt: "login",
          returnTo: "/invitations/accept?invitation=I&token=T",
        }),
      ),
    ).toBe(
      "https://console.test/auth/login?prompt=login&returnTo=%2Finvitations%2Faccept%3Finvitation%3DI%26token%3DT",
    );
    expect(postLogoutLocation("https://console.test", new URLSearchParams("prompt=login"))).toBe(
      "https://console.test/auth/login?prompt=login&returnTo=%2F",
    );
  });
});
