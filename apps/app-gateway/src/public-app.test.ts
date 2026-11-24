import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AppRecord, Ulid } from "@deployments-ai/db";
import { SESSION_COOKIE } from "./admission.ts";
import {
  DISABLED_MEMBER,
  gatewayHarness,
  INDEX_HTML,
  MEMBER,
  type Browser,
  type GatewayHarness,
  type Site,
} from "./test-support.ts";

const SAME_ORIGIN_JSON = { "content-type": "application/json", "sec-fetch-site": "same-origin" };

let h: GatewayHarness;

beforeAll(async () => {
  h = await gatewayHarness();
});

afterAll(async () => {
  await h.stop();
});

async function liveApp(
  name: string,
  audience: "members" | "public",
): Promise<{ readonly app: AppRecord; readonly releaseId: Ulid }> {
  const created = await h.activeApp({ access: "viewer", name });
  const { app, releaseId } = await h.release(created, INDEX_HTML, true);
  return { app: audience === "public" ? await h.publish(app, "public") : app, releaseId };
}

function signUp(browser: Browser, site: Site) {
  return browser.request(site, "/_platform/api/sign_up", {
    body: '{"p_email":"guest@example.com"}',
    headers: SAME_ORIGIN_JSON,
    method: "POST",
  });
}

function outcome(response: Response) {
  const entry = h.logs.at(-1);
  const location = response.headers.get("location");
  return `${response.status} ${location ?? `reason=${entry?.reason ?? null}`} role=${entry?.role ?? null}`;
}

describe("access policy", () => {
  test("pages and API calls follow the design's table on apps that are and are not public", async () => {
    const observed: Record<string, string> = {};
    for (const audience of ["members", "public"] as const) {
      const { app } = await liveApp(`Policy${audience}`, audience);
      const { app: other } = await liveApp(`Other${audience}`, "members");
      const admitted = h.browser();
      await h.signIn(admitted, app, MEMBER);
      const refused = h.browser();
      await h.signIn(refused, other, MEMBER);
      refused.setCookie(app, SESSION_COOKIE, refused.cookie(other, SESSION_COOKIE) ?? "");
      const browsers = { admitted, anonymous: h.browser(), refused };
      for (const [admission, browser] of Object.entries(browsers)) {
        const callsBefore = h.database.calls.length;
        observed[`${audience} page ${admission}`] = outcome(await browser.request(app, "/"));
        observed[`${audience} api ${admission}`] = outcome(await signUp(browser, app));
        const call = h.database.calls.slice(callsBefore).at(0);
        observed[`${audience} api ${admission} database`] =
          call === undefined ? "no call" : `${call.role} appIsPublic=${call.appIsPublic}`;
      }
    }

    expect(observed).toEqual({
      "members api admitted": "200 reason=null role=viewer",
      "members api admitted database": "viewer appIsPublic=false",
      "members api anonymous": "401 reason=anonymous role=null",
      "members api anonymous database": "no call",
      "members api refused": "403 reason=other-app role=null",
      "members api refused database": "no call",
      "members page admitted": "200 reason=null role=viewer",
      "members page anonymous": "302 /_platform/auth/login?return_to=%2F role=null",
      "members page refused": "403 reason=other-app role=null",
      "public api admitted": "200 reason=null role=viewer",
      "public api admitted database": "viewer appIsPublic=true",
      "public api anonymous": "200 reason=null role=visitor",
      "public api anonymous database": "visitor appIsPublic=true",
      "public api refused": "200 reason=null role=visitor",
      "public api refused database": "visitor appIsPublic=true",
      "public page admitted": "200 reason=null role=viewer",
      "public page anonymous": "200 reason=null role=visitor",
      "public page refused": "200 reason=null role=visitor",
    });
  });

  test("an app with a public audience but no live release is not public", async () => {
    const created = await h.activeApp({ access: "viewer", name: "Unreleased" });
    const draft = await h.publish(created, "public");
    const visitor = h.browser();

    expect({
      api: outcome(await signUp(visitor, draft)),
      page: outcome(await visitor.request(draft, "/")),
    }).toEqual({
      api: "401 reason=anonymous role=null",
      page: "302 /_platform/auth/login?return_to=%2F role=null",
    });
  });

  test("a visitor gets the live page with today's headers, and me still answers 401", async () => {
    const { app, releaseId } = await liveApp("Gala", "public");
    const visitor = h.browser();
    const page = await visitor.request(app, "/schedule");
    const pageLog = h.logs.at(-1);
    const body = await page.text();
    const me = await visitor.request(app, "/_platform/me");

    expect({
      body,
      headers: Object.fromEntries([...page.headers].filter(([name]) => name !== "date")),
      log: { ...pageLog, durationMs: 0 },
      me: { body: await me.json(), status: me.status },
      status: page.status,
    }).toEqual({
      body: INDEX_HTML.replace("<head>", `<head><base href="/_r/${releaseId}/">`),
      headers: {
        "cache-control": "no-store",
        "content-length": String(Buffer.byteLength(body)),
        "content-type": "text/html; charset=utf-8",
      },
      log: {
        app: app.data.id,
        databaseError: null,
        durationMs: 0,
        function: null,
        reason: null,
        role: "visitor",
        route: "page",
        rows: null,
        status: 200,
      },
      me: {
        body: { error: { code: "unauthenticated", message: "Sign in to use this app." } },
        status: 401,
      },
      status: 200,
    });
  });

  test("a refused session keeps its 403 for functions visitors cannot call and calls visitor functions as a visitor", async () => {
    const { app } = await liveApp("Refusals", "public");
    const refused = h.browser({ address: "198.51.100.60" });
    await h.signIn(refused, app, DISABLED_MEMBER);
    const apiCall = await refused.request(app, "/_platform/api/list_orders", {
      body: "{}",
      headers: SAME_ORIGIN_JSON,
      method: "POST",
    });
    const apiLog = outcome(apiCall);
    const visitorCall = await signUp(refused, app);

    expect({
      api: { body: await apiCall.json(), log: apiLog },
      visitor: outcome(visitorCall),
    }).toEqual({
      api: {
        body: {
          error: {
            code: "not_a_member",
            message: "You are not an active member of this app's organization.",
          },
        },
        log: "403 reason=not-a-member role=visitor",
      },
      visitor: "200 reason=null role=visitor",
    });
  });
});

