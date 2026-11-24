import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AppDatabaseError, type ApiCallInput } from "@deployments-ai/app-database";
import type { AppRecord } from "@deployments-ai/db";
import {
  gatewayHarness,
  INDEX_HTML,
  MEMBER,
  VISITOR_DEADLINE_MS,
  type Browser,
  type GatewayHarness,
} from "./test-support.ts";
import { apiCallLimits } from "./api-calls.ts";
import { callAsVisitor, tokenBuckets, VIEWER_ADDRESS_HEADER, viewerKey } from "./visitor-calls.ts";

const SAME_ORIGIN_JSON = { "content-type": "application/json", "sec-fetch-site": "same-origin" };

let h: GatewayHarness;

beforeAll(async () => {
  h = await gatewayHarness();
});

afterAll(async () => {
  await h.stop();
});

async function publicApp(name: string) {
  const created = await h.activeApp({ access: "viewer", name });
  const { app } = await h.release(created, INDEX_HTML, true);
  return h.publish(app, "public");
}

function call(
  browser: Browser,
  app: AppRecord,
  functionName: string,
  init: { readonly body?: string; readonly headers?: Record<string, string> } = {},
) {
  return browser.request(app, `/_platform/api/${functionName}`, {
    body: init.body ?? '{"p_email":"guest@example.com"}',
    headers: init.headers ?? SAME_ORIGIN_JSON,
    method: "POST",
  });
}

async function refusal(response: Response) {
  return {
    body: await response.json(),
    retryAfter: response.headers.get("retry-after"),
    status: response.status,
  };
}

describe("visitor calls", () => {
  test("an anonymous visitor's call writes through the database as the visitor role", async () => {
    const app = await publicApp("Signups");
    const before = h.database.signUps.length;
    const response = await call(h.browser(), app, "sign_up");
    const sent = h.database.calls.at(-1);

    expect({
      body: await response.json(),
      call: {
        ...sent,
        appId: String(sent?.appId),
        deadlineMs:
          sent?.deadlineMs !== undefined &&
          sent.deadlineMs > VISITOR_DEADLINE_MS - 100 &&
          sent.deadlineMs <= VISITOR_DEADLINE_MS,
      },
      log: { ...h.logs.at(-1), durationMs: 0 },
      written: h.database.signUps.slice(before),
    }).toEqual({
      body: { rows: [{ id: before + 1 }] },
      call: {
        appId: app.data.id,
        appIsPublic: true,
        args: { p_email: "guest@example.com" },
        deadlineMs: true,
        functionName: "sign_up",
        role: "visitor",
      },
      log: {
        app: app.data.id,
        databaseError: null,
        durationMs: 0,
        function: "sign_up",
        reason: null,
        role: "visitor",
        route: "api",
        rows: 1,
        status: 200,
      },
      written: [{ p_email: "guest@example.com" }],
    });
  });

  test("api functions and unknown names ask an anonymous visitor to sign in", async () => {
    const app = await publicApp("Closed");
    const visitor = h.browser();

    expect([
      await refusal(await call(visitor, app, "list_orders")),
      await refusal(await call(visitor, app, "no_such_function")),
    ]).toEqual(
      Array.from({ length: 2 }, () => ({
        body: { error: { code: "unauthenticated", message: "Sign in to use this app." } },
        retryAfter: null,
        status: 401,
      })),
    );
  });

  test("anonymous calls need same-origin JSON; a bearer token needs no fetch metadata", async () => {
    const app = await publicApp("Origins");
    const other = await publicApp("Elsewhere");
    const visitor = h.browser();
    const callsBefore = h.database.calls.length;
    const crossSite = await call(visitor, app, "sign_up", {
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
    });
    const form = await call(visitor, app, "sign_up", {
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
      },
    });
    const callsAfterRefusals = h.database.calls.length;
    const otherAppToken = await h.devToken(other, "viewer");
    const bearer = await call(visitor, app, "sign_up", {
      headers: { authorization: `Bearer ${otherAppToken}` },
    });

    expect({
      bearer: { role: h.logs.at(-1)?.role, status: bearer.status },
      crossSite: await refusal(crossSite),
      databaseCallsForRefusals: callsAfterRefusals - callsBefore,
      form: await refusal(form),
    }).toEqual({
      bearer: { role: "visitor", status: 200 },
      crossSite: {
        body: {
          error: {
            code: "cross_site_request",
            message: "Visitor calls must come from the app's own pages.",
          },
        },
        retryAfter: null,
        status: 403,
      },
      databaseCallsForRefusals: 0,
      form: {
        body: {
          error: {
            code: "json_required",
            message: "API calls must send Content-Type: application/json.",
          },
        },
        retryAfter: null,
        status: 403,
      },
    });
  });

  test("a call without the edge's viewer address is refused before any limit or database work", async () => {
    const app = await publicApp("Unstamped");
    const callsBefore = h.database.calls.length;
    const response = await call(h.browser({ address: null }), app, "sign_up");

    expect({
      databaseCalls: h.database.calls.length - callsBefore,
      refusal: await refusal(response),
    }).toEqual({
      databaseCalls: 0,
      refusal: {
        body: {
          error: {
            code: "viewer_address_required",
            message: "Visitor calls must come through the platform's edge.",
          },
        },
        retryAfter: null,
        status: 403,
      },
    });
  });
});

