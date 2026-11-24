import { describe, expect, test } from "bun:test";
import { ReleaseDocumentPath } from "@deployments-ai/db";
import { Schema } from "effect";
import { renderedPages } from "./rendered-pages.ts";
import { id } from "./test-support.ts";

const APP = id("01ARZ3NDEKTSV4RRFFQ69G5FC0");
const RELEASE = id("01ARZ3NDEKTSV4RRFFQ69G5FC1");
const document = Schema.decodeUnknownSync(ReleaseDocumentPath);
const INDEX = document("index.html");
const HTML = '<head><link rel="stylesheet" href="site.css"></head>';

function countingPages(maxBytes: number) {
  const reads: string[] = [];
  const pages = renderedPages({
    maxBytes,
    releases: {
      document: async ({ document: path }) => {
        reads.push(path);
        return path === "gone.html" ? undefined : HTML;
      },
    },
  });
  return { pages, reads };
}

describe("renderedPages", () => {
  test("renders one document once per serving mode and serves repeats from the cache", async () => {
    const { pages, reads } = countingPages(1024 * 1024);
    const page = { appId: APP, document: INDEX, releaseId: RELEASE } as const;

    const rendered = [
      await pages({ ...page, serving: "single-page" }),
      await pages({ ...page, serving: "static-site" }),
      await pages({ ...page, serving: "single-page" }),
      await pages({ ...page, serving: "static-site" }),
    ];

    expect({ reads, rendered }).toEqual({
      reads: ["index.html", "index.html"],
      rendered: [
        `<head><base href="/_r/${RELEASE}/"><link rel="stylesheet" href="site.css"></head>`,
        `<head><link rel="stylesheet" href="/_r/${RELEASE}/site.css"></head>`,
        `<head><base href="/_r/${RELEASE}/"><link rel="stylesheet" href="site.css"></head>`,
        `<head><link rel="stylesheet" href="/_r/${RELEASE}/site.css"></head>`,
      ],
    });
  });

  test("evicts the least recently served page past its byte bound and never caches a missing object", async () => {
    const pageBytes =
      `<head><link rel="stylesheet" href="/_r/${RELEASE}/site.css"></head>`.length * 2;
    const { pages, reads } = countingPages(pageBytes * 2);
    const serve = (path: string) =>
      pages({ appId: APP, document: document(path), releaseId: RELEASE, serving: "static-site" });

    await serve("a.html");
    await serve("b.html");
    await serve("a.html");
    await serve("c.html");
    await serve("a.html");
    await serve("b.html");
    const missing = [await serve("gone.html"), await serve("gone.html")];

    expect({ missing, reads }).toEqual({
      missing: [undefined, undefined],
      reads: ["a.html", "b.html", "c.html", "b.html", "gone.html", "gone.html"],
    });
  });
});
