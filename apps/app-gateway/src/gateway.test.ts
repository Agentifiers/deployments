import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AppRecord, Ulid } from "@deployments-ai/db";
import { SESSION_COOKIE, sessionIdOf } from "./admission.ts";
import { LOGIN_BINDING_COOKIE } from "./sign-in.ts";
import {
  ADMINISTRATOR,
  DISABLED_MEMBER,
  gatewayHarness,
  INDEX_HTML,
  MEMBER,
  ORGANIZATION,
  OWNER,
  SERVICE_MEMBER,
  SSO_ORGANIZATION,
  UNIQUE_VIOLATION,
  type Browser,
  type GatewayHarness,
} from "./test-support.ts";

let h: GatewayHarness;
let payroll: AppRecord;
let liveRelease: Ulid;
let draftRelease: Ulid;
let roster: AppRecord;
let ledger: AppRecord;
let badges: AppRecord;

const SAME_ORIGIN_JSON = {
  "content-type": "application/json",
  "sec-fetch-site": "same-origin",
};

function callApi(
  browser: Browser,
  app: AppRecord,
  functionName: string,
  headers: Record<string, string> = SAME_ORIGIN_JSON,
) {
  return browser.request(app, `/_platform/api/${functionName}`, {
    body: '{"p_status":"open"}',
    headers,
    method: "POST",
  });
}

async function signedIn(app: AppRecord, principalId: Ulid) {
  const browser = h.browser();
  await h.signIn(browser, app, principalId);
  return browser;
}

beforeAll(async () => {
  h = await gatewayHarness();
  const created = await h.activeApp({ access: "editor", name: "Payroll" });
  const live = await h.release(created, INDEX_HTML, true);
  const draft = await h.release(live.app, "<html><head></head><body>next</body></html>", false);
  payroll = draft.app;
  liveRelease = live.releaseId;
  draftRelease = draft.releaseId;
  roster = await h.activeApp({ access: "viewer", name: "Roster" });
  const ledgerActive = await h.activeApp({ access: "editor", name: "Ledger" });
  ledger = await h.apps.transitionApp({
    actor: { id: OWNER, type: "principal" },
    app: ledgerActive,
    transition: { to: "archived" },
  });
  badges = await h.activeApp({
    access: "viewer",
    name: "Badges",
    organizationId: SSO_ORGANIZATION,
  });
});

afterAll(async () => {
  await h.stop();
});

