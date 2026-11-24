// Pure browser-job rules shared by the sandbox driver: spec validation, origin and render
// bounds checks, evidence truncation, and failure classification. No browser imports here.

import { BlockList, isIP } from "node:net";

const MAX_RENDER_DIMENSION = 16_384;
const MAX_RENDER_PIXELS = 25_000_000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_SESSION_DOM_BYTES = 2 * 1024 * 1024;
export const MAX_SESSION_TITLE_BYTES = 4_096;
export const MAX_FAILURE_MESSAGE_LENGTH = 512;
/**
 * Chromium launch budget, independent of the spec `timeoutMs`, which starts once the browser is up.
 * Sized for a MicroVM whose image files are still unread: first launches there took up to 121 s.
 */
export const BROWSER_LAUNCH_TIMEOUT_MS = 120_000;

const MAX_CAPTURE_TIMEOUT_MS = 60_000;
const MIN_SESSION_TIMEOUT_MS = 1_000;
const MAX_SESSION_TIMEOUT_MS = 60_000;
const MAX_CAPTURE_URL_LENGTH = 8_192;
const MAX_CAPTURE_SELECTOR_LENGTH = 2_000;
const MAX_SESSION_ACTIONS = 16;
const MAX_SESSION_URL_BYTES = 1_024;
const MAX_SESSION_SELECTOR_BYTES = 256;
const MAX_SESSION_TEXT_BYTES = 512;
const MAX_SESSION_SELECT_VALUES = 4;
const MAX_SESSION_SELECT_VALUE_BYTES = 128;
const MAX_SESSION_WAIT_MS = 10_000;
const MAX_SESSION_SCROLL = 100_000;
const MIN_VIEWPORT_DIMENSION = 100;
const MAX_VIEWPORT_DIMENSION = 4_000;

const BROWSER_JOB_FAILURE_CODES = [
  "origin_not_allowed",
  "popup_not_allowed",
  "dimensions_exceeded",
  "selector_not_found",
  "navigation_failed",
  "timeout",
  "invalid_spec",
  "internal",
  "job_exited",
] as const;
export type BrowserJobFailureCode = (typeof BROWSER_JOB_FAILURE_CODES)[number];

export class BrowserJobFailure extends Error {
  readonly code: BrowserJobFailureCode;

  constructor(
    code: BrowserJobFailureCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "BrowserJobFailure";
    this.code = code;
  }
}

type ScreenshotFormat = "png" | "jpeg" | "webp";
type ViewportName = "mobile" | "tablet" | "desktop" | "wide";
type SessionKey =
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "Backspace"
  | "Delete"
  | "End"
  | "Enter"
  | "Escape"
  | "Home"
  | "PageDown"
  | "PageUp"
  | "Space"
  | "Tab";

export interface ViewportSize {
  readonly height: number;
  readonly width: number;
}

export interface CaptureInput {
  readonly format: ScreenshotFormat;
  readonly fullPage: boolean;
  readonly selector?: string;
  readonly timeoutMs: number;
  readonly url: string;
  readonly viewport: ViewportName;
  readonly viewportSize: ViewportSize;
  readonly waitForSelector?: string;
}

export type SessionAction =
  | { readonly type: "click"; readonly selector: string }
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "press"; readonly key: SessionKey; readonly selector?: string }
  | { readonly type: "scroll"; readonly x?: number; readonly y?: number }
  | { readonly type: "select"; readonly selector: string; readonly values: readonly string[] }
  | {
      readonly type: "type";
      readonly clear?: boolean;
      readonly selector: string;
      readonly text: string;
    }
  | { readonly type: "wait"; readonly milliseconds?: number; readonly selector?: string };

export interface SessionInput {
  readonly actions: readonly SessionAction[];
  readonly timeoutMs: number;
  readonly url: string;
  readonly viewport: ViewportName;
  readonly viewportSize: ViewportSize;
}

