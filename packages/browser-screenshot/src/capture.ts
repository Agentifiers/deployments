import type { Ulid } from "@deployments-ai/db";
import { assertBrowserScreenshotImage } from "./image.ts";
import {
  BROWSER_SCREENSHOT_TOOL_NAME,
  BrowserScreenshotCaptureError,
  type BrowserScreenshotArtifactDraft,
  type BrowserScreenshotContentType,
  type BrowserScreenshotToolResult,
  type NormalizedBrowserScreenshotInput,
} from "./types.ts";

export function browserScreenshotArtifactFileName(
  input: Pick<NormalizedBrowserScreenshotInput, "format" | "viewport">,
  toolCallId: Ulid,
) {
  return `${toolCallId}-${input.viewport}-screenshot.${input.format === "jpeg" ? "jpg" : input.format}`;
}

/**
 * Validates captured screenshot bytes against the requested format and builds the screenshot
 * artifact. `metadata.toolCallId` makes direct captures eligible for tool-result images.
 */
export function makeBrowserScreenshotToolResult(options: {
  readonly bytes: Uint8Array;
  readonly capturedAt: string;
  readonly contentType: BrowserScreenshotContentType;
  readonly input: NormalizedBrowserScreenshotInput;
  readonly screenshotUrl: string;
  readonly toolCallId: Ulid;
}): BrowserScreenshotToolResult {
  const expectedContentType = `image/${options.input.format}` as const;
  if (options.contentType !== expectedContentType) {
    throw new BrowserScreenshotCaptureError({
      message: `Screenshot capture returned ${options.contentType} for requested ${expectedContentType}.`,
    });
  }
  assertBrowserScreenshotImage(options.bytes, options.contentType);
  const target = new URL(options.input.url);
  target.hash = "";
  target.search = "";
  const publicTarget = target.toString();
  const artifact: BrowserScreenshotArtifactDraft = {
    artifactType: "screenshot",
    content: options.bytes,
    contentType: options.contentType,
    fileName: browserScreenshotArtifactFileName(options.input, options.toolCallId),
    label: `${options.input.viewport} screenshot: ${publicTarget}`,
    metadata: {
      capturedAt: options.capturedAt,
      captureService: "sandbox-chromium",
      fullPage: options.input.fullPage,
      screenshotUrl: options.screenshotUrl,
      source: BROWSER_SCREENSHOT_TOOL_NAME,
      targetUrl: options.input.url,
      toolCallId: options.toolCallId,
      viewport: options.input.viewport,
      viewportHeight: options.input.viewportSize.height,
      viewportWidth: options.input.viewportSize.width,
    },
  };
  return {
    artifact,
    outputSummary: `Captured ${options.input.viewport} screenshot for ${publicTarget} (${artifact.contentType}, ${artifact.content.byteLength} bytes).`,
  };
}
