import { describe, expect, test } from "bun:test";
import { consoleAssetsBucket, staticAssetUploads } from "./console-assets.ts";

describe("console static asset uploads", () => {
  test("marks hashed assets immutable and revalidates everything else", () => {
    const commands = staticAssetUploads(
      ["assets/main-a1b2c3.js", "assets/styles-d4e5f6.css", "favicon.ico", "assets/chunk-0f9e.js"],
      "/tmp/assets",
      "console-assets-123456789012",
    );
    expect(commands).toEqual([
      [
        "aws",
        "s3",
        "cp",
        "/tmp/assets",
        "s3://console-assets-123456789012/",
        "--recursive",
        "--only-show-errors",
        "--exclude",
        "*",
        "--include",
        "assets/*.css",
        "--content-type",
        "text/css; charset=utf-8",
        "--cache-control",
        "public, max-age=31536000, immutable",
      ],
      [
        "aws",
        "s3",
        "cp",
        "/tmp/assets",
        "s3://console-assets-123456789012/",
        "--recursive",
        "--only-show-errors",
        "--exclude",
        "*",
        "--include",
        "*.ico",
        "--exclude",
        "assets/*",
        "--content-type",
        "image/x-icon",
        "--cache-control",
        "public, max-age=300",
      ],
      [
        "aws",
        "s3",
        "cp",
        "/tmp/assets",
        "s3://console-assets-123456789012/",
        "--recursive",
        "--only-show-errors",
        "--exclude",
        "*",
        "--include",
        "assets/*.js",
        "--content-type",
        "text/javascript; charset=utf-8",
        "--cache-control",
        "public, max-age=31536000, immutable",
      ],
    ]);
  });

  test("rejects files without a declared content type", () => {
    expect(() => staticAssetUploads(["assets/data.bin"], "/tmp/assets", "bucket")).toThrow(
      "Static asset assets/data.bin has no declared content type.",
    );
  });

  test("reads the bucket only from a non-empty console output", () => {
    expect(consoleAssetsBucket({ console_assets_bucket: "console-assets-1" })).toBe(
      "console-assets-1",
    );
    expect(consoleAssetsBucket({ console_assets_bucket: null })).toBeUndefined();
    expect(consoleAssetsBucket({})).toBeUndefined();
  });
});
