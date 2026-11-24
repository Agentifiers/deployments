import type { DynamoValue } from "@deployments-ai/db";
import {
  BROWSER_SCREENSHOT_TOOL_NAME,
  BROWSER_SESSION_EXECUTE_TOOL_NAME,
  MAX_BROWSER_SESSION_ACTIONS,
  MAX_BROWSER_SESSION_SELECT_VALUE_LENGTH,
  MAX_BROWSER_SESSION_SELECT_VALUES,
  MAX_BROWSER_SESSION_SELECTOR_LENGTH,
  MAX_BROWSER_SESSION_TEXT_LENGTH,
  MAX_BROWSER_SESSION_URL_LENGTH,
} from "@deployments-ai/tools";
import { Schema } from "effect";

export {
  BROWSER_SCREENSHOT_TOOL_NAME,
  BROWSER_SESSION_EXECUTE_TOOL_NAME,
  MAX_BROWSER_SESSION_ACTIONS,
  MAX_BROWSER_SESSION_SELECT_VALUE_LENGTH,
  MAX_BROWSER_SESSION_SELECT_VALUES,
  MAX_BROWSER_SESSION_SELECTOR_LENGTH,
  MAX_BROWSER_SESSION_TEXT_LENGTH,
  MAX_BROWSER_SESSION_URL_LENGTH,
};

export const BROWSER_SCREENSHOT_ENV_KEYS = {
  /** `true` lets browser tools open any public origin instead of an exact-origin allowlist. */
  anyPublicOrigin: "DEPLOYMENTS_AI_BROWSER_ANY_PUBLIC_ORIGIN",
  allowedOrigins: [
    "DEPLOYMENTS_AI_BROWSER_SCREENSHOT_ALLOWED_ORIGINS",
    "BROWSER_SCREENSHOT_CAPTURE_ALLOWED_ORIGINS",
    "DEPLOYMENTS_AI_WEB_ORIGINS",
    "DEPLOYMENTS_AI_SLACK_WEB_URL",
    "DEPLOYMENTS_AI_ADMIN_URL",
    "DEPLOYMENTS_AI_DOCS_URL",
  ],
} as const;

export const BROWSER_SCREENSHOT_VIEWPORTS = ["mobile", "tablet", "desktop", "wide"] as const;
export type BrowserScreenshotViewport = (typeof BROWSER_SCREENSHOT_VIEWPORTS)[number];

export const BROWSER_SCREENSHOT_FORMATS = ["png", "jpeg", "webp"] as const;
export type BrowserScreenshotFormat = (typeof BROWSER_SCREENSHOT_FORMATS)[number];

export const BROWSER_SCREENSHOT_VIEWPORT_PRESETS = {
  desktop: { height: 900, width: 1280 },
  mobile: { height: 844, width: 390 },
  tablet: { height: 1180, width: 820 },
  wide: { height: 1000, width: 1440 },
} as const satisfies Record<BrowserScreenshotViewport, BrowserScreenshotViewportSize>;

export const DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS = 45_000;
export const MAX_BROWSER_SCREENSHOT_TIMEOUT_MS = 60_000;
export const MAX_BROWSER_SCREENSHOT_RESPONSE_BYTES = 25 * 1024 * 1024;
export const MAX_BROWSER_SCREENSHOT_SELECTOR_LENGTH = 2_000;
export const MAX_BROWSER_SCREENSHOT_URL_LENGTH = 8_192;

export interface BrowserScreenshotViewportSize {
  readonly height: number;
  readonly width: number;
}

export interface BrowserScreenshotInput {
  readonly format?: BrowserScreenshotFormat | "jpg";
  readonly fullPage?: boolean;
  readonly selector?: string;
  readonly timeoutMs?: number;
  readonly url: string;
  readonly viewport?: BrowserScreenshotViewport;
  readonly viewportSize?: Partial<BrowserScreenshotViewportSize>;
  readonly waitForSelector?: string;
}

/** Which targets browser tools may open: an exact-origin allowlist, or any public origin. */
export type BrowserScreenshotConfig =
  | { readonly kind: "origins"; readonly allowedOrigins: readonly string[] }
  | { readonly kind: "any-public" };

export interface NormalizedBrowserScreenshotInput {
  readonly format: BrowserScreenshotFormat;
  readonly fullPage: boolean;
  readonly selector?: string;
  readonly timeoutMs: number;
  readonly url: string;
  readonly viewport: BrowserScreenshotViewport;
  readonly viewportSize: BrowserScreenshotViewportSize;
  readonly waitForSelector?: string;
}

export type BrowserScreenshotContentType = "image/jpeg" | "image/png" | "image/webp";

export interface BrowserScreenshotArtifactDraft {
  readonly artifactType: "screenshot";
  readonly content: Uint8Array;
  readonly contentType: BrowserScreenshotContentType;
  readonly fileName: string;
  readonly label: string;
  readonly metadata: Readonly<Record<string, DynamoValue>>;
}

export interface BrowserScreenshotToolResult {
  readonly artifact: BrowserScreenshotArtifactDraft;
  readonly outputSummary: string;
}

export class BrowserScreenshotConfigError extends Schema.TaggedErrorClass<BrowserScreenshotConfigError>()(
  "BrowserScreenshotConfigError",
  {
    key: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Invalid browser tool input. `code` is set when the input is well formed but names a target the
 * tools refuse to open (a non-public host, an origin off the allowlist, or a host whose DNS fails
 * or resolves to a non-public address), so callers can report it like a browser job failure.
 */
export class BrowserScreenshotInputError extends Schema.TaggedErrorClass<BrowserScreenshotInputError>()(
  "BrowserScreenshotInputError",
  {
    code: Schema.optional(Schema.Literals(["navigation_failed", "origin_not_allowed"])),
    field: Schema.String,
    message: Schema.String,
  },
) {}

/** Rendered screenshot bytes or evidence that fail validation. */
export class BrowserScreenshotCaptureError extends Schema.TaggedErrorClass<BrowserScreenshotCaptureError>()(
  "BrowserScreenshotCaptureError",
  {
    message: Schema.String,
  },
) {}

export interface BrowserScreenshotDnsAddress {
  readonly address: string;
  readonly family: number;
}

export type BrowserScreenshotDnsLookup = (
  hostname: string,
  options: { readonly all: true; readonly verbatim: true },
) => Promise<readonly BrowserScreenshotDnsAddress[]>;