describe("sign-in", () => {
  test("a member signs in through the apex and gets the live index with a base href", async () => {
    const browser = h.browser();
    const step = await h.startSignIn(browser, payroll, MEMBER);
    const authorize = new URL(step.authorize.headers.get("location") ?? "");
    const complete = await browser.request(payroll, step.completePath);
    const page = await browser.request(payroll, "/orders?status=open");
    const me = await browser.request(payroll, "/_platform/me");

    expect({
      authorize: {
        clientId: authorize.searchParams.get("client_id"),
        codeChallengeMethod: authorize.searchParams.get("code_challenge_method"),
        endpoint: `${authorize.origin}${authorize.pathname}`,
        organizationHint: authorize.searchParams.get("organization_hint"),
        redirectUri: authorize.searchParams.get("redirect_uri"),
        scope: authorize.searchParams.get("scope"),
        status: step.authorize.status,
      },
      callback: step.callback.status,
      complete: { location: complete.headers.get("location"), status: complete.status },
      completeHost: new URL(step.callback.headers.get("location") ?? "").host,
      me: await me.json(),
      page: {
        body: await page.text(),
        cacheControl: page.headers.get("cache-control"),
        contentType: page.headers.get("content-type"),
        status: page.status,
      },
    }).toEqual({
      authorize: {
        clientId: "deployments-apps",
        codeChallengeMethod: "S256",
        endpoint: "https://auth.test/oauth2/authorize",
        organizationHint: ORGANIZATION,
        redirectUri: "https://apps.test/_platform/auth/callback",
        scope: "email openid profile",
        status: 302,
      },
      callback: 303,
      complete: { location: "/orders?status=open", status: 303 },
      completeHost: "payroll.apps.test",
      me: {
        app: { id: payroll.data.id, name: "Payroll", slug: "payroll" },
        caller: { email: "member@example.com", kind: "member", principalId: MEMBER },
        role: "editor",
      },
      page: {
        body: `<!doctype html><html><head><base href="/_r/${liveRelease}/"><title>Payroll</title></head><body><script type="module" src="./assets/app.js"></script></body></html>`,
        cacheControl: "no-store",
        contentType: "text/html; charset=utf-8",
        status: 200,
      },
    });
  });

  test("the binding and session cookies are host-only, HttpOnly, Secure, and Lax", async () => {
    const browser = h.browser();
    const step = await h.startSignIn(browser, payroll, MEMBER);
    const complete = await browser.request(payroll, step.completePath);

    expect(
      [...step.authorize.headers.getSetCookie(), ...complete.headers.getSetCookie()].map((cookie) =>
        cookie.replace(/=[A-Za-z0-9_-]{43};/u, "=<token>;"),
      ),
    ).toEqual([
      "__Host-deployments-app-login=<token>; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax",
      "__Host-deployments-app=<token>; Max-Age=28800; Path=/; HttpOnly; Secure; SameSite=Lax",
      "__Host-deployments-app-login=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
    ]);
  });

  test("a handoff opened without the matching binding cookie fails and stays redeemable", async () => {
    const member = h.browser();
    const step = await h.startSignIn(member, payroll, MEMBER);
    const stranger = h.browser();
    const otherLogin = h.browser();
    await otherLogin.request(payroll, "/_platform/auth/login?return_to=%2F");

    const withoutCookie = await stranger.request(payroll, step.completePath);
    const withOtherBinding = await otherLogin.request(payroll, step.completePath);
    const rightBrowser = await member.request(payroll, step.completePath);

    expect({
      rightBrowser: rightBrowser.status,
      sessions: [stranger, otherLogin, member].map((browser) =>
        browser.cookie(payroll, SESSION_COOKIE) === undefined ? "none" : "session",
      ),
      withOtherBinding: withOtherBinding.status,
      withoutCookie: withoutCookie.status,
    }).toEqual({
      rightBrowser: 303,
      sessions: ["none", "none", "session"],
      withOtherBinding: 403,
      withoutCookie: 403,
    });
  });

  test("a handoff redeemed twice fails the second time", async () => {
    const browser = h.browser();
    const step = await h.startSignIn(browser, payroll, MEMBER);
    const binding = browser.cookie(payroll, LOGIN_BINDING_COOKIE) ?? "";
    const first = await browser.request(payroll, step.completePath);
    browser.setCookie(payroll, LOGIN_BINDING_COOKIE, binding);
    const second = await browser.request(payroll, step.completePath);

    expect({
      first: first.status,
      second: second.status,
      secondCookies: second.headers.getSetCookie(),
      secondReason: h.logs.at(-1)?.reason,
    }).toEqual({ first: 303, second: 403, secondCookies: [], secondReason: "missing" });
  });

  test("a callback that names another issuer or carries an unknown code fails with its status", async () => {
    async function callback(iss: string) {
      const browser = h.browser();
      const login = await browser.request(payroll, "/_platform/auth/login?return_to=%2F");
      const state = new URL(login.headers.get("location") ?? "").searchParams.get("state") ?? "";
      const query = new URLSearchParams({ code: "unknown-code", iss, state }).toString();
      const response = await browser.request("apex", `/_platform/auth/callback?${query}`);
      return { reason: h.logs.at(-1)?.reason, status: response.status };
    }

    expect({
      otherIssuer: await callback("https://evil.test"),
      unknownCode: await callback("https://auth.test"),
    }).toEqual({
      otherIssuer: { reason: "issuer-mismatch", status: 400 },
      unknownCode: { reason: "token-exchange-failed", status: 502 },
    });
  });
});

