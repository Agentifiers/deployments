import { describe, expect, test } from "bun:test";
import { ReleaseDocuments } from "@deployments-ai/db";
import { Schema } from "effect";
import { readFileSync } from "node:fs";
import { DOCUMENT_EXTENSIONS, hasDocumentExtension, resolvePage } from "./page-resolution.ts";

const documents = Schema.decodeUnknownSync(ReleaseDocuments);
const SITE = documents([
  "404.html",
  "about/index.html",
  "both.html",
  "both/index.html",
  "café.html",
  "contact.html",
  "index.html",
  "notes.htm",
]);
const SITE_WITHOUT_404 = documents(["about/index.html", "index.html"]);

function resolveAll(
  site: Parameters<typeof resolvePage>[0]["documents"],
  pathnames: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    pathnames.map((pathname) => [
      pathname,
      resolvePage({ documents: site, pathname, serving: "static-site" }),
    ]),
  );
}

const NOT_FOUND = { document: "404.html", kind: "not-found" };

describe("resolvePage", () => {
  test("a single-page app serves index.html at every path", () => {
    expect(
      ["/", "/orders/7", "/styles/site.css", "/..%2F", "/missing.html"].map((pathname) =>
        resolvePage({ documents: SITE, pathname, serving: "single-page" }),
      ),
    ).toEqual(Array(5).fill({ document: "index.html", kind: "document" }));
  });

  test("a static site whose release predates documents serves only its home page", () => {
    expect(resolveAll(null, ["/", "/about/", "/contact.html", "/styles/site.css"])).toEqual({
      "/": { document: "index.html", kind: "document" },
      "/about/": { kind: "unknown-documents" },
      "/contact.html": { kind: "unknown-documents" },
      "/styles/site.css": { kind: "unknown-documents" },
    });
  });

  test("a static site serves each listed document and redirects to its canonical path", () => {
    expect(
      resolveAll(SITE, [
        "/",
        "/contact.html",
        "/contact",
        "/contact/",
        "/notes.htm",
        "/about",
        "/about/",
        "/about/index.html",
        "/both",
        "/both/",
      ]),
    ).toEqual({
      "/": { document: "index.html", kind: "document" },
      "/about": { kind: "canonical", location: "/about/" },
      "/about/": { document: "about/index.html", kind: "document" },
      "/about/index.html": { document: "about/index.html", kind: "document" },
      "/both": { document: "both.html", kind: "document" },
      "/both/": { document: "both/index.html", kind: "document" },
      "/contact": { document: "contact.html", kind: "document" },
      "/contact.html": { document: "contact.html", kind: "document" },
      "/contact/": { kind: "canonical", location: "/contact" },
      "/notes.htm": { document: "notes.htm", kind: "document" },
    });
  });

  test("a miss with an asset extension goes to the release's assets and any other miss is not found", () => {
    expect(
      resolveAll(SITE, [
        "/styles/site.css",
        "/fonts/Inter.WOFF2",
        "/missing.html",
        "/missing",
        "/missing/",
        "/logo.svg",
        "/report.PDF",
        "/feed.xml",
      ]),
    ).toEqual({
      "/feed.xml": NOT_FOUND,
      "/fonts/Inter.WOFF2": { kind: "asset", path: "fonts/Inter.WOFF2" },
      "/logo.svg": NOT_FOUND,
      "/missing": NOT_FOUND,
      "/missing.html": NOT_FOUND,
      "/missing/": NOT_FOUND,
      "/report.PDF": NOT_FOUND,
      "/styles/site.css": { kind: "asset", path: "styles/site.css" },
    });
    expect(resolveAll(SITE_WITHOUT_404, ["/missing"])).toEqual({
      "/missing": { document: null, kind: "not-found" },
    });
  });

  test("matches decoded paths and builds every location from the encoded one", () => {
    expect(
      resolveAll(SITE, [
        "/caf%C3%A9.html",
        "/caf%C3%A9",
        "/100%25.jpg",
        "/a%23b.png",
        "/a&amp;b.png",
        "/caf%C3%A9/",
        "/%61bout",
      ]),
    ).toEqual({
      "/%61bout": { kind: "canonical", location: "/%61bout/" },
      "/100%25.jpg": { kind: "asset", path: "100%25.jpg" },
      "/a%23b.png": { kind: "asset", path: "a%23b.png" },
      "/a&amp;b.png": { kind: "asset", path: "a&amp;b.png" },
      "/caf%C3%A9": { document: "café.html", kind: "document" },
      "/caf%C3%A9.html": { document: "café.html", kind: "document" },
      "/caf%C3%A9/": { kind: "canonical", location: "/caf%C3%A9" },
    });
  });

  test("refuses empty, dot, and dot-dot segments, encoded separators, and bad escapes", () => {
    const refused = [
      "//contact.html",
      "/about//",
      "/./contact.html",
      "/about/../contact.html",
      "/%2e%2e/contact.html",
      "/about%2Findex.html",
      "/..%2Fsecret.css",
      "/a%5Cb.css",
      "/a\\b.css",
      "/%zz.css",
    ];

    expect(resolveAll(SITE, refused)).toEqual(
      Object.fromEntries(refused.map((pathname) => [pathname, NOT_FOUND])),
    );
  });
});

describe("DOCUMENT_EXTENSIONS", () => {
  test("matches the edge's document list and its case-insensitive rule", () => {
    const module = new URL("../../../infrastructure/modules/app-runtime/", import.meta.url);
    const edge = readFileSync(new URL("edge.tf", module), "utf8");
    const viewerRequest = readFileSync(new URL("viewer-request.js", module), "utf8");
    const edgeList = /^\s*document_extensions\s*=\s*\[([^\]]*)\]/mu.exec(edge)?.[1] ?? "";

    expect({
      caseRule: [hasDocumentExtension("Guide.HTML"), hasDocumentExtension("guide.css")],
      edge: [...edgeList.matchAll(/"([^"]+)"/gu)].map((match) => match[1]),
      edgeRegex: /\$\{document_extensions\}\)\$\/(\w*);/u.exec(viewerRequest)?.[1],
    }).toEqual({ caseRule: [true, false], edge: [...DOCUMENT_EXTENSIONS], edgeRegex: "i" });
  });
});
