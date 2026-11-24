import { describe, expect, test } from "bun:test";
import { withBaseHref } from "./rendered-pages.ts";
import { parseRequest, returnPath } from "./routes.ts";
import { id } from "./test-support.ts";

const APP = "01ARZ3NDEKTSV4RRFFQ69G5FC0";
const RELEASE = id("01ARZ3NDEKTSV4RRFFQ69G5FC1");

function parse(
  path: string,
  init: { readonly appId?: string; readonly host?: string; readonly method?: string } = {},
) {
  return parseRequest(
    new Request(`http://gateway${path}`, {
      headers: {
        ...(init.appId === undefined ? {} : { "x-deployments-app-id": init.appId }),
        ...(init.host === undefined ? {} : { "x-deployments-app-host": init.host }),
      },
      method: init.method ?? "GET",
    }),
  );
}

describe("returnPath", () => {
  test("keeps same-host paths and sends everything else home", () => {
    expect(
      [
        "/orders?status=open#top",
        "//evil.example/x",
        "/\\evil.example",
        "https://evil.example/",
        "/_platform/auth/login",
        `/_platform/preview/${RELEASE}/settings`,
        "/_platform?tab=1",
        "/_platform-guide?step=2",
        "orders",
        null,
      ].map((raw) => String(returnPath(raw))),
    ).toEqual([
      "/orders?status=open#top",
      "/",
      "/",
      "/",
      "/",
      "/",
      "/",
      "/_platform-guide?step=2",
      "/",
      "/",
    ]);
  });
});

describe("parseRequest", () => {
  test("routes the apex only to health and the callback", () => {
    expect<unknown>([
      parse("/_platform/healthz"),
      parse("/_platform/auth/callback?code=c&state=s&iss=https%3A%2F%2Fauth.test"),
      parse("/_platform/auth/login"),
      parse("/_platform/auth/callback", { method: "POST" }),
    ]).toEqual([
      { kind: "health" },
      {
        kind: "callback",
        query: { code: "c", error: null, iss: "https://auth.test", state: "s" },
      },
      { kind: "rejected", status: 404 },
      { kind: "rejected", status: 405 },
    ]);
  });

  test("parses app routes and refuses unknown platform paths", () => {
    expect<unknown>([
      parse("/_platform/api/list_orders", { appId: APP, method: "POST" }),
      parse("/_platform/api/list_orders", { appId: APP }),
      parse("/_platform/api/api.list_orders", { appId: APP, method: "POST" }),
      parse(`/_platform/preview/${RELEASE}/`, { appId: APP }),
      parse("/_platform/unknown", { appId: APP }),
      parse("/orders/7?tab=lines", { appId: APP }),
      parse("/café/a%2F..%2Fb.html?x=1#top", { appId: APP, method: "HEAD" }),
      parse("/orders", { appId: APP, method: "POST" }),
      parse("/orders", { appId: "not-a-ulid" }),
      parse("/", { appId: APP, host: "rsvp.example.com" }),
      parse("/", { appId: APP, host: "RSVP.example.com" }),
    ]).toEqual([
      {
        appId: APP,
        host: { kind: "slug" },
        kind: "app",
        route: { functionName: "list_orders", kind: "api" },
      },
      { kind: "rejected", status: 405 },
      { kind: "rejected", status: 404 },
      { kind: "rejected", status: 404 },
      { kind: "rejected", status: 404 },
      {
        appId: APP,
        host: { kind: "slug" },
        kind: "app",
        route: {
          kind: "page",
          path: "/orders/7?tab=lines",
          pathname: "/orders/7",
          search: "?tab=lines",
        },
      },
      {
        appId: APP,
        host: { kind: "slug" },
        kind: "app",
        route: {
          kind: "page",
          path: "/caf%C3%A9/a%2F..%2Fb.html?x=1",
          pathname: "/caf%C3%A9/a%2F..%2Fb.html",
          search: "?x=1",
        },
      },
      { kind: "rejected", status: 405 },
      { kind: "rejected", status: 404 },
      {
        appId: APP,
        host: { hostname: "rsvp.example.com", kind: "custom" },
        kind: "app",
        route: { kind: "page", path: "/", pathname: "/", search: "" },
      },
      { kind: "rejected", status: 404 },
    ]);
  });
});

describe("withBaseHref", () => {
  test("puts the base first in head, after the doctype, or at the start", () => {
    expect([
      withBaseHref('<html><head lang="en"><base href="/x/"></head></html>', RELEASE),
      withBaseHref("<!DOCTYPE html><body>hi</body>", RELEASE),
      withBaseHref("<p>hi</p>", RELEASE),
    ]).toEqual([
      `<html><head lang="en"><base href="/_r/${RELEASE}/"><base href="/x/"></head></html>`,
      `<!DOCTYPE html><base href="/_r/${RELEASE}/"><body>hi</body>`,
      `<base href="/_r/${RELEASE}/"><p>hi</p>`,
    ]);
  });
});
