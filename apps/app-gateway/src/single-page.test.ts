import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AppRecord, Ulid } from "@deployments-ai/db";
import {
  gatewayHarness,
  INDEX_HTML,
  MEMBER,
  type Browser,
  type GatewayHarness,
} from "./test-support.ts";

let h: GatewayHarness;
let payroll: AppRecord;
let emptyRelease: AppRecord;
let draft: AppRecord;
let liveRelease: Ulid;
let browser: Browser;

beforeAll(async () => {
  h = await gatewayHarness();
  const live = await h.release(
    await h.activeApp({ access: "viewer", name: "Payroll" }),
    INDEX_HTML,
    true,
  );
  payroll = live.app;
  liveRelease = live.releaseId;
  emptyRelease = (
    await h.release(await h.activeApp({ access: "viewer", name: "Roster" }), undefined, true)
  ).app;
  draft = await h.activeApp({ access: "viewer", name: "Ledger" });
  browser = h.browser();
  for (const app of [payroll, emptyRelease, draft]) await h.signIn(browser, app, MEMBER);
});

afterAll(async () => {
  await h.stop();
});

async function observed(app: AppRecord, path: string) {
  const response = await browser.request(app, path);
  return {
    body: await response.text(),
    headers: [...response.headers].filter(([name]) => name !== "date"),
    status: response.status,
  };
}

describe("single-page serving", () => {
  test("every page path answers exactly as before static-site serving existed", async () => {
    const paths = [
      "/",
      "/orders?status=open",
      "/about",
      "/about/",
      "/missing.html",
      "/styles/site.css",
      "/caf%C3%A9",
      "/100%25.jpg",
      "/a%23b.png",
      "/..%2Fsecret",
    ];
    const outcomes: Record<string, unknown> = {};
    for (const path of paths) outcomes[path] = await observed(payroll, path);
    const index = {
      body: `<!doctype html><html><head><base href="/_r/${liveRelease}/"><title>Payroll</title></head><body><script type="module" src="./assets/app.js"></script></body></html>`,
      headers: [
        ["cache-control", "no-store"],
        ["content-length", "174"],
        ["content-type", "text/html; charset=utf-8"],
      ],
      status: 200,
    };

    expect({
      draft: await observed(draft, "/about"),
      noIndex: await observed(emptyRelease, "/about"),
      payroll: outcomes,
    }).toEqual({
      draft: {
        body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ledger</title></head><body><main><h1>Ledger</h1><p>Ledger has not been published yet.</p></main></body></html>',
        headers: [
          ["cache-control", "no-store"],
          ["content-length", "244"],
          ["content-type", "text/html; charset=utf-8"],
        ],
        status: 200,
      },
      noIndex: {
        body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page not found</title></head><body><main><h1>Page not found</h1><p>This release has no index.html.</p></main></body></html>',
        headers: [
          ["cache-control", "no-store"],
          ["content-length", "257"],
          ["content-type", "text/html; charset=utf-8"],
        ],
        status: 404,
      },
      payroll: Object.fromEntries(paths.map((path) => [path, index])),
    });
  });
});