describe("visitor page limit", () => {
  test("one address gets a burst of 60 visitor page documents across public apps, then one every 200 ms; redirects and members are not limited", async () => {
    const created = await h.activeApp({ access: "viewer", name: "Crowded" });
    const live = await h.release(
      created,
      { "about.html": INDEX_HTML, "index.html": INDEX_HTML, "site.css": "body { margin: 0 }" },
      true,
    );
    const app = await h.publish(await h.serve(live.app, "static-site"), "public");
    const { app: otherApp } = await liveApp("Nearby", "public");
    const { app: membersApp } = await liveApp("Private", "members");
    const address = "198.51.100.80";
    const visitor = h.browser({ address });
    const pages = new Set<string>();
    const assets = new Set<string>();
    for (let index = 0; index < 60; index += 1) {
      pages.add(outcome(await visitor.request(app, "/")));
      assets.add(outcome(await visitor.request(app, "/site.css")));
    }
    const limited = await visitor.request(app, "/about");
    const limitedLog = outcome(limited);
    const assetWhileLimited = outcome(await visitor.request(app, "/site.css"));
    const canonicalWhileLimited = outcome(await visitor.request(app, "/about/"));
    const otherAppPage = outcome(await visitor.request(otherApp, "/"));
    const member = h.browser({ address });
    await h.signIn(member, app, MEMBER);
    const memberPage = outcome(await member.request(app, "/"));
    const membersAppPage = outcome(await visitor.request(membersApp, "/"));
    const neighbour = outcome(await h.browser({ address: "198.51.100.81" }).request(app, "/"));
    const unstamped = outcome(await h.browser({ address: null }).request(app, "/"));
    h.advance(200);
    const refilled = outcome(await visitor.request(app, "/"));
    const asset = `307 /_r/${live.releaseId}/site.css role=visitor`;

    expect({
      assets: [...assets],
      assetWhileLimited,
      canonicalWhileLimited,
      limited: {
        log: limitedLog,
        retryAfter: limited.headers.get("retry-after"),
        type: limited.headers.get("content-type"),
      },
      memberPage,
      membersAppPage,
      neighbour,
      otherAppPage,
      pages: [...pages],
      refilled,
      unstamped,
    }).toEqual({
      assets: [asset],
      assetWhileLimited: asset,
      canonicalWhileLimited: "308 /about role=visitor",
      limited: {
        log: "429 reason=rate-limited-page role=visitor",
        retryAfter: "1",
        type: "text/html; charset=utf-8",
      },
      memberPage: "200 reason=null role=viewer",
      membersAppPage: "302 /_platform/auth/login?return_to=%2F role=null",
      neighbour: "200 reason=null role=visitor",
      otherAppPage: "429 reason=rate-limited-page role=visitor",
      pages: ["200 reason=null role=visitor"],
      refilled: "200 reason=null role=visitor",
      unstamped: "403 reason=viewer-address-missing role=visitor",
    });
  });
});