/**
 * Where the browser may navigate: the exact `allowedOrigins`, plus, when `anyPublicOrigin` is set,
 * any http(s) origin whose host is public. In that mode every request also goes through the egress
 * proxy, which connects only to public addresses (egress-proxy.ts).
 */
export interface NavigationTargets {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly anyPublicOrigin: boolean;
}

export type BrowserJobSpec =
  | {
      readonly kind: "capture";
      readonly allowedOrigins: readonly string[];
      readonly anyPublicOrigin: boolean;
      readonly input: CaptureInput;
    }
  | {
      readonly kind: "session";
      readonly allowedOrigins: readonly string[];
      readonly anyPublicOrigin: boolean;
      readonly input: SessionInput;
    };

const SCREENSHOT_FORMATS: readonly string[] = ["png", "jpeg", "webp"];
const VIEWPORTS: readonly string[] = ["mobile", "tablet", "desktop", "wide"];
const SESSION_KEYS: readonly string[] = [
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Backspace",
  "Delete",
  "End",
  "Enter",
  "Escape",
  "Home",
  "PageDown",
  "PageUp",
  "Space",
  "Tab",
];

function invalid(message: string): never {
  throw new BrowserJobFailure("invalid_spec", message);
}

function record(value: unknown, field: string, allowed: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(`${field} must be an object.`);
  const unknownKey = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknownKey !== undefined) invalid(`${field} has unknown field ${unknownKey}.`);
  return value as Readonly<Record<string, unknown>>;
}

const utf8 = new TextEncoder();

function text(
  value: unknown,
  field: string,
  limit: { readonly maxBytes?: number; readonly maxLength?: number },
  options: { readonly allowEmpty?: boolean } = {},
) {
  if (typeof value !== "string" || (!options.allowEmpty && !value.trim())) {
    invalid(`${field} must be a ${options.allowEmpty ? "string" : "non-empty string"}.`);
  }
  if (limit.maxLength !== undefined && value.length > limit.maxLength) {
    invalid(`${field} exceeds ${limit.maxLength} characters.`);
  }
  if (limit.maxBytes !== undefined && utf8.encode(value).byteLength > limit.maxBytes) {
    invalid(`${field} exceeds ${limit.maxBytes} UTF-8 bytes.`);
  }
  return value;
}

function integer(value: unknown, field: string, minimum: number, maximum: number) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    invalid(`${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly string[]) {
  if (typeof value !== "string" || !allowed.includes(value)) invalid(`${field} is not supported.`);
  return value as T;
}

function viewportSize(value: unknown): ViewportSize {
  const size = record(value, "input.viewportSize", ["height", "width"]);
  return {
    height: integer(
      size.height,
      "input.viewportSize.height",
      MIN_VIEWPORT_DIMENSION,
      MAX_VIEWPORT_DIMENSION,
    ),
    width: integer(
      size.width,
      "input.viewportSize.width",
      MIN_VIEWPORT_DIMENSION,
      MAX_VIEWPORT_DIMENSION,
    ),
  };
}

function httpUrl(value: string, field: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalid(`${field} must be an absolute URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    invalid(`${field} must use http or https.`);
  return value;
}

function allowedOrigins(value: unknown) {
  if (!Array.isArray(value)) invalid("allowedOrigins must be an array.");
  return value.map((origin, index) => {
    const field = `allowedOrigins[${index}]`;
    const candidate = text(origin, field, {});
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      invalid(`${field} must be an origin.`);
    }
    if (parsed.origin !== candidate) invalid(`${field} must be an origin.`);
    return candidate;
  });
}

