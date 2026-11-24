import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  BROWSER_SCREENSHOT_ENV_KEYS,
  BrowserScreenshotInputError,
  isPublicBrowserScreenshotTarget,
  MAX_BROWSER_SCREENSHOT_URL_LENGTH,
  normalizeBrowserScreenshotInput,
  readBrowserScreenshotConfigFromEnv,
  requirePublicBrowserScreenshotResolution,
} from "./index.ts";

describe("browser screenshot config and input", () => {
  test("merges and deduplicates allowlist aliases into exact origins", async () => {
    const config = await Effect.runPromise(
      readBrowserScreenshotConfigFromEnv({
        [BROWSER_SCREENSHOT_ENV_KEYS.allowedOrigins[0]]:
          "https://app.deployments.ai, https://admin.deployments.ai/",
        [BROWSER_SCREENSHOT_ENV_KEYS.allowedOrigins[4]]: "https://admin.deployments.ai",
      }),
    );

    expect(config).toEqual({
      allowedOrigins: ["https://app.deployments.ai", "https://admin.deployments.ai"],
      kind: "origins",
    });
  });

  test("normalizes viewport, format, dimensions, and timeout", () => {
    expect(
      normalizeBrowserScreenshotInput({
        format: "jpg",
        timeoutMs: 90_000,
        url: "https://example.com/dashboard",
        viewport: "mobile",
        viewportSize: { height: 20, width: 10_000 },
      }),
    ).toMatchObject({
      format: "jpeg",
      fullPage: true,
      timeoutMs: 60_000,
      url: "https://example.com/dashboard",
      viewport: "mobile",
      viewportSize: { height: 100, width: 4_000 },
    });
    expect(
      normalizeBrowserScreenshotInput({
        timeoutMs: 0.1,
        url: "https://example.com/",
      }).timeoutMs,
    ).toBe(1);
  });

  test("rejects runtime values outside the published input schema", () => {
    for (const [input, field] of [
      [{ fullPage: "false", url: "https://example.com/" }, "fullPage"],
      [{ selector: 42, url: "https://example.com/" }, "selector"],
      [{ url: "https://example.com/", viewportSize: "desktop" }, "viewportSize"],
      [{ url: "https://example.com/", viewportSize: { width: "1280" } }, "viewportSize.width"],
      [{ unexpected: true, url: "https://example.com/" }, "input"],
    ] as const) {
      expect(() => normalizeBrowserScreenshotInput(input as never)).toThrow(
        expect.objectContaining({ field }),
      );
    }
  });

  test("bounds persisted screenshot URLs by characters and normalized UTF-8 bytes", () => {
    expect(() =>
      normalizeBrowserScreenshotInput({
        url: `https://example.com/${"a".repeat(MAX_BROWSER_SCREENSHOT_URL_LENGTH)}`,
      }),
    ).toThrow(expect.objectContaining({ field: "url" }));
    expect(() =>
      normalizeBrowserScreenshotInput({
        url: `https://example.com/${"😀".repeat(2_000)}`,
      }),
    ).toThrow("UTF-8 bytes or fewer");
  });

  test("requires an explicit target origin allowlist unless any public origin is enabled", async () => {
    expect(Effect.runPromise(readBrowserScreenshotConfigFromEnv({}))).rejects.toThrow(
      "At least one browser screenshot target origin is required",
    );
    expect(
      Effect.runPromise(
        readBrowserScreenshotConfigFromEnv({
          [BROWSER_SCREENSHOT_ENV_KEYS.anyPublicOrigin]: "false",
        }),
      ),
    ).rejects.toThrow("At least one browser screenshot target origin is required");
    expect(
      await Effect.runPromise(
        readBrowserScreenshotConfigFromEnv({
          [BROWSER_SCREENSHOT_ENV_KEYS.allowedOrigins[0]]: "https://app.deployments.ai",
          [BROWSER_SCREENSHOT_ENV_KEYS.anyPublicOrigin]: "true",
        }),
      ),
    ).toEqual({ kind: "any-public" });
    expect(
      Effect.runPromise(
        readBrowserScreenshotConfigFromEnv({
          [BROWSER_SCREENSHOT_ENV_KEYS.anyPublicOrigin]: "yes",
        }),
      ),
    ).rejects.toThrow("must be true or false");
  });

  test("requires DNS names to resolve exclusively to public addresses with IPv4", async () => {
    const url = "https://app.deployments.ai/";
    expect(
      requirePublicBrowserScreenshotResolution(url, async () => [
        { address: "93.184.216.34", family: 4 },
      ]),
    ).resolves.toBeUndefined();
    expect(
      requirePublicBrowserScreenshotResolution(url, async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ]),
    ).rejects.toMatchObject({ _tag: "BrowserScreenshotInputError", field: "url" });
    expect(
      requirePublicBrowserScreenshotResolution(url, async () => [
        { address: "2606:4700:4700::1111", family: 6 },
      ]),
    ).rejects.toMatchObject({
      _tag: "BrowserScreenshotInputError",
      message: expect.stringContaining("public IPv4"),
    });
  });

  test("rejects private, local, credentialed, and disallowed targets", () => {
    for (const url of [
      "http://127.0.0.1/admin",
      "http://169.254.169.254/latest/meta-data",
      "https://192.0.2.1/",
      "https://198.51.100.1/",
      "https://203.0.113.1/",
      "http://[::1]/",
      "https://[64:ff9b::a00:1]/",
      "https://[2002:0a00:0001::]/",
      "https://[100::1]/",
      "https://[3fff::1]/",
      "https://[fec0::1]/",
      "https://[2606:2800:220:1:248:1893:25c8:1946]/",
      "https://metadata.google.internal/",
      "https://user:password@example.com/",
    ]) {
      expect(() => normalizeBrowserScreenshotInput({ url })).toThrow(BrowserScreenshotInputError);
    }

    expect(() =>
      normalizeBrowserScreenshotInput(
        { url: "https://other.example.com/" },
        new Set(["https://app.deployments.ai"]),
      ),
    ).toThrow("not allowed");
    expect(isPublicBrowserScreenshotTarget(new URL("https://example.com"))).toBe(true);
    expect(isPublicBrowserScreenshotTarget(new URL("https://192.1.1.1/"))).toBe(true);
    expect(
      isPublicBrowserScreenshotTarget(new URL("https://[2606:2800:220:1:248:1893:25c8:1946]/")),
    ).toBe(false);
  });
});
