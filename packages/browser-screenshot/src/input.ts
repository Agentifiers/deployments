import { BlockList, isIP } from "node:net";
import {
  BROWSER_SCREENSHOT_ENV_KEYS,
  BROWSER_SCREENSHOT_FORMATS,
  BROWSER_SCREENSHOT_VIEWPORT_PRESETS,
  BROWSER_SCREENSHOT_VIEWPORTS,
  DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS,
  MAX_BROWSER_SCREENSHOT_SELECTOR_LENGTH,
  MAX_BROWSER_SCREENSHOT_TIMEOUT_MS,
  MAX_BROWSER_SCREENSHOT_URL_LENGTH,
  BrowserScreenshotConfigError,
  BrowserScreenshotInputError,
  type BrowserScreenshotDnsAddress,
  type BrowserScreenshotDnsLookup,
  type BrowserScreenshotFormat,
  type BrowserScreenshotInput,
  type NormalizedBrowserScreenshotInput,
} from "./types.ts";

function normalizeHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
}

function ipv4Octets(hostname: string): number[] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (
    octets.some(
      (octet, index) =>
        !Number.isFinite(octet) || String(octet) !== parts[index] || octet < 0 || octet > 255,
    )
  ) {
    return undefined;
  }
  return octets;
}

function isPrivateOrReservedIpv4Octets(octets: readonly number[]) {
  const first = octets[0];
  const second = octets[1];
  if (first === undefined || second === undefined) return true;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && (octets[2] === 0 || octets[2] === 2)) ||
    (first === 192 && second === 88 && octets[2] === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && octets[2] === 100) ||
    (first === 203 && second === 0 && octets[2] === 113) ||
    first >= 224
  );
}

const GLOBAL_UNICAST_BROWSER_SCREENSHOT_IPV6_ADDRESSES = new BlockList();
const SPECIAL_PURPOSE_BROWSER_SCREENSHOT_IPV6_ADDRESSES = new BlockList();

GLOBAL_UNICAST_BROWSER_SCREENSHOT_IPV6_ADDRESSES.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["::ffff:0:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  SPECIAL_PURPOSE_BROWSER_SCREENSHOT_IPV6_ADDRESSES.addSubnet(address, prefix, "ipv6");
}

function isPublicBrowserScreenshotIpv6Address(address: string) {
  return (
    GLOBAL_UNICAST_BROWSER_SCREENSHOT_IPV6_ADDRESSES.check(address, "ipv6") &&
    !SPECIAL_PURPOSE_BROWSER_SCREENSHOT_IPV6_ADDRESSES.check(address, "ipv6")
  );
}

export function isPublicBrowserScreenshotTarget(url: URL) {
  const hostname = normalizeHostname(url.hostname);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal"
  ) {
    return false;
  }
  if (isIP(hostname) === 4) return !isPrivateOrReservedIpv4Octets(ipv4Octets(hostname) ?? []);
  if (isIP(hostname) === 6) return false;
  return true;
}

export function isPublicBrowserScreenshotAddress(address: string) {
  const normalized = normalizeHostname(address);
  if (isIP(normalized) === 4) {
    return !isPrivateOrReservedIpv4Octets(ipv4Octets(normalized) ?? []);
  }
  if (isIP(normalized) === 6) return isPublicBrowserScreenshotIpv6Address(normalized);
  return false;
}

export async function requirePublicBrowserScreenshotResolution(
  url: string,
  dnsLookup: BrowserScreenshotDnsLookup,
) {
  const hostname = normalizeHostname(new URL(url).hostname);
  if (isIP(hostname)) return;

  let addresses: readonly BrowserScreenshotDnsAddress[];
  try {
    addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch (cause) {
    throw new BrowserScreenshotInputError({
      code: "navigation_failed",
      field: "url",
      message:
        cause instanceof Error
          ? `Screenshot target DNS resolution failed: ${cause.message}`
          : "Screenshot target DNS resolution failed.",
    });
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicBrowserScreenshotAddress(address))
  ) {
    targetRefused("Screenshot target must resolve exclusively to public addresses");
  }
  if (!addresses.some(({ address }) => isIP(normalizeHostname(address)) === 4)) {
    targetRefused("Screenshot target must resolve to at least one public IPv4 address");
  }
}

export function inputError(field: string, message: string): never {
  throw new BrowserScreenshotInputError({ field, message });
}

function targetRefused(message: string): never {
  throw new BrowserScreenshotInputError({ code: "origin_not_allowed", field: "url", message });
}

/** The only loopback host a sandbox capture may target; `localhost` and other forms are refused. */
export const SANDBOX_LOOPBACK_HOST = "127.0.0.1";

/**
 * Which non-public targets a capture may name. `sandboxLoopback` is set only when the call runs in
 * the thread's persistent sandbox, where a server the agent started is still listening; it permits
 * `http://127.0.0.1:<port>` on any explicit port except the sandbox control port.
 */