describe("visitor limits", () => {
  test("one address gets a burst of 10 and then one call every 6 seconds", async () => {
    const app = await publicApp("Burst");
    const visitor = h.browser({ address: "198.51.100.20" });
    const statuses = [];
    for (let index = 0; index < 10; index += 1) {
      statuses.push((await call(visitor, app, "sign_up")).status);
    }
    const limited = await call(visitor, app, "sign_up");
    const limitedLog = h.logs.at(-1)?.reason;
    const neighbour = await call(h.browser({ address: "198.51.100.21" }), app, "sign_up");
    h.advance(5_999);
    const early = await call(visitor, app, "sign_up");
    h.advance(1);
    const refilled = await call(visitor, app, "sign_up");

    expect({
      early: early.status,
      limited: await refusal(limited),
      limitedLog,
      neighbour: neighbour.status,
      refilled: refilled.status,
      statuses,
    }).toEqual({
      early: 429,
      limited: {
        body: {
          error: {
            code: "rate_limited",
            message: "Too many calls; retry after the Retry-After delay.",
          },
        },
        retryAfter: "6",
        status: 429,
      },
      limitedLog: "rate-limited-address",
      neighbour: 200,
      refilled: 200,
      statuses: Array.from({ length: 10 }, () => 200),
    });
  });

  test("IPv6 addresses share a bucket per /56", async () => {
    const app = await publicApp("Prefixes");
    const first = h.browser({ address: "2001:db8:aa:bb01::1" });
    for (let index = 0; index < 10; index += 1) await call(first, app, "sign_up");
    const sameSlash56 = await call(
      h.browser({ address: "2001:db8:aa:bbff:ffff:ffff:ffff:9" }),
      app,
      "sign_up",
    );
    const nextSlash56 = await call(h.browser({ address: "2001:db8:aa:bc00::1" }), app, "sign_up");

    expect({ nextSlash56: nextSlash56.status, sameSlash56: sameSlash56.status }).toEqual({
      nextSlash56: 200,
      sameSlash56: 429,
    });
  });

  test("an app gets a burst of 120 visitor calls across addresses, then one every 200 ms", async () => {
    const app = await publicApp("Crowd");
    const statuses = new Set<number>();
    for (let index = 0; index < 120; index += 1) {
      const visitor = h.browser({ address: `10.0.${Math.floor(index / 250)}.${index % 250}` });
      statuses.add((await call(visitor, app, "sign_up")).status);
    }
    const limited = await call(h.browser({ address: "10.1.0.1" }), app, "sign_up");
    const limitedLog = h.logs.at(-1)?.reason;
    h.advance(200);
    const refilled = await call(h.browser({ address: "10.1.0.2" }), app, "sign_up");

    expect({
      limited: await refusal(limited),
      limitedLog,
      refilled: refilled.status,
      statuses: [...statuses],
    }).toEqual({
      limited: {
        body: {
          error: {
            code: "rate_limited",
            message: "Too many calls; retry after the Retry-After delay.",
          },
        },
        retryAfter: "1",
        status: 429,
      },
      limitedLog: "rate-limited-app",
      refilled: 200,
      statuses: [200],
    });
  });

  test("a visitor body over 16 KiB is refused with 413 and one at the cap is accepted", async () => {
    const app = await publicApp("Bodies");
    const atCap = JSON.stringify({ p_note: "x".repeat(16 * 1024 - 13) });
    const visitor = h.browser({ address: "198.51.100.30" });
    const accepted = await call(visitor, app, "sign_up", { body: atCap });
    const tooLarge = await call(visitor, app, "sign_up", { body: `${atCap} ` });

    expect({
      accepted: accepted.status,
      atCapBytes: Buffer.byteLength(atCap),
      tooLarge: await refusal(tooLarge),
    }).toEqual({
      accepted: 200,
      atCapBytes: 16_384,
      tooLarge: {
        body: {
          error: {
            code: "body_too_large",
            message: "Visitor calls take at most 16384 bytes of arguments.",
          },
        },
        retryAfter: null,
        status: 413,
      },
    });
  });

  test("visitors get two calls per app inside a process-wide visitor cap that members do not share", async () => {
    const busy = await publicApp("BusyOne");
    const other = await publicApp("BusyTwo");
    const holding = [
      call(h.browser({ address: "192.0.2.1" }), busy, "hold"),
      call(h.browser({ address: "192.0.2.2" }), busy, "hold"),
      call(h.browser({ address: "192.0.2.3" }), other, "hold"),
    ];
    await h.database.whenHeld(3);
    const overShare = await call(h.browser({ address: "192.0.2.4" }), busy, "sign_up");
    const overProcessCap = await call(h.browser({ address: "192.0.2.5" }), other, "sign_up");
    const member = h.browser();
    await h.signIn(member, other, MEMBER);
    const memberCall = await call(member, other, "list_orders");
    h.database.releaseHeld();
    const released = await Promise.all(holding);
    const after = await call(h.browser({ address: "192.0.2.6" }), busy, "sign_up");

    expect({
      after: after.status,
      memberCall: memberCall.status,
      overProcessCap: await refusal(overProcessCap),
      overShare: await refusal(overShare),
      released: released.map((response) => response.status),
    }).toEqual({
      after: 200,
      memberCall: 200,
      overProcessCap: {
        body: { error: { code: "gateway_busy", message: "The app is busy; retry shortly." } },
        retryAfter: "5",
        status: 503,
      },
      overShare: {
        body: { error: { code: "gateway_busy", message: "The app is busy; retry shortly." } },
        retryAfter: "5",
        status: 503,
      },
      released: [200, 200, 200],
    });
  });

  test("a visitor call past the deadline answers the database's 504 and frees its slots at once", async () => {
    const app = await publicApp("Slow");
    const started = performance.now();
    const expired = await Promise.all([
      call(h.browser({ address: "192.0.2.10" }), app, "hold"),
      call(h.browser({ address: "192.0.2.11" }), app, "hold"),
    ]);
    const waitedMs = performance.now() - started;
    const next = await call(h.browser({ address: "192.0.2.12" }), app, "sign_up");

    expect({
      expired: await Promise.all(expired.map(refusal)),
      next: next.status,
      waitedForDeadline:
        waitedMs >= VISITOR_DEADLINE_MS - 5 && waitedMs < VISITOR_DEADLINE_MS + 200,
    }).toEqual({
      expired: Array.from({ length: 2 }, () => ({
        body: {
          error: { code: "deadline_exceeded", message: "The function took too long to answer." },
        },
        retryAfter: null,
        status: 504,
      })),
      next: 200,
      waitedForDeadline: true,
    });
  });

  test("a visitor call still waiting for a slot at the deadline answers busy and never reaches the database", async () => {
    const app = await publicApp("Queued");
    const called: string[] = [];
    const answered = Promise.withResolvers<void>();
    const context = {
      database: {
        callApiFunction: async (input: ApiCallInput) => {
          called.push(input.functionName);
          await answered.promise;
          return { rows: [] };
        },
      },
      limits: apiCallLimits({
        callerShare: 1,
        total: 4,
        visitorShare: 1,
        visitorTotal: 1,
        waitMs: 60_000,
      }),
      visitors: {
        address: () => ({ kind: "allowed" }) as const,
        app: () => ({ kind: "allowed" }) as const,
        bodyMaxBytes: 1_024,
        deadlineMs: 50,
        page: () => ({ kind: "allowed" }) as const,
      },
    };
    const visit = () =>
      callAsVisitor(context, {
        app,
        functionName: "hold",
        refusal: () => ({ response: new Response(null, { status: 401 }) }),
        request: new Request("http://gateway/_platform/api/hold", {
          body: "{}",
          headers: { [VIEWER_ADDRESS_HEADER]: "192.0.2.20" },
          method: "POST",
        }),
      });
    const running = visit();
    const queued = await visit();
    answered.resolve();
    const ran = await running;
    const after = await visit();

    expect({
      after: after.response.status,
      called,
      queued: { reason: queued.reason, status: queued.response.status },
      running: { reason: ran.reason ?? null, status: ran.response.status },
    }).toEqual({
      after: 200,
      called: ["hold", "hold"],
      queued: { reason: "gateway-busy", status: 503 },
      running: { reason: null, status: 200 },
    });
  });

  test("a visitor call that waited for its slot gets only the time left of its deadline", async () => {
    const app = await publicApp("Waiting");
    const deadlines: number[] = [];
    const context = {
      database: {
        callApiFunction: async (input: ApiCallInput) => {
          deadlines.push(input.deadlineMs ?? Number.NaN);
          // Real time: the gateway measures the slot wait with performance.now().
          if (deadlines.length === 1) await Bun.sleep(300);
          return { rows: [] };
        },
      },
      limits: apiCallLimits({
        callerShare: 1,
        total: 4,
        visitorShare: 1,
        visitorTotal: 1,
        waitMs: 60_000,
      }),
      visitors: {
        address: () => ({ kind: "allowed" }) as const,
        app: () => ({ kind: "allowed" }) as const,
        bodyMaxBytes: 1_024,
        deadlineMs: 1_000,
        page: () => ({ kind: "allowed" }) as const,
      },
    };
    const visit = () =>
      callAsVisitor(context, {
        app,
        functionName: "hold",
        refusal: () => ({ response: new Response(null, { status: 401 }) }),
        request: new Request("http://gateway/_platform/api/hold", {
          body: "{}",
          headers: { [VIEWER_ADDRESS_HEADER]: "192.0.2.21" },
          method: "POST",
        }),
      });
    const statuses = (await Promise.all([visit(), visit()])).map((done) => done.response.status);
    const [first = Number.NaN, second = Number.NaN] = deadlines;

    expect({
      first: first > 990 && first <= 1_000,
      second: second > 600 && second < 750,
      statuses,
    }).toEqual({ first: true, second: true, statuses: [200, 200] });
  });

  test("a visitor call whose commit was not confirmed answers 504 outcome_unknown", async () => {
    const app = await publicApp("Unconfirmed");
    const answered = await callAsVisitor(
      {
        database: {
          callApiFunction: async () => {
            throw new AppDatabaseError({
              code: "outcome_unknown",
              message: "The app database did not confirm COMMIT.",
            });
          },
        },
        limits: apiCallLimits({
          callerShare: 1,
          total: 4,
          visitorShare: 1,
          visitorTotal: 1,
          waitMs: 1,
        }),
        visitors: {
          address: () => ({ kind: "allowed" }) as const,
          app: () => ({ kind: "allowed" }) as const,
          bodyMaxBytes: 1_024,
          deadlineMs: 1_000,
          page: () => ({ kind: "allowed" }) as const,
        },
      },
      {
        app,
        functionName: "sign_up",
        refusal: () => ({ response: new Response(null, { status: 401 }) }),
        request: new Request("http://gateway/_platform/api/sign_up", {
          body: "{}",
          headers: { [VIEWER_ADDRESS_HEADER]: "192.0.2.22" },
          method: "POST",
        }),
      },
    );

    expect(await refusal(answered.response)).toEqual({
      body: {
        error: {
          code: "outcome_unknown",
          message:
            "The function did not finish in time and may have saved its changes; check before retrying.",
        },
      },
      retryAfter: null,
      status: 504,
    });
  });

  test("a declared body over the cap is refused before the gateway reads it", async () => {
    const app = await publicApp("Declared");
    const neverEnds = new ReadableStream<Uint8Array>({ start: () => undefined });
    const refused = await callAsVisitor(
      {
        database: { callApiFunction: async () => ({ rows: [] }) },
        limits: apiCallLimits({
          callerShare: 1,
          total: 4,
          visitorShare: 1,
          visitorTotal: 1,
          waitMs: 1,
        }),
        visitors: {
          address: () => ({ kind: "allowed" }) as const,
          app: () => ({ kind: "allowed" }) as const,
          bodyMaxBytes: 1_024,
          deadlineMs: 50,
          page: () => ({ kind: "allowed" }) as const,
        },
      },
      {
        app,
        functionName: "sign_up",
        refusal: () => ({ response: new Response(null, { status: 401 }) }),
        request: new Request("http://gateway/_platform/api/sign_up", {
          body: neverEnds,
          headers: { "content-length": "1025", [VIEWER_ADDRESS_HEADER]: "192.0.2.21" },
          method: "POST",
        }),
      },
    );

    expect({ reason: refused.reason, status: refused.response.status }).toEqual({
      reason: "body-too-large",
      status: 413,
    });
  });

  test("one address's call budget is kept per app", async () => {
    const first = await publicApp("BudgetOne");
    const second = await publicApp("BudgetTwo");
    const visitor = h.browser({ address: "198.51.100.40" });
    for (let index = 0; index < 10; index += 1) await call(visitor, first, "sign_up");
    const limited = await call(visitor, first, "sign_up");
    const otherApp = await call(visitor, second, "sign_up");

    expect({ limited: limited.status, otherApp: otherApp.status }).toEqual({
      limited: 429,
      otherApp: 200,
    });
  });
});

