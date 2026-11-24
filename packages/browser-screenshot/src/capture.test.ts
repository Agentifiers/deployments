import { describe, expect, test } from "bun:test";
import type { Ulid } from "@deployments-ai/db";
import {
  makeBrowserScreenshotToolResult,
  normalizeBrowserScreenshotInput,
  type BrowserScreenshotContentType,
  type BrowserScreenshotInput,
  type NormalizedBrowserScreenshotInput,
} from "./index.ts";

const TOOL_CALL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as Ulid;
const CAPTURED_AT = "2026-07-21T00:00:00.000Z";
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);
const EMPTY_WEBP_EXTENDED_CONTAINER = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x0c, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58,
  0x00, 0x00, 0x00, 0x00,
]);

function input(overrides: Partial<BrowserScreenshotInput> = {}) {
  return normalizeBrowserScreenshotInput(
    { url: "https://app.deployments.ai/dashboard?token=secret#capture", ...overrides },
    new Set(["https://app.deployments.ai"]),
  );
}

function result(
  bytes: Uint8Array,
  contentType: BrowserScreenshotContentType,
  target: NormalizedBrowserScreenshotInput = input(),
) {
  return makeBrowserScreenshotToolResult({
    bytes,
    capturedAt: CAPTURED_AT,
    contentType,
    input: target,
    screenshotUrl: target.url,
    toolCallId: TOOL_CALL_ID,
  });
}

describe("browser screenshot tool result", () => {
  test("builds a tool-call-bound screenshot artifact without leaking query or fragment", () => {
    const built = result(PNG, "image/png", input({ fullPage: false }));

    expect(built.artifact).toEqual({
      artifactType: "screenshot",
      content: PNG,
      contentType: "image/png",
      fileName: `${TOOL_CALL_ID}-desktop-screenshot.png`,
      label: "desktop screenshot: https://app.deployments.ai/dashboard",
      metadata: {
        capturedAt: CAPTURED_AT,
        captureService: "sandbox-chromium",
        fullPage: false,
        screenshotUrl: "https://app.deployments.ai/dashboard?token=secret#capture",
        source: "browser.capture_screenshot",
        targetUrl: "https://app.deployments.ai/dashboard?token=secret#capture",
        toolCallId: TOOL_CALL_ID,
        viewport: "desktop",
        viewportHeight: 900,
        viewportWidth: 1280,
      },
    });
    expect(built.outputSummary).toBe(
      `Captured desktop screenshot for https://app.deployments.ai/dashboard (image/png, ${PNG.byteLength} bytes).`,
    );
  });

  test("rejects bytes that do not decode as the declared image type", () => {
    expect(() => result(Uint8Array.from([1, 2, 3, 4]), "image/png")).toThrow(
      "Screenshot image does not match image/png.",
    );
    expect(() =>
      result(EMPTY_WEBP_EXTENDED_CONTAINER, "image/webp", input({ format: "webp" })),
    ).toThrow("Screenshot image does not match image/webp.");
    expect(() => result(new Uint8Array(), "image/png")).toThrow("Screenshot image is empty.");
  });

  test("rejects images over 25 MiB", () => {
    const oversized = new Uint8Array(25 * 1024 * 1024 + 1);
    oversized.set(PNG);
    expect(() => result(oversized, "image/png")).toThrow("larger than 25 MiB");
  });

  test("rejects captures that do not match the requested format", () => {
    expect(() => result(PNG, "image/png", input({ format: "webp" }))).toThrow(
      "image/png for requested image/webp",
    );
  });
});
