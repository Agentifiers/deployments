import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AppRecord, Ulid } from "@deployments-ai/db";
import { SESSION_COOKIE } from "./admission.ts";
import { gatewayHarness, INDEX_HTML, MEMBER, type GatewayHarness } from "./test-support.ts";

let h: GatewayHarness;
let payroll: AppRecord;
let vault: AppRecord;
let liveRelease: Ulid;

const SAME_ORIGIN_JSON = { "content-type": "application/json", "sec-fetch-site": "same-origin" };
const CROSS_SITE_FORM = { "content-type": "text/plain", "sec-fetch-site": "cross-site" };

beforeAll(async () => {
  h = await gatewayHarness();
  const live = await h.release(
    await h.activeApp({ access: "editor", name: "Payroll" }),
    INDEX_HTML,
    true,
  );
  payroll = live.app;
  liveRelease = live.releaseId;
  vault = (await h.release(await h.activeApp({ access: "none", name: "Vault" }), INDEX_HTML, true))
    .app;
});

afterAll(async () => {
  await h.stop();
});

interface Observed {
  readonly body: string;
  readonly headers: readonly (readonly string[])[];
  readonly status: number;
}

async function observed(response: Response): Promise<Observed> {
  const body = (await response.text())
    .replaceAll(payroll.data.id, "<payroll>")
    .replaceAll(vault.data.id, "<vault>")
    .replaceAll(liveRelease, "<release>");
  const headers = [...response.headers].filter(([name]) => name !== "date");
  return { body, headers, status: response.status };
}

test("a private app answers anonymous, refused, and member requests exactly as trunk did", async () => {
  const anonymous = h.browser();
  const member = h.browser();
  await h.signIn(member, payroll, MEMBER);
  const outsider = h.browser();
  await h.signIn(outsider, vault, MEMBER);
  const replayed = h.browser();
  replayed.setCookie(vault, SESSION_COOKIE, member.cookie(payroll, SESSION_COOKIE) ?? "");
  const stale = h.browser();
  stale.setCookie(payroll, SESSION_COOKIE, "s".repeat(43));
  const devToken = await h.devToken(payroll, "editor");
  const otherDevToken = await h.devToken(vault, "editor");
  const api = (body: string, headers: Record<string, string>) => ({
    body,
    headers,
    method: "POST",
  });
  const callsBefore = h.database.calls.length;
  const logsBefore = h.logs.length;

  const requests = [
    ["anonymous page", anonymous, payroll, "/", {}],
    ["anonymous deep page", anonymous, payroll, "/orders?status=open", {}],
    ["anonymous head", anonymous, payroll, "/", { method: "HEAD" }],
    [
      "anonymous call",
      anonymous,
      payroll,
      "/_platform/api/list_orders",
      api("{}", SAME_ORIGIN_JSON),
    ],
    [
      "anonymous cross-site call",
      anonymous,
      payroll,
      "/_platform/api/list_orders",
      api("{}", CROSS_SITE_FORM),
    ],
    ["anonymous me", anonymous, payroll, "/_platform/me", {}],
    ["unknown cookie page", stale, payroll, "/", {}],
    [
      "unknown cookie call",
      stale,
      payroll,
      "/_platform/api/list_orders",
      api("{}", SAME_ORIGIN_JSON),
    ],
    ["no-role page", outsider, vault, "/", {}],
    ["no-role call", outsider, vault, "/_platform/api/list_orders", api("{}", SAME_ORIGIN_JSON)],
    ["no-role me", outsider, vault, "/_platform/me", {}],
    ["other-app page", replayed, vault, "/", {}],
    ["other-app call", replayed, vault, "/_platform/api/list_orders", api("{}", SAME_ORIGIN_JSON)],
    [
      "other-app bearer call",
      anonymous,
      vault,
      "/_platform/api/list_orders",
      api("{}", { authorization: `Bearer ${devToken}` }),
    ],
    ["member page", member, payroll, "/", {}],
    ["member deep page", member, payroll, "/orders?status=open", {}],
    [
      "member call",
      member,
      payroll,
      "/_platform/api/create_order",
      api('{"p_status":"open"}', SAME_ORIGIN_JSON),
    ],
    [
      "member cross-site call",
      member,
      payroll,
      "/_platform/api/create_order",
      api("{}", CROSS_SITE_FORM),
    ],
    ["member me", member, payroll, "/_platform/me", {}],
    [
      "dev token call",
      anonymous,
      payroll,
      "/_platform/api/list_orders",
      api("{}", { authorization: `Bearer ${devToken}` }),
    ],
    [
      "other dev token on its own app",
      anonymous,
      vault,
      "/_platform/api/list_orders",
      api("{}", { authorization: `Bearer ${otherDevToken}` }),
    ],
  ] as const;
  const responses: Record<string, Observed> = {};
  for (const [name, browser, app, path, init] of requests) {
    responses[name] = await observed(await browser.request(app, path, init));
  }

  const actual = {
    calls: h.database.calls
      .slice(callsBefore)
      .map((call) => `${call.functionName} as ${call.role}, public ${call.appIsPublic}`),
    logs: h.logs
      .slice(logsBefore)
      .map(
        (entry) =>
          `${entry.app === payroll.data.id ? "payroll" : "vault"} ${entry.route} ${entry.status} function=${entry.function} reason=${entry.reason} role=${entry.role} rows=${entry.rows} databaseError=${entry.databaseError}`,
      ),
    responses,
  };
  expect(actual).toEqual(EXPECTED);
});

