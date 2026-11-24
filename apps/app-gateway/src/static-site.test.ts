import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AppRecord, Ulid } from "@deployments-ai/db";
import { livePage } from "./pages.ts";
import { renderedPages } from "./rendered-pages.ts";
import { gatewayHarness, MEMBER, type Browser, type GatewayHarness } from "./test-support.ts";

let h: GatewayHarness;
let site: AppRecord;
let releaseId: Ulid;
let browser: Browser;

function page(title: string) {
  return `<!doctype html><html><head><title>${title}</title><link rel="stylesheet" href="site.css"></head><body><a href="../index.html">Home</a></body></html>`;
}

function rendered(title: string, directory = "") {
  return `<!doctype html><html><head><title>${title}</title><link rel="stylesheet" href="/_r/${releaseId}/${directory}site.css"></head><body><a href="../index.html">Home</a></body></html>`;
}

function pageNotFound(message: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page not found</title></head><body><main><h1>Page not found</h1><p>${message}</p></main></body></html>`;
}

beforeAll(async () => {
  h = await gatewayHarness();
  const created = await h.activeApp({ access: "viewer", name: "Events" });
  const live = await h.release(
    created,
    {
      "404.html": page("Lost"),
      "about/index.html": page("About"),
      "gone.html": null,
      "index.html": page("Home"),
      "schedule.html": page("Schedule"),
      "site.css": "body { margin: 0 }",
    },
    true,
  );
  releaseId = live.releaseId;
  site = await h.serve(live.app, "static-site");
  browser = h.browser();
  await h.signIn(browser, site, MEMBER);
});

afterAll(async () => {
  await h.stop();
});

describe("static-site serving", () => {
  test("serves each page, redirects to canonical paths and assets, and answers misses with the site's 404 page", async () => {
    const paths = [
      "/",
      "/schedule",
      "/schedule.html",
      "/schedule/?ref=mail",
      "/about?ref=mail",
      "/about/",
      "/site.css?v=2",
      "/photos/caf%C3%A9.jpg",
      "/nowhere",
      "/old.html",
      "/gone.html",
    ];
    const outcomes: Record<string, unknown> = {};
    for (const path of paths) {
      const response = await browser.request(site, path);
      outcomes[path] = {
        body: await response.text(),
        location: response.headers.get("location"),
        status: response.status,
      };
    }

    expect(outcomes).toEqual({
      "/": { body: rendered("Home"), location: null, status: 200 },
      "/about/": { body: rendered("About", "about/"), location: null, status: 200 },
      "/about?ref=mail": { body: "", location: "/about/?ref=mail", status: 308 },
      "/gone.html": {
        body: pageNotFound("This release has no gone.html."),
        location: null,
        status: 404,
      },
      "/nowhere": { body: rendered("Lost"), location: null, status: 404 },
      "/old.html": { body: rendered("Lost"), location: null, status: 404 },
      "/photos/caf%C3%A9.jpg": {
        body: "",
        location: `/_r/${releaseId}/photos/caf%C3%A9.jpg`,
        status: 307,
      },
      "/schedule": { body: rendered("Schedule"), location: null, status: 200 },
      "/schedule.html": { body: rendered("Schedule"), location: null, status: 200 },
      "/schedule/?ref=mail": { body: "", location: "/schedule?ref=mail", status: 308 },
      "/site.css?v=2": { body: "", location: `/_r/${releaseId}/site.css?v=2`, status: 307 },
    });
  });

  test("page routes answer HEAD with the GET status and headers, content-length included, and no body", async () => {
    const exchange = async (path: string, method: string) => {
      const response = await browser.request(site, path, { method });
      const headers = Object.fromEntries([...response.headers].filter(([name]) => name !== "date"));
      return { body: await response.text(), headers, status: response.status };
    };
    for (const path of ["/schedule", "/about", "/about/", "/nowhere", "/gone.html"]) {
      const get = await exchange(path, "GET");
      expect(await exchange(path, "HEAD")).toEqual({ ...get, body: "" });
    }
    expect(await exchange("/schedule", "HEAD")).toMatchObject({
      headers: { "content-length": String(rendered("Schedule").length) },
    });
    expect(await exchange("/schedule", "POST")).toEqual({
      body: '{"error":{"code":"method_not_allowed","message":"This route does not take that method."}}',
      headers: expect.objectContaining({ "content-type": "application/json; charset=utf-8" }),
      status: 405,
    });
  });

  test("a live release that predates documents serves its home page and a platform 404 elsewhere", async () => {
    const context = {
      lookups: { releaseDocuments: async () => null },
      pages: renderedPages({
        maxBytes: 1024,
        releases: { document: async () => '<img src="photo.jpg">' },
      }),
    };
    const outcomes = [];
    for (const pathname of ["/", "/about/"]) {
      const { response } = await livePage(context, site, "viewer", { pathname, search: "" });
      outcomes.push({ body: await response.text(), status: response.status });
    }

    expect(outcomes).toEqual([
      { body: `<img src="/_r/${releaseId}/photo.jpg">`, status: 200 },
      {
        body: pageNotFound(
          "The live release predates static-site serving, so only its home page is served. Release and promote the app again to serve every page.",
        ),
        status: 404,
      },
    ]);
  });
});