export interface BrowserScreenshotTargetPolicy {
  readonly sandboxLoopback?: { readonly controlPort: number } | "requires-thread-persistent";
}

const SANDBOX_LOOPBACK_FORM = `http://${SANDBOX_LOOPBACK_HOST}:<port>/`;

/** Origin of an `http://127.0.0.1:<port>` URL with an explicit port; `undefined` for anything else. */
export function sandboxLoopbackOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" &&
      normalizeHostname(parsed.hostname) === SANDBOX_LOOPBACK_HOST &&
      parsed.port !== ""
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function requireSandboxLoopbackTarget(parsed: URL, controlPort: number) {
  if (parsed.protocol !== "http:") {
    targetRefused(`Sandbox loopback targets must use plain http: ${SANDBOX_LOOPBACK_FORM}`);
  }
  if (!parsed.port) {
    targetRefused(
      `Sandbox loopback targets must name an explicit port other than 80: ${SANDBOX_LOOPBACK_FORM}`,
    );
  }
  if (Number(parsed.port) === controlPort) {
    targetRefused(
      `Port ${controlPort} is the sandbox control port and cannot be captured; serve the site on another port.`,
    );
  }
}

function nonPublicTargetMessage(policy: BrowserScreenshotTargetPolicy) {
  if (policy.sandboxLoopback === "requires-thread-persistent") {
    return `url must target a public host; ${SANDBOX_LOOPBACK_FORM} targets require a thread-persistent sandbox policy`;
  }
  if (policy.sandboxLoopback) {
    return `url must target a public host or ${SANDBOX_LOOPBACK_FORM} (a server running in this thread's sandbox); localhost, other loopback, and private addresses are not allowed`;
  }
  return "url must target a public host";
}

function normalizedTargetUrl(
  value: string,
  allowedOrigins: ReadonlySet<string>,
  policy: BrowserScreenshotTargetPolicy,
) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new BrowserScreenshotInputError({
      field: "url",
      message: cause instanceof Error ? `url must be valid: ${cause.message}` : "url must be valid",
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    inputError("url", "url must use http or https");
  }
  if (parsed.username || parsed.password) inputError("url", "url must not include credentials");
  const loopback = policy.sandboxLoopback;
  if (
    typeof loopback === "object" &&
    normalizeHostname(parsed.hostname) === SANDBOX_LOOPBACK_HOST
  ) {
    requireSandboxLoopbackTarget(parsed, loopback.controlPort);
  } else if (!isPublicBrowserScreenshotTarget(parsed)) {
    targetRefused(nonPublicTargetMessage(policy));
  }
  if (allowedOrigins.size > 0 && !allowedOrigins.has(parsed.origin)) {
    targetRefused(`Target origin ${parsed.origin} is not allowed`);
  }
  const normalized = parsed.toString();
  if (Buffer.byteLength(normalized, "utf8") > MAX_BROWSER_SCREENSHOT_URL_LENGTH) {
    inputError("url", `url must be ${MAX_BROWSER_SCREENSHOT_URL_LENGTH} UTF-8 bytes or fewer`);
  }
  return normalized;
}

export function normalizeOrigins(values: readonly string[] | undefined) {
  const origins = new Set<string>();
  for (const value of values ?? []) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch (cause) {
      throw new BrowserScreenshotConfigError({
        key: BROWSER_SCREENSHOT_ENV_KEYS.allowedOrigins[0],
        message:
          cause instanceof Error
            ? `Allowed screenshot origin must be valid: ${cause.message}`
            : "Allowed screenshot origin must be valid.",
      });
    }
    if (parsed.username || parsed.password) {
      throw new BrowserScreenshotConfigError({
        key: BROWSER_SCREENSHOT_ENV_KEYS.allowedOrigins[0],
        message: "Allowed screenshot origins must not include credentials.",
      });
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new BrowserScreenshotConfigError({
        key: BROWSER_SCREENSHOT_ENV_KEYS.allowedOrigins[0],
        message: "Allowed screenshot origins must use HTTP or HTTPS.",
      });
    }
    origins.add(parsed.origin);
  }
  return origins;
}

function dimension(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    inputError("viewportSize", "viewport dimensions must be positive numbers");
  }
  return Math.max(100, Math.min(4_000, Math.round(value)));
}

function selector(value: string | undefined, field: "selector" | "waitForSelector") {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > MAX_BROWSER_SCREENSHOT_SELECTOR_LENGTH) {
    inputError(
      field,
      `${field} must be ${MAX_BROWSER_SCREENSHOT_SELECTOR_LENGTH} characters or fewer`,
    );
  }
  return normalized;
}