function captureInput(value: unknown): CaptureInput {
  const input = record(value, "input", [
    "format",
    "fullPage",
    "selector",
    "timeoutMs",
    "url",
    "viewport",
    "viewportSize",
    "waitForSelector",
  ]);
  if (typeof input.fullPage !== "boolean") invalid("input.fullPage must be a boolean.");
  return {
    format: oneOf<ScreenshotFormat>(input.format, "input.format", SCREENSHOT_FORMATS),
    fullPage: input.fullPage,
    ...(input.selector === undefined
      ? {}
      : {
          selector: text(input.selector, "input.selector", {
            maxLength: MAX_CAPTURE_SELECTOR_LENGTH,
          }),
        }),
    timeoutMs: integer(input.timeoutMs, "input.timeoutMs", 1, MAX_CAPTURE_TIMEOUT_MS),
    url: httpUrl(text(input.url, "input.url", { maxLength: MAX_CAPTURE_URL_LENGTH }), "input.url"),
    viewport: oneOf<ViewportName>(input.viewport, "input.viewport", VIEWPORTS),
    viewportSize: viewportSize(input.viewportSize),
    ...(input.waitForSelector === undefined
      ? {}
      : {
          waitForSelector: text(input.waitForSelector, "input.waitForSelector", {
            maxLength: MAX_CAPTURE_SELECTOR_LENGTH,
          }),
        }),
  };
}

function sessionSelector(value: unknown, field: string) {
  return text(value, field, { maxBytes: MAX_SESSION_SELECTOR_BYTES });
}

function sessionAction(value: unknown, index: number): SessionAction {
  const field = `input.actions[${index}]`;
  const type = value && typeof value === "object" && "type" in value ? value.type : undefined;
  switch (type) {
    case "navigate": {
      const action = record(value, field, ["type", "url"]);
      const url = text(action.url, `${field}.url`, { maxBytes: MAX_SESSION_URL_BYTES });
      return { type, url: httpUrl(url, `${field}.url`) };
    }
    case "click": {
      const action = record(value, field, ["selector", "type"]);
      return { selector: sessionSelector(action.selector, `${field}.selector`), type };
    }
    case "type": {
      const action = record(value, field, ["clear", "selector", "text", "type"]);
      if (action.clear !== undefined && typeof action.clear !== "boolean") {
        invalid(`${field}.clear must be a boolean.`);
      }
      return {
        ...(action.clear === true ? { clear: true } : {}),
        selector: sessionSelector(action.selector, `${field}.selector`),
        text: text(
          action.text,
          `${field}.text`,
          { maxBytes: MAX_SESSION_TEXT_BYTES },
          { allowEmpty: true },
        ),
        type,
      };
    }
    case "select": {
      const action = record(value, field, ["selector", "type", "values"]);
      if (
        !Array.isArray(action.values) ||
        action.values.length === 0 ||
        action.values.length > MAX_SESSION_SELECT_VALUES
      ) {
        invalid(`${field}.values must contain 1 to ${MAX_SESSION_SELECT_VALUES} strings.`);
      }
      const values = action.values.map((entry, valueIndex) =>
        text(
          entry,
          `${field}.values[${valueIndex}]`,
          { maxBytes: MAX_SESSION_SELECT_VALUE_BYTES },
          { allowEmpty: true },
        ),
      );
      return { selector: sessionSelector(action.selector, `${field}.selector`), type, values };
    }
    case "press": {
      const action = record(value, field, ["key", "selector", "type"]);
      return {
        key: oneOf<SessionKey>(action.key, `${field}.key`, SESSION_KEYS),
        ...(action.selector === undefined
          ? {}
          : { selector: sessionSelector(action.selector, `${field}.selector`) }),
        type,
      };
    }
    case "wait": {
      const action = record(value, field, ["milliseconds", "selector", "type"]);
      if (action.milliseconds === undefined && action.selector === undefined) {
        invalid(`${field} requires milliseconds or selector.`);
      }
      return {
        ...(action.milliseconds === undefined
          ? {}
          : {
              milliseconds: integer(
                action.milliseconds,
                `${field}.milliseconds`,
                1,
                MAX_SESSION_WAIT_MS,
              ),
            }),
        ...(action.selector === undefined
          ? {}
          : { selector: sessionSelector(action.selector, `${field}.selector`) }),
        type,
      };
    }
    case "scroll": {
      const action = record(value, field, ["type", "x", "y"]);
      if (action.x === undefined && action.y === undefined) invalid(`${field} requires x or y.`);
      return {
        type,
        ...(action.x === undefined
          ? {}
          : { x: integer(action.x, `${field}.x`, -MAX_SESSION_SCROLL, MAX_SESSION_SCROLL) }),
        ...(action.y === undefined
          ? {}
          : { y: integer(action.y, `${field}.y`, -MAX_SESSION_SCROLL, MAX_SESSION_SCROLL) }),
      };
    }
    default:
      return invalid(`${field}.type is not supported.`);
  }
}

