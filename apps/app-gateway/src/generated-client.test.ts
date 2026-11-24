import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTypescriptClient } from "@deployments-ai/app-database";
import type { AppRecord } from "@deployments-ai/db";
import {
  DISABLED_MEMBER,
  gatewayHarness,
  INDEX_HTML,
  MEMBER,
  type Browser,
  type GatewayHarness,
} from "./test-support.ts";

const TEXT = { base: { element: null, kind: "b", name: "text" }, sql: "text" };
const INT4 = { base: { element: null, kind: "b", name: "int4" }, sql: "integer" };

const CLIENT_FUNCTIONS: Parameters<typeof renderTypescriptClient>[0] = [
  {
    arguments: [{ hasDefault: false, name: "p_status", type: TEXT }],
    name: "list_orders",
    result: {
      columns: [
        { name: "id", type: INT4 },
        { name: "status", type: TEXT },
      ],
      kind: "row",
    },
    returnsSet: true,
    schema: "api",
    volatility: "stable",
  },
  {
    arguments: [{ hasDefault: false, name: "p_email", type: TEXT }],
    name: "add_member",
    result: { kind: "void" },
    returnsSet: false,
    schema: "api",
    volatility: "volatile",
  },
  {
    arguments: [{ hasDefault: false, name: "p_email", type: TEXT }],
    name: "sign_up",
    result: { kind: "void" },
    returnsSet: false,
    schema: "visitor",
    volatility: "volatile",
  },
  {
    arguments: [],
    name: "retired_form",
    result: { kind: "void" },
    returnsSet: false,
    schema: "visitor",
    volatility: "volatile",
  },
];

type Client = Record<string, (args: object) => Promise<unknown>>;

let h: GatewayHarness;
let directory: string;
let client: Client;

beforeAll(async () => {
  h = await gatewayHarness();
  directory = await mkdtemp(join(tmpdir(), "platform-client-"));
  const file = join(directory, "platform-client.ts");
  await writeFile(file, renderTypescriptClient(CLIENT_FUNCTIONS));
  client = await import(file);
});

afterAll(async () => {
  await h.stop();
  await rm(directory, { force: true, recursive: true });
});

async function fromPage<T>(browser: Browser, app: AppRecord, work: () => Promise<T>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (url: string | URL | Request, init?: RequestInit) => {
      if (typeof url !== "string" || !url.startsWith("/")) return originalFetch(url, init);
      const headers = new Headers(init?.headers);
      headers.set("sec-fetch-site", "same-origin");
      return browser.request(app, url, {
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
        headers: Object.fromEntries(headers),
        method: init?.method ?? "GET",
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    return await work();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("the generated client reads the gateway's rows and error bodies", async () => {
  const app = await h.activeApp({ access: "editor", name: "Payroll" });
  const browser = h.browser();
  await h.signIn(browser, app, MEMBER);
  await fromPage(browser, app, async () => {
    const rows = await client.list_orders?.({ p_status: "open" });
    const args = h.database.calls.at(-1)?.args;
    const failure = await client
      .add_member?.({ p_email: "ada@example.com" })
      .catch((error: unknown) => error);

    expect({ args, rows }).toEqual({
      args: { p_status: "open" },
      rows: [{ id: 7, status: "open" }],
    });
    expect(failure).toMatchObject({
      code: "postgres_error",
      message: "The app's database refused the request.",
      name: "PlatformApiError",
      status: 422,
    });
  });
});

test("the client sends only unauthenticated callers to sign-in, once per call, and reports Retry-After on 429", async () => {
  const membersApp = await h.activeApp({ access: "viewer", name: "Ledger" });
  const { app: released } = await h.release(
    await h.activeApp({ access: "viewer", name: "Gala" }),
    INDEX_HTML,
    true,
  );
  const publicApp = await h.publish(released, "public");
  const refused = h.browser({ address: "198.51.100.90" });
  await h.signIn(refused, publicApp, DISABLED_MEMBER);
  const anonymous = h.browser({ address: "198.51.100.91" });
  const assigned: string[] = [];
  let redirected = () => {};
  const page = globalThis as { window?: unknown };
  page.window = {
    location: {
      assign: (url: string) => {
        assigned.push(url);
        redirected();
      },
      hash: "",
      pathname: "/",
      search: "",
    },
  };
  const settle = (call: Promise<unknown> | undefined) =>
    Promise.race([
      call?.then(
        () => "resolved",
        (error: { code: string; retryAfter?: number; status: number }) =>
          `${error.status} ${error.code} retryAfter=${error.retryAfter ?? null}`,
      ),
      new Promise<string>((resolve) => {
        redirected = () => resolve("redirected");
      }),
    ]);
  const step = async (outcome: Promise<string | undefined>) => {
    const before = assigned.length;
    return { outcome: await outcome, redirects: assigned.slice(before) };
  };
  try {
    const signIn = ["/_platform/auth/login?return_to=%2F"];
    const membersAnonymous = await fromPage(anonymous, membersApp, () =>
      step(settle(client.list_orders?.({ p_status: "open" }))),
    );
    const publicAnonymousApi = await fromPage(anonymous, publicApp, () =>
      step(settle(client.list_orders?.({ p_status: "open" }))),
    );
    const publicAnonymousUnknown = await fromPage(anonymous, publicApp, () =>
      step(settle(client.retired_form?.({}))),
    );
    const publicRefused = await fromPage(refused, publicApp, () =>
      step(settle(client.list_orders?.({ p_status: "open" }))),
    );
    const signUps = await fromPage(h.browser({ address: "198.51.100.92" }), publicApp, async () => {
      const outcomes = [];
      for (let index = 0; index < 11; index += 1) {
        outcomes.push(await settle(client.sign_up?.({ p_email: "guest@example.com" })));
      }
      return outcomes;
    });

    expect({
      membersAnonymous,
      publicAnonymousApi,
      publicAnonymousUnknown,
      publicRefused,
      signUps,
    }).toEqual({
      membersAnonymous: { outcome: "redirected", redirects: signIn },
      publicAnonymousApi: { outcome: "redirected", redirects: signIn },
      publicAnonymousUnknown: { outcome: "redirected", redirects: signIn },
      publicRefused: { outcome: "403 not_a_member retryAfter=null", redirects: [] },
      signUps: [...Array.from({ length: 10 }, () => "resolved"), "429 rate_limited retryAfter=6"],
    });
  } finally {
    delete page.window;
  }
});