const EXPECTED = {
  calls: [
    "create_order as editor, public false",
    "list_orders as viewer, public false",
    "list_orders as viewer, public false",
  ],
  logs: [
    "payroll page 302 function=null reason=anonymous role=null rows=null databaseError=null",
    "payroll page 302 function=null reason=anonymous role=null rows=null databaseError=null",
    "payroll page 302 function=null reason=anonymous role=null rows=null databaseError=null",
    "payroll api 401 function=list_orders reason=anonymous role=null rows=null databaseError=null",
    "payroll api 401 function=list_orders reason=anonymous role=null rows=null databaseError=null",
    "payroll me 401 function=null reason=anonymous role=null rows=null databaseError=null",
    "payroll page 302 function=null reason=anonymous role=null rows=null databaseError=null",
    "payroll api 401 function=list_orders reason=anonymous role=null rows=null databaseError=null",
    "vault page 403 function=null reason=no-role role=null rows=null databaseError=null",
    "vault api 403 function=list_orders reason=no-role role=null rows=null databaseError=null",
    "vault me 403 function=null reason=no-role role=null rows=null databaseError=null",
    "vault page 403 function=null reason=other-app role=null rows=null databaseError=null",
    "vault api 403 function=list_orders reason=other-app role=null rows=null databaseError=null",
    "vault api 403 function=list_orders reason=other-app role=null rows=null databaseError=null",
    "payroll page 200 function=null reason=null role=editor rows=null databaseError=null",
    "payroll page 200 function=null reason=null role=editor rows=null databaseError=null",
    "payroll api 200 function=create_order reason=null role=editor rows=1 databaseError=null",
    "payroll api 403 function=create_order reason=cross-site role=null rows=null databaseError=null",
    "payroll me 200 function=null reason=null role=editor rows=null databaseError=null",
    "payroll api 200 function=list_orders reason=null role=viewer rows=1 databaseError=null",
    "vault api 200 function=list_orders reason=null role=viewer rows=1 databaseError=null",
  ],
  responses: {
    "anonymous page": {
      body: "",
      headers: [
        ["cache-control", "no-store"],
        ["content-length", "0"],
        ["location", "/_platform/auth/login?return_to=%2F"],
      ],
      status: 302,
    },
    "anonymous deep page": {
      body: "",
      headers: [
        ["cache-control", "no-store"],
        ["content-length", "0"],
        ["location", "/_platform/auth/login?return_to=%2Forders%3Fstatus%3Dopen"],
      ],
      status: 302,
    },
    "anonymous head": {
      body: "",
      headers: [
        ["cache-control", "no-store"],
        ["content-length", "0"],
        ["location", "/_platform/auth/login?return_to=%2F"],
      ],
      status: 302,
    },
    "anonymous call": {
      body: '{"error":{"code":"unauthenticated","message":"Sign in to use this app."}}',
      headers: [
        ["cache-control", "no-store"],
        ["content-length", "73"],
        ["content-type", "application/json; charset=utf-8"],
      ],
      status: 401,
    },
    "anonymous cross-site call": {
      body: '{"error":{"code":"unauthenticated","message":"Sign in to use this app."}}',
      headers: [
        ["cache-control", "no-store"],
        ["content-length", "73"],
        ["content-type", "application/json; charset=utf-8"],
      ],
      status: 401,
    },
    "anonymous me": {
      body: '{"error":{"code":"unauthenticated","message":"Sign in to use this app."}}',
      headers: [
        ["cache-control", "no-store"],
        ["content-length", "73"],
        ["content-type", "application/json; charset=utf-8"],
      ],
      status: 401,
    },
    "unknown cookie page": {
      body: "",
      headers: [
        ["cache-control", "no-store"],
        ["content-length", "0"],
        ["location", "/_platform/auth/login?return_to=%2F"],
      ],
      status: 302,
    },
    "unknown cookie call": {
      body: '{"error":{"code":"unauthenticated","message":"Sign in to use this app."}}',
      headers: [
        ["cache-control", "no-store"],
        ["content-length", "73"],
        ["content-type", "application/json; charset=utf-8"],
      ],
      status: 401,
    },
    "no-role page": {
      body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Access denied</title></head><body><main><h1>Access denied</h1><p>You have no access to this app.</p></main></body></html>',
      headers: [
        ["cache-control", "no-store"],
        ["content-length", "255"],
        ["content-type", "text/html; charset=utf-8"],
      ],
      status: 403,
    },
    "no-role call": {
      body: '{"error":{"code":"no_access","message":"You have no access to this app."}}',
      headers: [
        ["cache-control", "no-store"],
        ["content-length", "74"],
        ["content-type", "application/json; charset=utf-8"],
      ],
      status: 403,
    },
    "no-role me": {
      body: '{"error":{"code":"no_access","message":"You have no access to this app."}}',
      headers: [
        ["cache-control", "no-store"],
        ["content-length", "74"],
        ["content-type", "application/json; charset=utf-8"],
      ],
      status: 403,
    },
    "other-app page": {
      body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Access denied</title></head><body><main><h1>Access denied</h1><p>This session belongs to another app.</p></main></body></html>',
      headers: [
        ["cache-control", "no-store"],
        ["content-length", "260"],
        ["content-type", "text/html; charset=utf-8"],
      ],
      status: 403,
    },
    "other-app call": {
      body: '{"error":{"code":"other_app","message":"This session belongs to another app."}}',
      headers: [
        ["cache-control", "no-store"],
        ["content-length", "79"],
        ["content-type", "application/json; charset=utf-8"],
      ],
      status: 403,
    },
    "other-app bearer call": {
      body: '{"error":{"code":"other_app","message":"This session belongs to another app."}}',
      headers: [
        ["cache-control", "no-store"],
        ["content-length", "79"],
        ["content-type", "application/json; charset=utf-8"],
      ],
      status: 403,
    },
    "member page": {
      body: '<!doctype html><html><head><base href="/_r/<release>/"><title>Payroll</title></head><body><script type="module" src="./assets/app.js"></script></body></html>',
      headers: [
        ["cache-control", "no-store"],
        ["content-length", "174"],
        ["content-type", "text/html; charset=utf-8"],
      ],
      status: 200,
    },
    "member deep page": {
      body: '<!doctype html><html><head><base href="/_r/<release>/"><title>Payroll</title></head><body><script type="module" src="./assets/app.js"></script></body></html>',
      headers: [
        ["cache-control", "no-store"],
        ["content-length", "174"],
        ["content-type", "text/html; charset=utf-8"],
      ],
      status: 200,
    },
    "member call": {
      body: '{"rows":[{"id":7,"status":"open"}]}',
      headers: [
        ["cache-control", "no-store"],
        ["content-length", "35"],
        ["content-type", "application/json; charset=utf-8"],
      ],
      status: 200,
    },
    "member cross-site call": {
      body: '{"error":{"code":"cross_site_request","message":"API calls with a session cookie must come from the app\'s own pages."}}',
      headers: [
        ["cache-control", "no-store"],
        ["content-length", "119"],
        ["content-type", "application/json; charset=utf-8"],
      ],
      status: 403,
    },
    "member me": {
      body: '{"app":{"id":"<payroll>","name":"Payroll","slug":"payroll"},"caller":{"email":"member@example.com","kind":"member","principalId":"01ARZ3NDEKTSV4RRFFQ69G5FA7"},"role":"editor"}',
      headers: [
        ["cache-control", "no-store"],
        ["content-length", "192"],
        ["content-type", "application/json; charset=utf-8"],
      ],
      status: 200,
    },
    "dev token call": {
      body: '{"rows":[{"id":7,"status":"open"}]}',
      headers: [
        ["cache-control", "no-store"],
        ["content-length", "35"],
        ["content-type", "application/json; charset=utf-8"],
      ],
      status: 200,
    },
    "other dev token on its own app": {
      body: '{"rows":[{"id":7,"status":"open"}]}',
      headers: [
        ["cache-control", "no-store"],
        ["content-length", "35"],
        ["content-type", "application/json; charset=utf-8"],
      ],
      status: 200,
    },
  },
};