const BROWSER_SCREENSHOT_INPUT_KEYS = new Set([
  "format",
  "fullPage",
  "selector",
  "timeoutMs",
  "url",
  "viewport",
  "viewportSize",
  "waitForSelector",
]);
const BROWSER_SCREENSHOT_VIEWPORT_SIZE_KEYS = new Set(["height", "width"]);

function isInputRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requireBrowserScreenshotInputShape(
  record: unknown,
): asserts record is BrowserScreenshotInput {
  if (!isInputRecord(record)) inputError("input", "Tool input must be an object");
  const unknownInputKey = Object.keys(record).find(
    (key) => !BROWSER_SCREENSHOT_INPUT_KEYS.has(key),
  );
  if (unknownInputKey) inputError("input", `Unknown screenshot input field ${unknownInputKey}`);
  if (typeof record.url !== "string" || !record.url.trim()) {
    inputError("url", "url must be a non-empty string");
  }
  if (record.url.length > MAX_BROWSER_SCREENSHOT_URL_LENGTH) {
    inputError("url", `url must be ${MAX_BROWSER_SCREENSHOT_URL_LENGTH} characters or fewer`);
  }
  if (record.format !== undefined && typeof record.format !== "string") {
    inputError("format", "format must be a string");
  }
  if (record.fullPage !== undefined && typeof record.fullPage !== "boolean") {
    inputError("fullPage", "fullPage must be a boolean");
  }
  if (record.selector !== undefined && typeof record.selector !== "string") {
    inputError("selector", "selector must be a string");
  }
  if (record.waitForSelector !== undefined && typeof record.waitForSelector !== "string") {
    inputError("waitForSelector", "waitForSelector must be a string");
  }
  if (record.timeoutMs !== undefined && typeof record.timeoutMs !== "number") {
    inputError("timeoutMs", "timeoutMs must be a number");
  }
  if (record.viewport !== undefined && typeof record.viewport !== "string") {
    inputError("viewport", "viewport must be a string");
  }
  if (record.viewportSize === undefined) return;
  const viewportSize = record.viewportSize;
  if (!isInputRecord(viewportSize)) inputError("viewportSize", "viewportSize must be an object");
  const unknownViewportKey = Object.keys(viewportSize).find(
    (key) => !BROWSER_SCREENSHOT_VIEWPORT_SIZE_KEYS.has(key),
  );
  if (unknownViewportKey) {
    inputError("viewportSize", `Unknown viewportSize field ${unknownViewportKey}`);
  }
  if (viewportSize.height !== undefined && typeof viewportSize.height !== "number") {
    inputError("viewportSize.height", "viewportSize.height must be a number");
  }
  if (viewportSize.width !== undefined && typeof viewportSize.width !== "number") {
    inputError("viewportSize.width", "viewportSize.width must be a number");
  }
}

/** Validates untrusted screenshot tool input and resolves defaults and the allowed target URL. */
export function normalizeBrowserScreenshotInput(
  input: unknown,
  allowedOrigins: ReadonlySet<string> = new Set(),
  policy: BrowserScreenshotTargetPolicy = {},
): NormalizedBrowserScreenshotInput {
  requireBrowserScreenshotInputShape(input);
  const viewport = input.viewport ?? "desktop";
  if (!BROWSER_SCREENSHOT_VIEWPORTS.includes(viewport)) {
    inputError("viewport", "viewport must be mobile, tablet, desktop, or wide");
  }
  const rawFormat = input.format?.toLowerCase();
  const format = rawFormat === "jpg" ? "jpeg" : (rawFormat ?? "png");
  if (!BROWSER_SCREENSHOT_FORMATS.includes(format as BrowserScreenshotFormat)) {
    inputError("format", "format must be png, jpeg, or webp");
  }
  const rawTimeout = input.timeoutMs ?? DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS;
  if (!Number.isFinite(rawTimeout) || rawTimeout <= 0) {
    inputError("timeoutMs", "timeoutMs must be a positive number");
  }
  const preset = BROWSER_SCREENSHOT_VIEWPORT_PRESETS[viewport];
  const normalizedSelector = selector(input.selector, "selector");
  const normalizedWaitForSelector = selector(input.waitForSelector, "waitForSelector");
  return {
    format: format as BrowserScreenshotFormat,
    fullPage: input.fullPage ?? true,
    ...(normalizedSelector ? { selector: normalizedSelector } : {}),
    timeoutMs: Math.max(1, Math.min(Math.round(rawTimeout), MAX_BROWSER_SCREENSHOT_TIMEOUT_MS)),
    url: normalizedTargetUrl(input.url, allowedOrigins, policy),
    viewport,
    viewportSize: {
      height: dimension(input.viewportSize?.height, preset.height),
      width: dimension(input.viewportSize?.width, preset.width),
    },
    ...(normalizedWaitForSelector ? { waitForSelector: normalizedWaitForSelector } : {}),
  };
}