describe("session host binding", () => {
  async function onCustomHost(app: AppRecord, hostname: string) {
    const { site } = await h.domain({ app, attachedBy: "person", hostname, state: "active" });
    return site;
  }

  test("a cookie replayed on another host is refused on a members app and served as a visitor on a public one", async () => {
    const observed: Record<string, string> = {};
    for (const audience of ["members", "public"] as const) {
      const { app } = await liveApp(`Replay${audience}`, audience);
      const site = await onCustomHost(app, `rsvp-${audience}.example.com`);
      const member = h.browser();
      await h.signIn(member, app, MEMBER);
      member.setCookie(site, SESSION_COOKIE, member.cookie(app, SESSION_COOKIE) ?? "");
      observed[`${audience} page`] = outcome(await member.request(site, "/"));
      observed[`${audience} api`] = outcome(await signUp(member, site));
      observed[`${audience} own host`] = outcome(await member.request(app, "/"));
    }
    const { app } = await liveApp("ReplayBody", "members");
    const site = await onCustomHost(app, "rsvp-body.example.com");
    const member = h.browser();
    await h.signIn(member, app, MEMBER);
    member.setCookie(site, SESSION_COOKIE, member.cookie(app, SESSION_COOKIE) ?? "");
    const refusal = await member.request(site, "/_platform/me");

    expect({ observed, refusal: await refusal.json() }).toEqual({
      observed: {
        "members api": "403 reason=other-host role=null",
        "members own host": "200 reason=null role=viewer",
        "members page": "403 reason=other-host role=null",
        "public api": "200 reason=null role=visitor",
        "public own host": "200 reason=null role=viewer",
        "public page": "200 reason=null role=visitor",
      },
      refusal: {
        error: { code: "other_host", message: "This session belongs to another host." },
      },
    });
  });

  test("a session issued on one custom host is refused on another custom host of the same app", async () => {
    const { app } = await liveApp("TwoHosts", "members");
    const first = await onCustomHost(app, "rsvp-two.example.com");
    const second = await onCustomHost(app, "tickets-two.example.com");
    const browser = h.browser();
    await h.signIn(browser, first, MEMBER);
    browser.setCookie(second, SESSION_COOKIE, browser.cookie(first, SESSION_COOKIE) ?? "");

    expect(outcome(await browser.request(second, "/"))).toBe("403 reason=other-host role=null");
  });

  test("a session issued on a custom host works there and is refused on the slug host", async () => {
    const { app } = await liveApp("Bound", "members");
    const site = await onCustomHost(app, "rsvp-bound.example.com");
    const browser = h.browser();
    await h.signIn(browser, site, MEMBER);
    browser.setCookie(app, SESSION_COOKIE, browser.cookie(site, SESSION_COOKIE) ?? "");

    expect({
      customOnCustomHost: outcome(await browser.request(site, "/")),
      customOnSlugHost: outcome(await browser.request(app, "/_platform/me")),
    }).toEqual({
      customOnCustomHost: "200 reason=null role=viewer",
      customOnSlugHost: "403 reason=other-host role=null",
    });
  });
});