describe("apiCallLimits", () => {
  test("visitor calls also hold slots of the process total that member calls use", async () => {
    const limits = apiCallLimits({
      callerShare: 4,
      total: 2,
      visitorShare: 2,
      visitorTotal: 2,
      waitMs: 1,
    });
    const held = Promise.withResolvers<void>();
    const started = [1, 2].map(() => Promise.withResolvers<void>());
    const visitors = started.map((start) =>
      limits.visitor("a", () => {
        start.resolve();
        return held.promise;
      }),
    );
    await Promise.all(started.map((start) => start.promise));
    const whileHeld = await limits.caller("b/viewer", async () => "ran");
    held.resolve();
    await Promise.all(visitors);
    const afterwards = await limits.caller("b/viewer", async () => "ran");

    expect({ afterwards: afterwards.kind, whileHeld: whileHeld.kind }).toEqual({
      afterwards: "done",
      whileHeld: "busy",
    });
  });
});

describe("tokenBuckets", () => {
  test("a full map forgets refilled buckets first, then the oldest, and keeps limiting the rest", () => {
    let clock = 0;
    const take = tokenBuckets({
      limit: { burst: 1, perMinute: 60 },
      maximumKeys: 3,
      now: () => new Date(clock),
    });
    const first = ["a", "b"].map((key) => take(key).kind);
    clock = 1_000;
    const filling = ["c", "d"].map((key) => take(key).kind);
    const afterRefillPrune = ["c", "a"].map((key) => take(key).kind);
    const overflow = take("e").kind;
    const afterOldestPrune = ["c", "a"].map((key) => take(key).kind);

    expect({ afterOldestPrune, afterRefillPrune, filling, first, overflow }).toEqual({
      afterOldestPrune: ["allowed", "limited"],
      afterRefillPrune: ["limited", "allowed"],
      filling: ["allowed", "allowed"],
      first: ["allowed", "allowed"],
      overflow: "allowed",
    });
  });
});

describe("viewerKey", () => {
  test("keys IPv4 by address and IPv6 by /56, and refuses anything else", () => {
    expect(
      [
        "203.0.113.7",
        "2001:db8:aa:bb01::1",
        "2001:DB8:AA:BBFF:1:2:3:4",
        "::ffff:203.0.113.7",
        "::ffff:cb00:7107",
        "::1",
        "fe80::1%eth0",
        "203.0.113.7:443",
        "",
        null,
      ].map(viewerKey),
    ).toEqual([
      "203.0.113.7",
      "2001:db8:aa:bb00::/56",
      "2001:db8:aa:bb00::/56",
      "203.0.113.7",
      "203.0.113.7",
      "0:0:0:0::/56",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});
