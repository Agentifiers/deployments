import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AppRecord } from "@deployments-ai/db";
import { SESSION_COOKIE, sessionIdOf } from "./admission.ts";
import { LOGIN_BINDING_COOKIE } from "./sign-in.ts";
import {
  APPS_DOMAIN,
  gatewayHarness,
  INDEX_HTML,
  MEMBER,
  type Browser,
  type CustomSite,
  type GatewayHarness,
  type Site,
} from "./test-support.ts";

const SAME_ORIGIN_JSON = { "content-type": "application/json", "sec-fetch-site": "same-origin" };
const CACHE_TTL_MS = 5_000;

let h: GatewayHarness;

beforeAll(async () => {
  h = await gatewayHarness();
});

afterAll(async () => {
  await h.stop();
});

async function liveApp(name: string, audience: "members" | "public") {
  const created = await h.activeApp({ access: "viewer", name });
  const { app } = await h.release(created, INDEX_HTML, true);
  return audience === "public" ? h.publish(app, "public") : app;
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

async function databaseWork(work: () => Promise<string>) {
  const calls = h.database.calls.length;
  const reads = h.reads.length;
  const persistence = h.persistenceCalls.length;
  const result = await work();
  const records = h.persistenceCalls
    .slice(persistence)
    .filter((method) => method !== "domainForHostname");
  return `${result} records=${records.length > 0 ? "read" : "none"} calls=${h.database.calls.length - calls} reads=${h.reads.length - reads}`;
}

function slugLogin(app: AppRecord, returnTo: string) {
  return `https://${app.data.slug}.${APPS_DOMAIN}/_platform/auth/login?return_to=${encodeURIComponent(returnTo)}`;
}

describe("custom host serving", () => {
  test("a custom host serves only while it is an active domain of the stamped app", async () => {
    const observed: Record<string, string> = {};
    const other = await liveApp("Elsewhere", "public");
    const foreign = await h.domain({
      app: other,
      attachedBy: "person",
      hostname: "foreign.example.com",
      state: "active",
    });
    const owner = h.browser();
    observed["owner's own domain page"] = await databaseWork(async () =>
      outcome(await owner.request(foreign.site, "/orders")),
    );
    observed["owner's own domain api"] = await databaseWork(async () =>
      outcome(await signUp(owner, foreign.site)),
    );
    for (const audience of ["members", "public"] as const) {
      const app = await liveApp(`Served${audience}`, audience);
      const sites: Record<string, CustomSite> = {
        "another app's domain": { app, hostname: foreign.site.hostname },
        "unknown host": { app, hostname: `unknown-${audience}.example.com` },
      };
      for (const state of ["unverified", "verified", "active"] as const) {
        const { site } = await h.domain({
          app,
          attachedBy: "person",
          hostname: `${state}-${audience}.example.com`,
          state,
        });
        sites[state] = site;
      }
      const browser = h.browser();
      for (const [name, site] of Object.entries(sites)) {
        observed[`${audience} ${name} page`] = await databaseWork(async () =>
          outcome(await browser.request(site, "/orders")),
        );
        observed[`${audience} ${name} api`] = await databaseWork(async () =>
          outcome(await signUp(browser, site)),
        );
      }
    }

    expect(observed).toEqual({
      "members active api": "401 reason=anonymous role=null records=none calls=0 reads=0",
      "members active page":
        "302 /_platform/auth/login?return_to=%2Forders role=null records=read calls=0 reads=0",
      "members another app's domain api":
        "404 reason=host-not-served role=null records=none calls=0 reads=0",
      "members another app's domain page":
        "404 reason=host-not-served role=null records=none calls=0 reads=0",
      "members unknown host api":
        "404 reason=host-not-served role=null records=none calls=0 reads=0",
      "members unknown host page":
        "404 reason=host-not-served role=null records=none calls=0 reads=0",
      "members unverified api": "404 reason=host-not-served role=null records=none calls=0 reads=0",
      "members unverified page":
        "404 reason=host-not-served role=null records=none calls=0 reads=0",
      "members verified api": "404 reason=host-not-served role=null records=none calls=0 reads=0",
      "members verified page": "404 reason=host-not-served role=null records=none calls=0 reads=0",
      "owner's own domain api": "200 reason=null role=visitor records=none calls=1 reads=0",
      "owner's own domain page": "200 reason=null role=visitor records=read calls=0 reads=1",
      "public active api": "200 reason=null role=visitor records=none calls=1 reads=0",
      "public active page": "200 reason=null role=visitor records=read calls=0 reads=1",
      "public another app's domain api":
        "404 reason=host-not-served role=null records=none calls=0 reads=0",
      "public another app's domain page":
        "404 reason=host-not-served role=null records=none calls=0 reads=0",
      "public unknown host api":
        "404 reason=host-not-served role=null records=none calls=0 reads=0",
      "public unknown host page":
        "404 reason=host-not-served role=null records=none calls=0 reads=0",
      "public unverified api": "404 reason=host-not-served role=null records=none calls=0 reads=0",
      "public unverified page": "404 reason=host-not-served role=null records=none calls=0 reads=0",
      "public verified api": "404 reason=host-not-served role=null records=none calls=0 reads=0",
      "public verified page": "404 reason=host-not-served role=null records=none calls=0 reads=0",
    });
  });

  test("every route on a host that is not served answers 404 before reading the app or a session", async () => {
    const app = await liveApp("Unserved", "members");
    const { site } = await h.domain({
      app,
      attachedBy: "person",
      hostname: "unserved.example.com",
      state: "verified",
    });
    const browser = h.browser();
    await h.signIn(browser, app, MEMBER);
    const cookie = browser.cookie(app, SESSION_COOKIE) ?? "";
    browser.setCookie(site, SESSION_COOKIE, cookie);
    const routes = {
      api: () => signUp(browser, site),
      complete: () => browser.request(site, "/_platform/auth/complete?handoff=x"),
      login: () => browser.request(site, "/_platform/auth/login?return_to=%2F"),
      logout: () =>
        browser.request(site, "/_platform/auth/logout", {
          headers: { "sec-fetch-site": "same-origin" },
          method: "POST",
        }),
      me: () => browser.request(site, "/_platform/me"),
      page: () => browser.request(site, "/"),
    };
    const observed: Record<string, string> = {};
    for (const [route, send] of Object.entries(routes)) {
      observed[route] = await databaseWork(async () => outcome(await send()));
    }

    expect({
      observed,
      session: (await h.apps.getSession({ sessionId: sessionIdOf(cookie) }))?.data.appId,
    }).toEqual({
      observed: {
        api: "404 reason=host-not-served role=null records=none calls=0 reads=0",
        complete: "404 reason=host-not-served role=null records=none calls=0 reads=0",
        login: "404 reason=host-not-served role=null records=none calls=0 reads=0",
        logout: "404 reason=host-not-served role=null records=none calls=0 reads=0",
        me: "404 reason=host-not-served role=null records=none calls=0 reads=0",
        page: "404 reason=host-not-served role=null records=none calls=0 reads=0",
      },
      session: app.data.id,
    });
  });

  test("a detached domain stops serving pages and calls once the five-second host cache expires", async () => {
    const app = await liveApp("Detached", "public");
    const { domain, site } = await h.domain({
      app,
      attachedBy: "person",
      hostname: "detached.example.com",
      state: "active",
    });
    const browser = h.browser({ address: "198.51.100.120" });
    const observed = [outcome(await browser.request(site, "/"))];

    await h.detachDomain(domain);
    h.advance(CACHE_TTL_MS - 1);
    observed.push(outcome(await browser.request(site, "/")));
    h.advance(1);
    observed.push(
      outcome(await browser.request(site, "/")),
      outcome(await signUp(browser, site)),
      outcome(await browser.request(app, "/")),
    );

    expect(observed).toEqual([
      "200 reason=null role=visitor",
      "200 reason=null role=visitor",
      "404 reason=host-not-served role=null",
      "404 reason=host-not-served role=null",
      "200 reason=null role=visitor",
    ]);
  });

  test("a host that becomes active starts serving once its cached miss expires", async () => {
    const app = await liveApp("Activated", "public");
    const site = { app, hostname: "activated.example.com" };
    const browser = h.browser({ address: "198.51.100.121" });
    const observed = [outcome(await browser.request(site, "/"))];

    await h.domain({ app, attachedBy: "person", hostname: site.hostname, state: "active" });
    observed.push(outcome(await browser.request(site, "/")));
    h.advance(CACHE_TTL_MS);
    observed.push(outcome(await browser.request(site, "/")));

    expect(observed).toEqual([
      "404 reason=host-not-served role=null",
      "404 reason=host-not-served role=null",
      "200 reason=null role=visitor",
    ]);
  });
});

describe("custom host sign-in", () => {
  test("a member signs in on a person-attached domain and the session stays on that host", async () => {
    const app = await liveApp("Bookings", "members");
    const { site } = await h.domain({
      app,
      attachedBy: "person",
      hostname: "bookings.example.com",
      state: "active",
    });
    const browser = h.browser();
    const step = await h.startSignIn(browser, site, MEMBER);
    const complete = await browser.request(site, step.completePath);
    const cookie = browser.cookie(site, SESSION_COOKIE) ?? "";
    browser.setCookie(app, SESSION_COOKIE, cookie);
    const session = await h.apps.getSession({ sessionId: sessionIdOf(cookie) });

    expect({
      authorize: new URL(step.authorize.headers.get("location") ?? "").origin,
      callback: step.callback.headers.get("location")?.replace(/handoff=.+$/u, "handoff=…"),
      complete: complete.headers.get("location"),
      onCustomHost: outcome(await browser.request(site, "/")),
      onSlugHost: outcome(await browser.request(app, "/")),
      sessionHost: session?.data.host.kind === "custom" ? session.data.host.hostname : "slug",
    }).toEqual({
      authorize: "https://auth.test",
      callback: "https://bookings.example.com/_platform/auth/complete?handoff=…",
      complete: "/orders?status=open",
      onCustomHost: "200 reason=null role=viewer",
      onSlugHost: "403 reason=other-host role=null",
      sessionHost: "bookings.example.com",
    });
  });

  test("a member on an API-key-attached domain signs in on the slug host instead", async () => {
    const app = await liveApp("Tickets", "members");
    const { site } = await h.domain({
      app,
      attachedBy: "api-key",
      hostname: "tickets.example.com",
      state: "active",
    });
    const browser = h.browser();
    const page = outcome(await browser.request(site, "/orders"));
    const login = outcome(await browser.request(site, "/_platform/auth/login?return_to=%2Forders"));
    const binding = browser.cookie(site, LOGIN_BINDING_COOKIE) ?? "none";
    await h.signIn(browser, app, MEMBER);

    expect({
      binding,
      login,
      page,
      slugHostAfterSignIn: outcome(await browser.request(app, "/")),
      customHostAfterSignIn: outcome(await browser.request(site, "/orders")),
    }).toEqual({
      binding: "none",
      login: `302 ${slugLogin(app, "/orders")} role=null`,
      page: "302 /_platform/auth/login?return_to=%2Forders role=null",
      slugHostAfterSignIn: "200 reason=null role=viewer",
      customHostAfterSignIn: "302 /_platform/auth/login?return_to=%2Forders role=null",
    });
  });

  test("a visitor on an API-key-attached domain of a public app gets the page", async () => {
    const app = await liveApp("Gallery", "public");
    const { site } = await h.domain({
      app,
      attachedBy: "api-key",
      hostname: "gallery.example.com",
      state: "active",
    });

    expect(outcome(await h.browser().request(site, "/"))).toBe("200 reason=null role=visitor");
  });

  test("a bearer call needs no fetch metadata on the slug host and on a person- or key-attached domain", async () => {
    const app = await liveApp("Bearers", "public");
    const token = await h.devToken(app, "viewer");
    const sites: Record<string, Site> = { slug: app };
    for (const attachedBy of ["person", "api-key"] as const) {
      const { site } = await h.domain({
        app,
        attachedBy,
        hostname: `bearer-${attachedBy}.example.com`,
        state: "active",
      });
      sites[attachedBy] = site;
    }
    const agent = h.browser({ address: "198.51.100.122" });
    const observed: Record<string, string> = {};
    for (const [name, site] of Object.entries(sites)) {
      const response = await agent.request(site, "/_platform/api/sign_up", {
        body: '{"p_email":"guest@example.com"}',
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        method: "POST",
      });
      observed[name] = outcome(response);
    }

    expect(observed).toEqual({
      "api-key": "200 reason=null role=visitor",
      person: "200 reason=null role=visitor",
      slug: "200 reason=null role=viewer",
    });
  });

  test("a host an API key re-attached honors no session or handoff issued while a person's domain held it", async () => {
    const app = await liveApp("Reclaimed", "members");
    const hostname = "reclaimed.example.com";
    const first = await h.domain({ app, attachedBy: "person", hostname, state: "active" });
    const member = h.browser();
    await h.signIn(member, first.site, MEMBER);
    const cookie = member.cookie(first.site, SESSION_COOKIE) ?? "";
    const before = outcome(await member.request(first.site, "/"));
    const pending = h.browser();
    const step = await h.startSignIn(pending, first.site, MEMBER);

    await h.detachDomain(first.domain);
    const { site } = await h.domain({ app, attachedBy: "api-key", hostname, state: "active" });
    h.advance(CACHE_TTL_MS);

    expect({
      before,
      complete: outcome(await pending.request(site, step.completePath)),
      me: outcome(await member.request(site, "/_platform/me")),
      page: outcome(await member.request(site, "/orders")),
      logout: outcome(await member.request(site, "/_platform/auth/logout", { method: "POST" })),
      session: (await h.apps.getSession({ sessionId: sessionIdOf(cookie) }))?.data.appId,
    }).toEqual({
      before: "200 reason=null role=viewer",
      complete: "403 reason=host-not-signable role=null",
      logout: "204 reason=null role=null",
      me: "401 reason=anonymous role=null",
      page: "302 /_platform/auth/login?return_to=%2Forders role=null",
      session: app.data.id,
    });
  });

  test("the callback refuses a login whose domain was detached or changed after sign-in started", async () => {
    const observed: Record<string, string> = {};
    const elsewhere = await liveApp("Rehomed", "members");
    const changes = {
      detached: async () => undefined,
      "reattached by an API key": async (app: AppRecord, hostname: string) => {
        await h.domain({ app, attachedBy: "api-key", hostname, state: "active" });
      },
      "reattached by a person but only verified": async (app: AppRecord, hostname: string) => {
        await h.domain({ app, attachedBy: "person", hostname, state: "verified" });
      },
      "moved to another app": async (_app: AppRecord, hostname: string) => {
        await h.domain({ app: elsewhere, attachedBy: "person", hostname, state: "active" });
      },
    } as const;
    let index = 0;
    for (const [change, apply] of Object.entries(changes)) {
      index += 1;
      const app = await liveApp(`Changed${index}`, "members");
      const hostname = `changed-${index}.example.com`;
      const { domain, site } = await h.domain({
        app,
        attachedBy: "person",
        hostname,
        state: "active",
      });
      const browser = h.browser();
      const authorize = await browser.request(site, "/_platform/auth/login?return_to=%2Fdesk");
      await h.detachDomain(domain);
      await apply(app, hostname);
      const callback = await h.callback(browser, authorize, MEMBER);
      const link = /<a href="([^"]+)"/u.exec(await callback.text())?.[1] ?? "none";
      observed[change] =
        `${outcome(callback)} link=${link === slugLogin(app, "/desk") ? "slug host" : link}`;
    }

    expect(observed).toEqual({
      detached: "403 reason=host-not-signable role=null link=slug host",
      "moved to another app": "403 reason=host-not-signable role=null link=slug host",
      "reattached by a person but only verified":
        "403 reason=host-not-signable role=null link=slug host",
      "reattached by an API key": "403 reason=host-not-signable role=null link=slug host",
    });
  });
});

