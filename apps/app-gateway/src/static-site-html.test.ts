import { describe, expect, test } from "bun:test";
import { ReleaseDocumentPath } from "@deployments-ai/db";
import { Schema } from "effect";
import { renderStaticSite } from "./static-site-html.ts";
import { id } from "./test-support.ts";

const RELEASE = id("01ARZ3NDEKTSV4RRFFQ69G5FC1");
const document = Schema.decodeUnknownSync(ReleaseDocumentPath);

function render(html: string, path = "travel/index.html") {
  return renderStaticSite(html, { document: document(path), releaseId: RELEASE });
}

describe("renderStaticSite", () => {
  test("removes base and points subresources at the release, resolved against the document's directory", () => {
    expect(
      render(
        [
          '<head><base href="/elsewhere/"><link rel="stylesheet" href="../styles.css">',
          '<link rel="Shortcut ICON" href="/favicon.ico"><link rel="modulepreload" href="app.js">',
          '<link rel="manifest" href="site.webmanifest"><link rel="preload" as="font" href="fonts/a.woff2">',
          '<link rel="canonical" href="index.html"><link rel="alternate" href="feed.css"></head>',
          '<img src="photos/a.webp" srcset="photos/a.webp 1x,photos/a@2x.webp 2x">',
          '<picture><source srcset="  wide.avif 800w ,  narrow.avif  400w  "></picture>',
          '<video poster="poster.jpg"><source src="clip.mp4"></video><script src="./app.js?v=2#x"></script>',
        ].join(""),
      ),
    ).toBe(
      [
        `<head><link rel="stylesheet" href="/_r/${RELEASE}/styles.css">`,
        `<link rel="Shortcut ICON" href="/_r/${RELEASE}/favicon.ico"><link rel="modulepreload" href="/_r/${RELEASE}/travel/app.js">`,
        `<link rel="manifest" href="/_r/${RELEASE}/travel/site.webmanifest"><link rel="preload" as="font" href="/_r/${RELEASE}/travel/fonts/a.woff2">`,
        '<link rel="canonical" href="index.html"><link rel="alternate" href="feed.css"></head>',
        `<img src="/_r/${RELEASE}/travel/photos/a.webp" srcset="/_r/${RELEASE}/travel/photos/a.webp 1x, /_r/${RELEASE}/travel/photos/a@2x.webp 2x">`,
        `<picture><source srcset="/_r/${RELEASE}/travel/wide.avif 800w, /_r/${RELEASE}/travel/narrow.avif 400w"></picture>`,
        `<video poster="/_r/${RELEASE}/travel/poster.jpg"><source src="/_r/${RELEASE}/travel/clip.mp4"></video><script src="/_r/${RELEASE}/travel/app.js?v=2#x"></script>`,
      ].join(""),
    );
  });

  test("leaves navigation, fragments, absolute URLs, platform paths, and documents untouched", () => {
    const html = [
      '<a href="schedule.html">S</a><a href="#rsvp">R</a><form action="thanks.html"></form>',
      '<img src="https://cdn.test/a.png"><img src="//cdn.test/b.png"><img src="\\\\cdn.test\\c.png">',
      '<img src="data:image/png;base64,AAAA"><img src="/_platform/me"><img src="/_r/01ARZ3NDEKTSV4RRFFQ69G5FC2/x.png">',
      '<img src="../../_r/01ARZ3NDEKTSV4RRFFQ69G5FC2/y.png"><iframe src="map.html"></iframe><img src="logo.svg"><img src="">',
    ].join("");

    expect(render(html)).toBe(html);
  });

  test("decodes character references before resolving, and escapes what it writes", () => {
    expect(
      render(
        '<img src="100%25.jpg"><img src="100%.jpg"><img src="a%23b.png"><img src="a&amp;b.png"><img src="café.png"><img src="caf&eacute;.png"><img src="q&quot;.png"><img src="x.png?a=1&amp;b=2">',
        "café/index.html",
      ),
    ).toBe(
      [
        `<img src="/_r/${RELEASE}/caf%C3%A9/100%25.jpg">`,
        `<img src="100%.jpg">`,
        `<img src="/_r/${RELEASE}/caf%C3%A9/a%23b.png">`,
        `<img src="/_r/${RELEASE}/caf%C3%A9/a&amp;b.png">`,
        `<img src="/_r/${RELEASE}/caf%C3%A9/caf%C3%A9.png">`,
        `<img src="/_r/${RELEASE}/caf%C3%A9/caf%C3%A9.png">`,
        `<img src="/_r/${RELEASE}/caf%C3%A9/q%22.png">`,
        `<img src="/_r/${RELEASE}/caf%C3%A9/x.png?a=1&amp;b=2">`,
      ].join(""),
    );
  });

  test("an encoded URL cannot reach another release, leave the release, or lose its scheme", () => {
    const other = "01ARZ3NDEKTSV4RRFFQ69G5FC2";
    const untouched = [
      '<img src="https&#58;//cdn.example/x.png"><img src="&#x2F;&#x2F;cdn.example/x.png">',
      `<img src="&#x2F;_r&#x2F;${other}&#x2F;x.png"><img src="&#x2F;_platform&#x2F;me">`,
      '<iframe src="page&#x2E;html"></iframe><img src="&#35;top">',
    ].join("");

    expect(
      render(
        [
          `<img src="&#x2E;&#x2E;&#x2F;${other}&#x2F;x.png">`,
          '<img src="&#x2E;&#x2E;&#x2F;&#x2E;&#x2E;&#x2F;elsewhere.png">',
          '<img srcset="&#x2E;&#x2E;&#x2F;a.png 1x, b&#x2E;png 2x">',
          '<link rel="&#115;tylesheet" href="site&#x2E;css">',
          untouched,
        ].join(""),
        "index.html",
      ),
    ).toBe(
      [
        `<img src="/_r/${RELEASE}/${other}/x.png">`,
        `<img src="/_r/${RELEASE}/elsewhere.png">`,
        `<img srcset="/_r/${RELEASE}/a.png 1x, /_r/${RELEASE}/b.png 2x">`,
        `<link rel="&#115;tylesheet" href="/_r/${RELEASE}/site.css">`,
        untouched,
      ].join(""),
    );
  });

  test("percent-encodes the document's directory when resolving against it", () => {
    expect(
      ["a#b/index.html", "100%/index.html", "q?x/index.html"].map((path) =>
        render('<img src="x.png">', path),
      ),
    ).toEqual([
      `<img src="/_r/${RELEASE}/a%23b/x.png">`,
      `<img src="/_r/${RELEASE}/100%25/x.png">`,
      `<img src="/_r/${RELEASE}/q%3Fx/x.png">`,
    ]);
  });

  test("splits and trims on ASCII whitespace only, as HTML does", () => {
    expect(
      render(
        [
          '<img srcset="x.png&nbsp;,//cdn.example/y.png">',
          '<img srcset="x.png\u00A0,//cdn.example/y.png">',
          '<img srcset="a.png\t1x,\nb.png 2x&nbsp;">',
          '<img src="&nbsp;x.png">',
          '<img src="\u00A0x.png">',
          '<img src=" \tx.png\n">',
          '<link rel="stylesheet&nbsp;x" href="a.css">',
          '<link rel="alternate\ticon" href="b.png">',
        ].join(""),
      ),
    ).toBe(
      [
        `<img srcset="/_r/${RELEASE}/travel/x.png%C2%A0,//cdn.example/y.png">`,
        `<img srcset="/_r/${RELEASE}/travel/x.png%C2%A0,//cdn.example/y.png">`,
        `<img srcset="/_r/${RELEASE}/travel/a.png 1x, /_r/${RELEASE}/travel/b.png 2x&nbsp;">`,
        `<img src="/_r/${RELEASE}/travel/%C2%A0x.png">`,
        `<img src="/_r/${RELEASE}/travel/%C2%A0x.png">`,
        `<img src="/_r/${RELEASE}/travel/x.png">`,
        '<link rel="stylesheet&nbsp;x" href="a.css">',
        `<link rel="alternate\ticon" href="/_r/${RELEASE}/travel/b.png">`,
      ].join(""),
    );
  });
});