function sessionInput(value: unknown): SessionInput {
  const input = record(value, "input", ["actions", "timeoutMs", "url", "viewport", "viewportSize"]);
  if (
    !Array.isArray(input.actions) ||
    input.actions.length === 0 ||
    input.actions.length > MAX_SESSION_ACTIONS
  ) {
    invalid(`input.actions must contain 1 to ${MAX_SESSION_ACTIONS} actions.`);
  }
  return {
    actions: input.actions.map(sessionAction),
    timeoutMs: integer(
      input.timeoutMs,
      "input.timeoutMs",
      MIN_SESSION_TIMEOUT_MS,
      MAX_SESSION_TIMEOUT_MS,
    ),
    url: httpUrl(text(input.url, "input.url", { maxBytes: MAX_SESSION_URL_BYTES }), "input.url"),
    viewport: oneOf<ViewportName>(input.viewport, "input.viewport", VIEWPORTS),
    viewportSize: viewportSize(input.viewportSize),
  };
}

/** Validates the worker-written `spec.json` against the normalized capture/session shapes. */
export function parseBrowserJobSpec(source: string): BrowserJobSpec {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    invalid("spec.json is not valid JSON.");
  }
  const spec = record(value, "spec", ["allowedOrigins", "anyPublicOrigin", "input", "kind"]);
  const origins = allowedOrigins(spec.allowedOrigins);
  if (spec.anyPublicOrigin !== undefined && typeof spec.anyPublicOrigin !== "boolean") {
    invalid("anyPublicOrigin must be a boolean.");
  }
  const targets = { allowedOrigins: origins, anyPublicOrigin: spec.anyPublicOrigin === true };
  if (spec.kind === "capture")
    return { ...targets, input: captureInput(spec.input), kind: "capture" };
  if (spec.kind === "session")
    return { ...targets, input: sessionInput(spec.input), kind: "session" };
  return invalid("spec.kind must be capture or session.");
}

/**
 * Main-frame navigation rule: never embedded credentials, and either an exact allowed origin or,
 * in any-public mode, an http(s) URL whose host is not local or a non-public IP literal. A public
 * name can still resolve to a private address; the egress proxy refuses that connection.
 */
export function isAllowedNavigation(url: string, targets: NavigationTargets) {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return false;
    if (targets.allowedOrigins.has(parsed.origin)) return true;
    return (
      targets.anyPublicOrigin &&
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      isPublicHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}

const NON_PUBLIC_IPV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC_IPV4.addSubnet(address, prefix, "ipv4");
}
const GLOBAL_UNICAST_IPV6 = new BlockList();
GLOBAL_UNICAST_IPV6.addSubnet("2000::", 3, "ipv6");
const SPECIAL_PURPOSE_IPV6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["2002::", 16],
] as const) {
  SPECIAL_PURPOSE_IPV6.addSubnet(address, prefix, "ipv6");
}

/** Lowercases and strips IPv6 brackets and trailing dots, as URL and proxy hosts arrive. */
export function normalizeHost(host: string) {
  return host
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/\.+$/u, "");
}

/**
 * True for a routable public address: IPv4 outside the private, shared, loopback, link-local,
 * documentation, multicast, and reserved ranges; IPv6 inside 2000::/3 and outside its special
 * ranges (the same ranges as @deployments-ai/net-security, which the guest image does not ship).
 */