describe("custom host redirect safety", () => {
  test("return_to never leaves the host where sign-in started", async () => {
    const app = await liveApp("Returns", "members");
    const { site } = await h.domain({
      app,
      attachedBy: "person",
      hostname: "returns.example.com",
      state: "active",
    });
    const observed: Record<string, string | null> = {};
    for (const returnTo of [
      "//evil.example/steal",
      "https://evil.example/steal",
      "/\\evil.example",
      "/_platform/auth/logout",
      "/orders?next=https://evil.example",
    ]) {
      const browser = h.browser();
      const step = await h.startSignIn(browser, site, MEMBER, returnTo);
      const complete = await browser.request(site, step.completePath);
      observed[returnTo] =
        `${new URL(step.callback.headers.get("location") ?? "").origin} ${complete.headers.get("location")}`;
    }

    expect(observed).toEqual({
      "/\\evil.example": "https://returns.example.com /",
      "//evil.example/steal": "https://returns.example.com /",
      "/_platform/auth/logout": "https://returns.example.com /",
      "/orders?next=https://evil.example":
        "https://returns.example.com /orders?next=https://evil.example",
      "https://evil.example/steal": "https://returns.example.com /",
    });
  });

  test("a handoff is redeemed only on the host it was issued for", async () => {
    const app = await liveApp("Handoffs", "members");
    const { site } = await h.domain({
      app,
      attachedBy: "person",
      hostname: "handoffs.example.com",
      state: "active",
    });
    const observed: Record<string, string> = {};
    for (const [issuedOn, redeemedOn] of [
      [site, app],
      [app, site],
    ] as const) {
      const browser = h.browser();
      const step = await h.startSignIn(browser, issuedOn, MEMBER);
      browser.setCookie(
        redeemedOn,
        LOGIN_BINDING_COOKIE,
        browser.cookie(issuedOn, LOGIN_BINDING_COOKIE) ?? "",
      );
      const stolen = outcome(await browser.request(redeemedOn, step.completePath));
      const own = outcome(await browser.request(issuedOn, step.completePath));
      observed[issuedOn === app ? "slug handoff" : "custom handoff"] = `${stolen} then ${own}`;
    }

    expect(observed).toEqual({
      "custom handoff": "403 reason=other-host role=null then 303 /orders?status=open role=null",
      "slug handoff": "403 reason=other-host role=null then 303 /orders?status=open role=null",
    });
  });
});
