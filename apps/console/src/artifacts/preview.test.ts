import { describe, expect, test } from "bun:test";
import { PREVIEW_IMAGE_BYTES, previewDecision } from "./preview.ts";

const decide = (contentType: string, byteSize = 1024, status = "available") =>
  previewDecision({ byteSize, contentType, status });

describe("artifact preview decision", () => {
  test.each([
    ["image/png", { kind: "image" }],
    ["image/jpeg", { kind: "image" }],
    ["image/gif", { kind: "image" }],
    ["image/webp", { kind: "image" }],
    ["image/avif", { kind: "image" }],
    ["text/plain", { kind: "text" }],
    ["text/plain; charset=utf-8", { kind: "text" }],
    ["text/csv", { kind: "text" }],
    ["Text/CSV; charset=UTF-8", { kind: "text" }],
    ["text/tab-separated-values", { kind: "text" }],
    ["application/x-ndjson", { kind: "text" }],
    ["application/json", { kind: "text", language: "json" }],
    ["application/ld+json", { kind: "text", language: "json" }],
    ["text/markdown", { kind: "text", language: "markdown" }],
    ["image/svg+xml", { kind: "download", reason: "active" }],
    ["IMAGE/SVG+XML", { kind: "download", reason: "active" }],
    ["text/html", { kind: "download", reason: "active" }],
    ["text/html; charset=utf-8", { kind: "download", reason: "active" }],
    ["application/xhtml+xml", { kind: "download", reason: "active" }],
    ["application/xml", { kind: "download", reason: "active" }],
    ["text/xml", { kind: "download", reason: "active" }],
    ["application/atom+xml", { kind: "download", reason: "active" }],
    ["text/javascript", { kind: "download", reason: "active" }],
    ["application/javascript", { kind: "download", reason: "active" }],
    ["application/pdf", { kind: "download", reason: "active" }],
    ["application/octet-stream", { kind: "download", reason: "unsupported" }],
    ["application/zip", { kind: "download", reason: "unsupported" }],
    ["image/tiff", { kind: "download", reason: "unsupported" }],
    ["audio/mpeg", { kind: "download", reason: "unsupported" }],
    ["video/mp4", { kind: "download", reason: "unsupported" }],
  ] as const)("%s", (contentType, expected) => {
    expect(decide(contentType)).toEqual(expected);
  });

  test("downloads an image too large to preview", () => {
    expect(decide("image/png", PREVIEW_IMAGE_BYTES)).toEqual({ kind: "image" });
    expect(decide("image/png", PREVIEW_IMAGE_BYTES + 1)).toEqual({
      kind: "download",
      reason: "too-large",
    });
  });

  test("previews nothing that has no stored bytes", () => {
    for (const status of ["pending", "failed", "deleted"]) {
      expect(decide("image/png", 1024, status)).toEqual({
        kind: "download",
        reason: "not-available",
      });
    }
  });
});