export function isPublicAddress(address: string) {
  const normalized = normalizeHost(address);
  if (isIP(normalized) === 4) return !NON_PUBLIC_IPV4.check(normalized, "ipv4");
  if (isIP(normalized) === 6) {
    return (
      GLOBAL_UNICAST_IPV6.check(normalized, "ipv6") &&
      !SPECIAL_PURPOSE_IPV6.check(normalized, "ipv6")
    );
  }
  return false;
}

/** A hostname that may name a public site: not `localhost`, and public when it is an IP literal. */
export function isPublicHostname(hostname: string) {
  const host = normalizeHost(hostname);
  if (!host || host === "localhost" || host.endsWith(".localhost")) return false;
  return isIP(host) === 0 ? true : isPublicAddress(host);
}

/** Guest port of the MicroVM control server (`SANDBOX_CONTROL_PORT`, default 8080). */
export function sandboxControlPort(env: Readonly<Record<string, string | undefined>>) {
  const port = Number(env.SANDBOX_CONTROL_PORT ?? "8080");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new BrowserJobFailure("internal", "SANDBOX_CONTROL_PORT is not a valid port.");
  }
  return port;
}

const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  "http:": 80,
  "https:": 443,
  "ws:": 80,
  "wss:": 443,
};

/**
 * IP literals that can reach this guest itself: loopback/unspecified, and private, shared, or
 * link-local addresses (the control server binds 0.0.0.0, so the guest's own interface address
 * reaches it as well).
 */
function isGuestLocalAddress(host: string) {
  // WHATWG URL parsing canonicalizes every IPv4 spelling (decimal, hex, short forms) to dotted quads.
  const ipv4 = /^(\d+)\.(\d+)\.\d+\.\d+$/u.exec(host);
  if (ipv4) return isGuestLocalIpv4(Number(ipv4[1]), Number(ipv4[2]));
  if (host === "::1" || host === "::") return true;
  if (/^f[cd][0-9a-f]{0,2}:/u.test(host) || /^fe[89ab][0-9a-f]?:/u.test(host)) return true;
  // IPv4-mapped IPv6 is canonicalized to hex groups, e.g. ::ffff:7f00:1 for 127.0.0.1.
  const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/u.exec(host);
  if (mapped) {
    const high = Number.parseInt(mapped[1]!, 16);
    return isGuestLocalIpv4(high >> 8, high & 0xff);
  }
  return false;
}

function isGuestLocalIpv4(first: number, second: number) {
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

/**
 * True when a page request could reach the sandbox's own control server, which runs commands
 * without authentication inside the guest. On the control port this blocks every loopback or
 * unspecified host (127.0.0.0/8, ::1, 0.0.0.0, `localhost`), every private/link-local IP literal,
 * and every other hostname whose origin is not on the job's allowlist, since any name may resolve
 * to loopback. Frames and resource types are irrelevant: each matching request is aborted.
 */
export function targetsSandboxControlServer(
  url: string,
  controlPort: number,
  allowedOrigins: ReadonlySet<string>,
) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const port = parsed.port ? Number(parsed.port) : DEFAULT_PORTS[parsed.protocol];
  if (port !== controlPort) return false;
  const host = parsed.hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/\.$/u, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^[\d.]+$/u.test(host) || host.includes(":")) return isGuestLocalAddress(host);
  return !allowedOrigins.has(parsed.origin);
}