describe("authenticated requests", () => {
  test("a session cookie replayed on another app's host gets 403", async () => {
    const browser = await signedIn(payroll, MEMBER);
    browser.setCookie(roster, SESSION_COOKIE, browser.cookie(payroll, SESSION_COOKIE) ?? "");

    const api = await callApi(browser, roster, "list_orders");
    const page = await browser.request(roster, "/");

    expect({ api: { body: await api.json(), status: api.status }, page: page.status }).toEqual({
      api: {
        body: { error: { code: "other_app", message: "This session belongs to another app." } },
        status: 403,
      },
      page: 403,
    });
  });

  test("cookie writes need same-origin fetch metadata and a JSON content type", async () => {
    const browser = await signedIn(payroll, MEMBER);
    const sameSite = await callApi(browser, payroll, "create_order", {
      "content-type": "application/json",
      "sec-fetch-site": "same-site",
    });
    const plainText = await callApi(browser, payroll, "create_order", {
      "content-type": "text/plain",
      "sec-fetch-site": "same-origin",
    });
    const allowed = await callApi(browser, payroll, "create_order");

    expect({
      allowed: { body: await allowed.json(), status: allowed.status },
      call: { ...h.database.calls.at(-1), appId: String(h.database.calls.at(-1)?.appId) },
      plainText: { body: await plainText.json(), status: plainText.status },
      sameSite: { body: await sameSite.json(), status: sameSite.status },
    }).toEqual({
      allowed: { body: { rows: [{ id: 7, status: "open" }] }, status: 200 },
      call: {
        appId: payroll.data.id,
        appIsPublic: false,
        args: { p_status: "open" },
        functionName: "create_order",
        principal: { email: "member@example.com", id: MEMBER },
        role: "editor",
      },
      plainText: {
        body: {
          error: {
            code: "json_required",
            message: "API calls must send Content-Type: application/json.",
          },
        },
        status: 403,
      },
      sameSite: {
        body: {
          error: {
            code: "cross_site_request",
            message: "API calls with a session cookie must come from the app's own pages.",
          },
        },
        status: 403,
      },
    });
  });

  test("after logout the old cookie gets 401 from the API and a login redirect for pages", async () => {
    const browser = await signedIn(payroll, MEMBER);
    const cookie = browser.cookie(payroll, SESSION_COOKIE) ?? "";
    const logout = await browser.request(payroll, "/_platform/auth/logout", {
      headers: { "sec-fetch-site": "same-origin" },
      method: "POST",
    });
    const cleared = browser.cookie(payroll, SESSION_COOKIE);
    browser.setCookie(payroll, SESSION_COOKIE, cookie);
    const api = await callApi(browser, payroll, "list_orders");
    const page = await browser.request(payroll, "/orders");

    expect({
      api: { body: await api.json(), status: api.status },
      cleared,
      logout: logout.status,
      page: { location: page.headers.get("location"), status: page.status },
    }).toEqual({
      api: {
        body: { error: { code: "unauthenticated", message: "Sign in to use this app." } },
        status: 401,
      },
      cleared: undefined,
      logout: 204,
      page: { location: "/_platform/auth/login?return_to=%2Forders", status: 302 },
    });
  });

  test("a viewer calling a volatile function gets 403 and a draft app is not published", async () => {
    const browser = await signedIn(roster, MEMBER);
    const write = await callApi(browser, roster, "create_order");
    const page = await browser.request(roster, "/");

    expect({
      page: {
        includesNotice: (await page.text()).includes("Roster has not been published yet."),
        status: page.status,
      },
      role: h.database.calls.at(-1)?.role,
      write: { body: await write.json(), status: write.status },
    }).toEqual({
      page: { includesNotice: true, status: 200 },
      role: "viewer",
      write: {
        body: {
          error: {
            code: "function_not_allowed",
            message: "Your role cannot call this function.",
          },
        },
        status: 403,
      },
    });
  });

  test("an organization that requires SSO refuses a password sign-in with 403", async () => {
    const browser = await signedIn(badges, MEMBER);
    const api = await callApi(browser, badges, "list_orders");
    const page = await browser.request(badges, "/");

    expect({ api: { body: await api.json(), status: api.status }, page: page.status }).toEqual({
      api: {
        body: {
          error: {
            code: "sso_required",
            message: "Your organization requires single sign-on. Sign in again through it.",
          },
        },
        status: 403,
      },
      page: 403,
    });
  });

  test("an archived app answers 410", async () => {
    const browser = h.browser();
    const page = await browser.request(ledger, "/");
    const login = await browser.request(ledger, "/_platform/auth/login");
    const api = await callApi(browser, ledger, "list_orders");

    expect({
      api: { body: await api.json(), status: api.status },
      login: login.status,
      page: page.status,
    }).toEqual({
      api: {
        body: { error: { code: "app_gone", message: "This app was archived." } },
        status: 410,
      },
      login: 410,
      page: 410,
    });
  });

  test("a dev bearer token works without fetch metadata and is refused on another app", async () => {
    const token = await h.devToken(roster, "editor");
    const anonymous = h.browser();
    const headers = { authorization: `Bearer ${token}` };
    const own = await callApi(anonymous, roster, "list_orders", headers);
    const ownLog = h.logs.at(-1);
    const other = await callApi(anonymous, payroll, "list_orders", headers);

    expect({
      call: h.database.calls.at(-1)?.principal,
      log: { ...ownLog, durationMs: 0 },
      logsMentionToken: JSON.stringify(h.logs).includes(token),
      other: { body: await other.json(), status: other.status },
      own: { body: await own.json(), status: own.status },
    }).toEqual({
      call: { email: null, id: "01ARZ3NDEKTSV4RRFFQ69G5FA6" },
      log: {
        app: roster.data.id,
        databaseError: null,
        durationMs: 0,
        function: "list_orders",
        reason: null,
        role: "editor",
        route: "api",
        rows: 1,
        status: 200,
      },
      logsMentionToken: false,
      other: {
        body: { error: { code: "other_app", message: "This session belongs to another app." } },
        status: 403,
      },
      own: { body: { rows: [{ id: 7, status: "open" }] }, status: 200 },
    });
  });

  test("a database that is resuming or unreachable answers 503 with Retry-After", async () => {
    const browser = await signedIn(payroll, MEMBER);
    h.database.unavailable = true;
    const response = await callApi(browser, payroll, "list_orders");
    h.database.unavailable = false;

    expect({
      body: await response.json(),
      retryAfter: response.headers.get("retry-after"),
      status: response.status,
    }).toEqual({
      body: {
        error: {
          code: "database_unavailable",
          message: "The app's database is starting; retry in a few seconds.",
        },
      },
      retryAfter: "5",
      status: 503,
    });
  });

  test("signing out everywhere ends app sessions once the cached epoch expires", async () => {
    const stale = await signedIn(roster, OWNER);
    const before = await stale.request(roster, "/orders");
    await h.signOutEverywhere(OWNER);
    const cached = await stale.request(roster, "/orders");
    const fresh = await signedIn(roster, OWNER);
    const freshAtOnce = await fresh.request(roster, "/orders");
    h.advance(5_000);
    const page = await stale.request(roster, "/orders");
    const api = await callApi(stale, roster, "list_orders");
    const freshLater = await fresh.request(roster, "/orders");

    expect({
      api: { body: await api.json(), status: api.status },
      before: before.status,
      cached: cached.status,
      fresh: [freshAtOnce.status, freshLater.status],
      page: { location: page.headers.get("location"), status: page.status },
    }).toEqual({
      api: {
        body: { error: { code: "unauthenticated", message: "Sign in to use this app." } },
        status: 401,
      },
      before: 200,
      cached: 200,
      fresh: [200, 200],
      page: { location: "/_platform/auth/login?return_to=%2Forders", status: 302 },
    });
  });

  test("one app holding its whole share leaves other apps served and turns its next call away", async () => {
    const member = await signedIn(payroll, MEMBER);
    const other = await signedIn(roster, MEMBER);
    const holding = Array.from({ length: 4 }, () => callApi(member, payroll, "hold"));
    await h.database.whenHeld(4);
    const otherApp = await callApi(other, roster, "list_orders");
    const turnedAway = await callApi(member, payroll, "list_orders");
    h.database.releaseHeld();
    const released = await Promise.all(holding);
    const after = await callApi(member, payroll, "list_orders");

    expect({
      after: after.status,
      otherApp: otherApp.status,
      released: released.map((response) => response.status),
      turnedAway: {
        body: await turnedAway.json(),
        retryAfter: turnedAway.headers.get("retry-after"),
        status: turnedAway.status,
      },
    }).toEqual({
      after: 200,
      otherApp: 200,
      released: [200, 200, 200, 200],
      turnedAway: {
        body: { error: { code: "gateway_busy", message: "The app is busy; retry shortly." } },
        retryAfter: "5",
        status: 503,
      },
    });
  });

  test("a member sees only a failure's code and generic message; the log and the agent see the detail", async () => {
    const member = await signedIn(payroll, MEMBER);
    const agent = { authorization: `Bearer ${await h.devToken(roster, "editor")}` };
    const memberCall = await callApi(member, payroll, "add_member");
    const memberLog = h.logs.at(-1);
    const agentCall = await callApi(h.browser(), roster, "add_member", agent);
    const tooLarge = await callApi(member, payroll, "export_everything");

    expect({
      agent: { body: await agentCall.json(), status: agentCall.status },
      member: { body: await memberCall.json(), status: memberCall.status },
      memberLog: { databaseError: memberLog?.databaseError, reason: memberLog?.reason },
      tooLarge: { body: await tooLarge.json(), status: tooLarge.status },
    }).toEqual({
      agent: {
        body: { error: { code: "postgres_error", message: UNIQUE_VIOLATION } },
        status: 422,
      },
      member: {
        body: {
          error: { code: "postgres_error", message: "The app's database refused the request." },
        },
        status: 422,
      },
      memberLog: { databaseError: UNIQUE_VIOLATION, reason: "postgres_error" },
      tooLarge: {
        body: {
          error: {
            code: "result_too_large",
            message: "The function's result is too large to return.",
          },
        },
        status: 413,
      },
    });
  });

  test("an editor dev token reaches a live app's database only as a viewer", async () => {
    const bearer = async (app: AppRecord) => ({
      authorization: `Bearer ${await h.devToken(app, "editor")}`,
    });
    const live = await callApi(h.browser(), payroll, "list_orders", await bearer(payroll));
    const liveRole = h.database.calls.at(-1)?.role;
    const draft = await callApi(h.browser(), roster, "list_orders", await bearer(roster));
    const draftRole = h.database.calls.at(-1)?.role;

    expect({
      draft: { role: draftRole, status: draft.status },
      live: { role: liveRole, status: live.status },
    }).toEqual({
      draft: { role: "editor", status: 200 },
      live: { role: "viewer", status: 200 },
    });
  });

  test("the gateway serves no release but the live one, not even to an organization owner", async () => {
    const owner = await signedIn(payroll, OWNER);
    const preview = await owner.request(payroll, `/_platform/preview/${draftRelease}/`);
    const live = await owner.request(payroll, "/");

    expect({
      live: (await live.text()).includes(`<base href="/_r/${liveRelease}/">`),
      preview: preview.status,
    }).toEqual({ live: true, preview: 404 });
  });

  test("a member can still sign out of an app archived after sign-in", async () => {
    const timesheets = await h.activeApp({ access: "editor", name: "Timesheets" });
    const browser = await signedIn(timesheets, MEMBER);
    const sessionId = sessionIdOf(browser.cookie(timesheets, SESSION_COOKIE) ?? "");
    await h.apps.transitionApp({
      actor: { id: OWNER, type: "principal" },
      app: timesheets,
      transition: { to: "archived" },
    });
    h.advance(5_000);
    const page = await browser.request(timesheets, "/");
    const before = await h.apps.getSession({ sessionId });
    const logout = await browser.request(timesheets, "/_platform/auth/logout", {
      headers: { "sec-fetch-site": "same-origin" },
      method: "POST",
    });

    expect({
      cleared: browser.cookie(timesheets, SESSION_COOKIE),
      logout: logout.status,
      page: page.status,
      sessions: [before?.data.appId, (await h.apps.getSession({ sessionId }))?.data.appId],
    }).toEqual({
      cleared: undefined,
      logout: 204,
      page: 410,
      sessions: [timesheets.data.id, undefined],
    });
  });

  test("the request log keeps no cookie, token, body, or query string", async () => {
    const start = h.logs.length;
    const browser = h.browser();
    const step = await h.startSignIn(browser, roster, MEMBER);
    await browser.request(roster, step.completePath);
    await browser.request(roster, "/orders?status=open");
    await callApi(browser, roster, "list_orders");
    const token = await h.devToken(roster, "editor");
    await callApi(h.browser(), roster, "list_orders", { authorization: `Bearer ${token}` });
    const logged = h.logs.slice(start);
    const text = JSON.stringify(logged);
    const secrets = {
      body: "p_status",
      cookie: browser.cookie(roster, SESSION_COOKIE) ?? "",
      handoff: new URL(step.completePath, "https://x.test").searchParams.get("handoff") ?? "",
      query: "status=open",
      state: new URL(step.authorize.headers.get("location") ?? "").searchParams.get("state") ?? "",
      token,
    };
    const leaked = Object.entries(secrets)
      .filter(([, secret]) => text.includes(secret))
      .map(([name]) => name);

    expect({ leaked, routes: logged.map((entry) => entry.route) }).toEqual({
      leaked: [],
      routes: ["login", "callback", "complete", "page", "api", "api"],
    });
  });

  test("an administrator outside the organization and disabled or service members are refused", async () => {
    const refused: unknown[] = [];
    for (const principalId of [ADMINISTRATOR, DISABLED_MEMBER, SERVICE_MEMBER]) {
      const response = await callApi(await signedIn(payroll, principalId), payroll, "list_orders");
      refused.push({ body: await response.json(), status: response.status });
    }
    const notAMember = {
      body: {
        error: {
          code: "not_a_member",
          message: "You are not an active member of this app's organization.",
        },
      },
      status: 403,
    };

    expect(refused).toEqual([notAMember, notAMember, notAMember]);
  });
});
