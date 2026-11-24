import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { APP_ID_HEADER } from "../apps/app-gateway/src/routes.ts";
import { readTerraformFiles } from "./terraform-files.ts";

const appRuntime = readTerraformFiles("infrastructure/modules/app-runtime", "");
const appsDomain = "apps.example.test";
const ordersApp = "01K00000000000000000000001";
const billingApp = "01K00000000000000000000002";
const release = "01K00000000000000000000003";
const billingRelease = "01KZ0000000000000000000000";
const viewerAddress = "203.0.113.7";
const connectionGroupEndpoint = "d111111abcdef8.cloudfront.net";
const notFound = { statusCode: 404, statusDescription: "Not Found" };
const APP_HOST_HEADER = "x-deployments-app-host";
const VIEWER_ADDRESS_HEADER = "x-deployments-viewer-address";
const forgedHeaders = {
  [APP_ID_HEADER]: billingApp,
  [APP_HOST_HEADER]: "forged.example.test",
  [VIEWER_ADDRESS_HEADER]: "198.51.100.1",
};

function terraformList(name: string) {
  const list = new RegExp(`^\\s*${name}\\s*=\\s*\\[([^\\]]*)\\]`, "mu").exec(appRuntime)?.[1];
  if (list === undefined) throw new Error(`Missing ${name}`);
  return [...list.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

interface ViewerRequest {
  readonly headers: Record<string, { readonly value: string }>;
  readonly uri: string;
}
interface ViewerEvent {
  readonly context: { readonly endpoint?: string };
  readonly request: ViewerRequest;
  readonly viewer: { readonly ip: string };
}
type Handler = (event: ViewerEvent) => Promise<unknown>;
type Tenant = { readonly appId: string } | "unavailable" | "unused";

function loadFunction(tenant: Tenant) {
  const source = readFileSync("infrastructure/modules/app-runtime/viewer-request.js", "utf8");
  const importLine = 'import cf from "cloudfront";\n';
  if (!source.startsWith(importLine)) throw new Error("viewer-request.js must import cloudfront");
  const body = source
    .slice(importLine.length)
    .replaceAll(`\${apps_domain}`, appsDomain)
    .replaceAll(`\${document_extensions}`, terraformList("document_extensions").join("|"));
  const appHosts: Record<string, string> = { billing: billingApp, orders: ordersApp };
  const originSelections: unknown[][] = [];
  let tenantReads = 0;
  const cf = {
    kvs: () => ({
      async get(key: string) {
        const value = appHosts[key];
        if (value === undefined) throw new Error(`The key ${key} does not exist.`);
        return value;
      },
    }),
    get distributionTenant() {
      tenantReads += 1;
      if (tenant === "unused") throw new Error("A standard distribution has no tenant.");
      if (tenant === "unavailable") throw new Error("The tenant module failed.");
      return {
        parameters: {
          get: (name: string) => {
            if (name !== "appId") throw new Error(`No tenant parameter ${name}.`);
            return tenant.appId;
          },
        },
      };
    },
    selectRequestOriginById: (...args: unknown[]) => originSelections.push(args),
  };
  const handler = runInNewContext(`"use strict";\n${body}\nhandler;`, { cf }) as Handler;
  return { handler, originSelections, tenantReads: () => tenantReads };
}

function viewerEvent(
  host: string,
  uri: string,
  { endpoint, headers = {} }: { endpoint?: string; headers?: Record<string, string> } = {},
): ViewerEvent {
  return {
    context: endpoint === undefined ? {} : { endpoint },
    request: {
      headers: Object.fromEntries(
        Object.entries({ host, ...headers }).map(([name, value]) => [name, { value }]),
      ),
      uri,
    },
    viewer: { ip: viewerAddress },
  };
}

function forwarded(host: string, uri: string, headers: Record<string, string> = {}) {
  return {
    headers: Object.fromEntries(
      Object.entries({ host, ...headers }).map(([name, value]) => [name, { value }]),
    ),
    uri,
  };
}

test("is the code OpenTofu publishes, templated with the apps domain, the document extensions, and the host map", () => {
  const resource = /resource "aws_cloudfront_function" "viewer_request" \{[\s\S]*?\n\}/u.exec(
    appRuntime,
  )?.[0];
  expect(resource).toContain('runtime                      = "cloudfront-js-2.0"');
  expect(resource).toContain(
    `code                         = templatefile("\${path.module}/viewer-request.js", { apps_domain = var.domain, document_extensions = join("|", local.document_extensions) })`,
  );
  expect(resource).toContain(
    "key_value_store_associations = [aws_cloudfront_key_value_store.app_hosts.arn]",
  );
  expect(terraformList("document_extensions")).toEqual([
    "html",
    "htm",
    "xhtml",
    "svg",
    "xml",
    "xsl",
    "pdf",
  ]);
});

describe("on the apps distribution", () => {
  const { handler: standard, originSelections, tenantReads } = loadFunction("unused");
  test("refuses service worker script fetches on app hosts and the apex", async () => {
    for (const host of [`orders.${appsDomain}`, appsDomain]) {
      expect(
        await standard(viewerEvent(host, "/sw.js", { headers: { "service-worker": "script" } })),
      ).toEqual({ statusCode: 403, statusDescription: "Forbidden" });
    }
  });

  test("answers 404 for hosts that map to no app", async () => {
    for (const host of [
      `unknown.${appsDomain}`,
      `a.orders.${appsDomain}`,
      "orders.example.test",
      `orders.${appsDomain}.example.test`,
    ]) {
      expect(await standard(viewerEvent(host, "/"))).toEqual(notFound);
    }
  });

  test("serves only the sign-in callback and health check on the apex, with no edge headers", async () => {
    for (const uri of [
      "/",
      "/_platform/auth/login",
      "/_platform/me",
      "/_platform/auth/callback/",
      `/_r/${release}/index.js`,
    ]) {
      expect(await standard(viewerEvent(appsDomain, uri))).toEqual(notFound);
    }
    for (const uri of ["/_platform/auth/callback", "/_platform/healthz"]) {
      expect(await standard(viewerEvent(appsDomain, uri, { headers: forgedHeaders }))).toEqual(
        forwarded(appsDomain, uri),
      );
    }
  });

  test("stamps the host's app id and the viewer address over client values for the gateway", async () => {
    expect(
      await standard(viewerEvent(`Orders.${appsDomain}`, "/orders", { headers: forgedHeaders })),
    ).toEqual(
      forwarded(`Orders.${appsDomain}`, "/orders", {
        [APP_ID_HEADER]: ordersApp,
        [VIEWER_ADDRESS_HEADER]: viewerAddress,
      }),
    );
  });

  test("rewrites release paths only into the host app's release prefix", async () => {
    const host = `orders.${appsDomain}`;
    expect(await standard(viewerEvent(host, `/_r/${release}/assets/app.js`))).toEqual(
      forwarded(host, `/apps/${ordersApp}/releases/${release}/assets/app.js`),
    );
    expect(await standard(viewerEvent(host, `/_r/${billingRelease}/index.js`))).toEqual(
      forwarded(host, `/apps/${ordersApp}/releases/${billingRelease}/index.js`),
    );
    for (const uri of [
      `/_r/${release}/../../${billingApp}/releases/${billingRelease}/index.js`,
      `/_r/${release}/%2E%2e/%2e%2E/${billingApp}/releases/${billingRelease}/index.js`,
      `/_r/${release}/assets//app.js`,
      `/_r/${release}/./index.js`,
      `/_r/../${billingApp}/releases/${billingRelease}/index.js`,
      `/_r/${release.toLowerCase()}/index.js`,
      `/_r/${release}/`,
    ]) {
      expect(await standard(viewerEvent(host, uri))).toEqual(notFound);
    }
  });

  test("never serves a document from a release path, judged on the decoded path", async () => {
    const host = `orders.${appsDomain}`;
    const documents = [
      `/_r/${release}/index.html`,
      `/_r/${release}/INDEX.HTM`,
      `/_r/${release}/index%2Ehtml`,
      `/_r/${release}/logo.svg`,
      `/_r/${release}/pages/about.xhtml`,
      `/_r/${release}/feed.Xml`,
      `/_r/${release}/feed.xsl`,
      `/_r/${release}/report.pdf`,
      `/_r/${release}/app%E0%A4%A.js`,
    ];
    const outcomes = await Promise.all(documents.map((uri) => standard(viewerEvent(host, uri))));

    expect({
      asset: await standard(viewerEvent(host, `/_r/${release}/assets/app.js`)),
      documents: outcomes,
      encodedAsset: await standard(viewerEvent(host, `/_r/${release}/assets/html%20parser.js`)),
      htmlNamedAsset: await standard(viewerEvent(host, `/_r/${release}/assets/html.js`)),
    }).toEqual({
      asset: forwarded(host, `/apps/${ordersApp}/releases/${release}/assets/app.js`),
      documents: documents.map(() => notFound),
      encodedAsset: forwarded(
        host,
        `/apps/${ordersApp}/releases/${release}/assets/html%20parser.js`,
      ),
      htmlNamedAsset: forwarded(host, `/apps/${ordersApp}/releases/${release}/assets/html.js`),
    });
  });

  test("never reads a tenant or selects an origin", async () => {
    await standard(viewerEvent(appsDomain, "/_platform/auth/callback"));
    await standard(viewerEvent(`orders.${appsDomain}`, "/"));
    await standard(viewerEvent(`orders.${appsDomain}`, `/_r/${release}/assets/app.js`));
    expect({ originSelections, tenantReads: tenantReads() }).toEqual({
      originSelections: [],
      tenantReads: 0,
    });
  });
});

describe("on the custom-domain distribution", () => {
  const customHost = "Events.Example.COM";
  const tenantEvent = (uri: string, headers: Record<string, string> = {}) =>
    viewerEvent(customHost, uri, { endpoint: connectionGroupEndpoint, headers });

  test("sends a page request to the gateway as the tenant's app, with the lowercased host and viewer address", async () => {
    const { handler, originSelections } = loadFunction({ appId: ordersApp });
    expect({
      originSelections,
      request: await handler(tenantEvent("/schedule", forgedHeaders)),
    }).toEqual({
      originSelections: [["gateway", { allowedCertificateNames: [`*.${appsDomain}`] }]],
      request: forwarded(customHost, "/schedule", {
        [APP_ID_HEADER]: ordersApp,
        [APP_HOST_HEADER]: "events.example.com",
        [VIEWER_ADDRESS_HEADER]: viewerAddress,
      }),
    });
  });

  test("answers 404 for the same host without an endpoint, never reading a tenant", async () => {
    const { handler, tenantReads } = loadFunction({ appId: ordersApp });
    expect({
      page: await handler(viewerEvent(customHost, "/schedule")),
      tenantReads: tenantReads(),
    }).toEqual({ page: notFound, tenantReads: 0 });
  });

  test("keeps the apex and slug rules on the apps domain, as if no endpoint were set", async () => {
    const tenant = loadFunction({ appId: ordersApp });
    const { handler: standard } = loadFunction("unused");
    const slugHost = `billing.${appsDomain}`;
    const requests = [
      [slugHost, "/"],
      [slugHost, `/_r/${billingRelease}/assets/app.js`],
      [appsDomain, "/_platform/auth/callback"],
    ] as const;
    const outcomes = await Promise.all(
      requests.map(async ([host, uri]) => ({
        withEndpoint: await tenant.handler(
          viewerEvent(host, uri, { endpoint: connectionGroupEndpoint, headers: forgedHeaders }),
        ),
        withoutEndpoint: await standard(viewerEvent(host, uri, { headers: forgedHeaders })),
      })),
    );
    expect({
      originSelections: tenant.originSelections,
      outcomes,
      tenantReads: tenant.tenantReads(),
    }).toEqual({
      originSelections: [],
      outcomes: [
        forwarded(slugHost, "/", {
          [APP_ID_HEADER]: billingApp,
          [VIEWER_ADDRESS_HEADER]: viewerAddress,
        }),
        forwarded(slugHost, `/apps/${billingApp}/releases/${billingRelease}/assets/app.js`),
        forwarded(appsDomain, "/_platform/auth/callback"),
      ].map((request) => ({ withEndpoint: request, withoutEndpoint: request })),
      tenantReads: 0,
    });
  });

  test("rewrites release paths into the tenant app's prefix without changing the origin", async () => {
    const { handler, originSelections } = loadFunction({ appId: ordersApp });
    const rewritten = await handler(tenantEvent(`/_r/${release}/assets/app.js`, forgedHeaders));
    const refused = await Promise.all(
      [
        `/_r/${release}/index.html`,
        `/_r/${release}/../../${billingApp}/releases/${billingRelease}/index.js`,
        `/_r/${release}/`,
      ].map((uri) => handler(tenantEvent(uri))),
    );
    expect({ originSelections, refused, rewritten }).toEqual({
      originSelections: [],
      refused: [notFound, notFound, notFound],
      rewritten: forwarded(customHost, `/apps/${ordersApp}/releases/${release}/assets/app.js`),
    });
  });

  test("answers 404 when the tenant's app id cannot be read", async () => {
    const { handler, originSelections } = loadFunction("unavailable");
    expect({
      originSelections,
      page: await handler(tenantEvent("/", forgedHeaders)),
      release: await handler(tenantEvent(`/_r/${release}/assets/app.js`)),
    }).toEqual({ originSelections: [], page: notFound, release: notFound });
  });

  test("refuses service worker script fetches before reading the tenant", async () => {
    const { handler } = loadFunction("unavailable");
    expect(await handler(tenantEvent("/sw.js", { "service-worker": "script" }))).toEqual({
      statusCode: 403,
      statusDescription: "Forbidden",
    });
  });
});