/** Accepts measured page/element bounds (untrusted page-evaluated values included). */
export function assertRenderBounds(bounds: unknown) {
  const height =
    bounds && typeof bounds === "object" && "height" in bounds ? bounds.height : undefined;
  const width =
    bounds && typeof bounds === "object" && "width" in bounds ? bounds.width : undefined;
  if (
    typeof height !== "number" ||
    typeof width !== "number" ||
    !Number.isFinite(height) ||
    !Number.isFinite(width) ||
    height <= 0 ||
    width <= 0 ||
    height > MAX_RENDER_DIMENSION ||
    width > MAX_RENDER_DIMENSION ||
    height * width > MAX_RENDER_PIXELS
  ) {
    throw new BrowserJobFailure(
      "dimensions_exceeded",
      "Screenshot target exceeds the maximum render dimensions.",
    );
  }
}

export function assertImageSize(byteLength: number) {
  if (byteLength === 0)
    throw new BrowserJobFailure("internal", "Browser returned an empty screenshot.");
  if (byteLength > MAX_IMAGE_BYTES) {
    throw new BrowserJobFailure(
      "dimensions_exceeded",
      "Screenshot exceeds the 25 MiB image limit.",
    );
  }
}

/** Truncates to at most `maximumBytes` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(value: string, maximumBytes: number) {
  const encoded = utf8.encode(value);
  if (encoded.byteLength <= maximumBytes) return { text: value, truncated: false };
  let end = maximumBytes;
  while (end > 0 && (encoded[end] ?? 0) >= 0x80 && (encoded[end] ?? 0) < 0xc0) end -= 1;
  return { text: new TextDecoder().decode(encoded.subarray(0, end)), truncated: true };
}

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu;

/** Strips URLs (which may carry tokens) and bounds the length of a model-visible failure message. */
export function publicFailureMessage(message: string) {
  const redacted =
    message.replace(URL_PATTERN, "<url>").replace(/\s+/gu, " ").trim() || "Browser job failed.";
  return redacted.length <= MAX_FAILURE_MESSAGE_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_FAILURE_MESSAGE_LENGTH - 1)}…`;
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : "";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isTimeoutError(error: unknown) {
  return errorName(error) === "TimeoutError";
}

/** Classifies a failed main-frame navigation (initial load or `navigate` action). */
export function navigationFailure(error: unknown, blockedByOriginPolicy: boolean) {
  if (error instanceof BrowserJobFailure) return error;
  const message = errorMessage(error);
  if (blockedByOriginPolicy || message.includes("net::ERR_BLOCKED_BY_CLIENT")) {
    return new BrowserJobFailure(
      "origin_not_allowed",
      "Browser navigation reached an origin that is not allowed.",
      {
        cause: error,
      },
    );
  }
  if (isTimeoutError(error))
    return new BrowserJobFailure("timeout", "Browser job timed out.", { cause: error });
  const netError = /net::ERR_[A-Z0-9_]+/u.exec(message)?.[0];
  if (netError) {
    return new BrowserJobFailure("navigation_failed", `Browser navigation failed: ${netError}.`, {
      cause: error,
    });
  }
  return error;
}

/** Classifies a failed wait for a visible selector. */
export function selectorFailure(error: unknown, selector: string) {
  if (error instanceof BrowserJobFailure) return error;
  const message = errorMessage(error);
  if (isTimeoutError(error)) {
    return new BrowserJobFailure(
      "selector_not_found",
      `Selector ${selector} did not become visible before the timeout.`,
      {
        cause: error,
      },
    );
  }
  if (message.includes("is not a valid selector")) {
    return new BrowserJobFailure(
      "selector_not_found",
      `Selector ${selector} is not a valid selector.`,
      { cause: error },
    );
  }
  return error;
}

/** Final failure status written by `run`: classified failures keep their code, the rest are `internal`. */
export function failureStatus(error: unknown) {
  const failure =
    error instanceof BrowserJobFailure
      ? error
      : isTimeoutError(error)
        ? new BrowserJobFailure("timeout", "Browser job timed out.")
        : new BrowserJobFailure(
            "internal",
            `Browser job failed: ${errorName(error) || "Error"}: ${errorMessage(error)}`,
          );
  return {
    code: failure.code,
    message: publicFailureMessage(failure.message),
    state: "failed" as const,
  };
}
