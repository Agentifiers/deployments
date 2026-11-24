import { Buffer } from "node:buffer";
import { assertBrowserScreenshotImage } from "./image.ts";
import {
  BROWSER_SCREENSHOT_VIEWPORT_PRESETS,
  DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS,
  MAX_BROWSER_SESSION_ACTIONS,
  MAX_BROWSER_SESSION_SELECT_VALUE_LENGTH,
  MAX_BROWSER_SESSION_SELECT_VALUES,
  MAX_BROWSER_SESSION_SELECTOR_LENGTH,
  MAX_BROWSER_SESSION_TEXT_LENGTH,
  MAX_BROWSER_SESSION_URL_LENGTH,
  MAX_BROWSER_SCREENSHOT_RESPONSE_BYTES,
  MAX_BROWSER_SCREENSHOT_URL_LENGTH,
  BrowserScreenshotInputError,
  type BrowserScreenshotViewport,
  type BrowserScreenshotViewportSize,
} from "./types.ts";
import { normalizeBrowserScreenshotInput } from "./input.ts";

export const MAX_BROWSER_SESSION_DOM_BYTES = 2 * 1024 * 1024;
export const MAX_BROWSER_SESSION_TIMEOUT_MS = 60_000;
export const MAX_BROWSER_SESSION_WAIT_MS = 10_000;
export const MIN_BROWSER_SESSION_TIMEOUT_MS = 1_000;
/** Upper bound of one serialized {@link BrowserSessionExecutionResponse}. */
export const MAX_BROWSER_SESSION_RESPONSE_BYTES =
  Math.ceil((MAX_BROWSER_SCREENSHOT_RESPONSE_BYTES * 4) / 3) +
  MAX_BROWSER_SESSION_DOM_BYTES +
  128 * 1024;
export const MAX_BROWSER_SESSION_TITLE_BYTES = 4096;

export type BrowserSessionKey =
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

export type BrowserSessionAction =
  | { readonly type: "click"; readonly selector: string }
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "press"; readonly key: BrowserSessionKey; readonly selector?: string }
  | { readonly type: "scroll"; readonly x?: number; readonly y?: number }
  | { readonly type: "select"; readonly selector: string; readonly values: readonly string[] }
  | {
      readonly type: "type";
      readonly clear?: boolean;
      readonly selector: string;
      readonly text: string;
    }
  | {
      readonly type: "wait";
      readonly milliseconds?: number;
      readonly selector?: string;
    };

export interface BrowserSessionExecuteInput {
  readonly actions: readonly BrowserSessionAction[];
  readonly timeoutMs?: number;
  readonly url: string;
  readonly viewport?: BrowserScreenshotViewport;
  readonly viewportSize?: Partial<BrowserScreenshotViewportSize>;
}

export interface NormalizedBrowserSessionExecuteInput {
  readonly actions: readonly BrowserSessionAction[];
  readonly timeoutMs: number;
  readonly url: string;
  readonly viewport: BrowserScreenshotViewport;
  readonly viewportSize: BrowserScreenshotViewportSize;
}

export interface BrowserSessionActionResult {
  readonly index: number;
  readonly type: BrowserSessionAction["type"];
  readonly url: string;
}

export interface BrowserSessionExecutionResult {
  readonly actions: readonly BrowserSessionActionResult[];
  readonly capturedAt: string;
  readonly dom: string;
  readonly domTruncated: boolean;
  readonly finalUrl: string;
  readonly screenshot: Uint8Array;
  readonly screenshotContentType: "image/png";
  readonly title: string;
}

export interface BrowserSessionExecutionResponse {
  readonly actions: readonly BrowserSessionActionResult[];
  readonly capturedAt: string;
  readonly dom: string;
  readonly domTruncated: boolean;
  readonly finalUrl: string;
  readonly screenshotBase64: string;
  readonly screenshotContentType: "image/png";
  readonly title: string;
}

const ALLOWED_KEYS = new Set<BrowserSessionKey>([
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
]);

function inputError(field: string, message: string): never {
  throw new BrowserScreenshotInputError({ field, message });
}

function object(value: unknown, field: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    inputError(field, `${field} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function keys(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  field: string,
) {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) inputError(field, `Unknown ${field} field ${unknown}`);
}

function string(
  value: unknown,
  field: string,
  maximum: number,
  options: { readonly allowEmpty?: boolean; readonly trim?: boolean } = {},
) {
  if (typeof value !== "string" || (!options.allowEmpty && !value.trim())) {
    inputError(field, `${field} must be a ${options.allowEmpty ? "string" : "non-empty string"}`);
  }
  const normalized = options.trim === false ? value : value.trim();
  if (Buffer.byteLength(normalized, "utf8") > maximum) {
    inputError(field, `${field} exceeds ${maximum} UTF-8 bytes`);
  }
  return normalized;
}

function integer(value: unknown, field: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    inputError(field, `${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function selector(value: unknown, field: string) {
  return string(value, field, MAX_BROWSER_SESSION_SELECTOR_LENGTH);
}

function normalizedAction(
  raw: unknown,
  index: number,
  allowedOrigins: ReadonlySet<string>,
): BrowserSessionAction {
  const field = `actions[${index}]`;
  const action = object(raw, field);
  switch (action.type) {
    case "navigate": {
      keys(action, ["type", "url"], field);
      const url = normalizeBrowserScreenshotInput(
        { url: string(action.url, `${field}.url`, MAX_BROWSER_SESSION_URL_LENGTH) },
        allowedOrigins,
      ).url;
      return { type: "navigate", url };
    }
    case "click":
      keys(action, ["selector", "type"], field);
      return { selector: selector(action.selector, `${field}.selector`), type: "click" };
    case "type":
      keys(action, ["clear", "selector", "text", "type"], field);
      if (action.clear !== undefined && typeof action.clear !== "boolean") {
        inputError(`${field}.clear`, `${field}.clear must be a boolean`);
      }
      return {
        ...(action.clear === true ? { clear: true } : {}),
        selector: selector(action.selector, `${field}.selector`),
        text: string(action.text, `${field}.text`, MAX_BROWSER_SESSION_TEXT_LENGTH, {
          allowEmpty: true,
          trim: false,
        }),
        type: "type",
      };
    case "select": {
      keys(action, ["selector", "type", "values"], field);
      if (
        !Array.isArray(action.values) ||
        action.values.length === 0 ||
        action.values.length > MAX_BROWSER_SESSION_SELECT_VALUES
      ) {
        inputError(
          `${field}.values`,
          `${field}.values must contain 1 to ${MAX_BROWSER_SESSION_SELECT_VALUES} strings`,
        );
      }
      const values = action.values.map((value, valueIndex) =>
        string(value, `${field}.values[${valueIndex}]`, MAX_BROWSER_SESSION_SELECT_VALUE_LENGTH, {
          allowEmpty: true,
          trim: false,
        }),
      );
      return { selector: selector(action.selector, `${field}.selector`), type: "select", values };
    }
    case "press": {
      keys(action, ["key", "selector", "type"], field);
      if (typeof action.key !== "string" || !ALLOWED_KEYS.has(action.key as BrowserSessionKey)) {
        inputError(`${field}.key`, `${field}.key is not allowed`);
      }
      return {
        key: action.key as BrowserSessionKey,
        ...(action.selector !== undefined
          ? { selector: selector(action.selector, `${field}.selector`) }
          : {}),
        type: "press",
      };
    }
    case "wait": {
      keys(action, ["milliseconds", "selector", "type"], field);
      if (action.milliseconds === undefined && action.selector === undefined) {
        inputError(field, `${field} requires milliseconds or selector`);
      }
      return {
        ...(action.milliseconds !== undefined
          ? {
              milliseconds: integer(
                action.milliseconds,
                `${field}.milliseconds`,
                1,
                MAX_BROWSER_SESSION_WAIT_MS,
              ),
            }
          : {}),
        ...(action.selector !== undefined
          ? { selector: selector(action.selector, `${field}.selector`) }
          : {}),
        type: "wait",
      };
    }
    case "scroll": {
      keys(action, ["type", "x", "y"], field);
      if (action.x === undefined && action.y === undefined) {
        inputError(field, `${field} requires x or y`);
      }
      return {
        type: "scroll",
        ...(action.x !== undefined
          ? { x: integer(action.x, `${field}.x`, -100_000, 100_000) }
          : {}),
        ...(action.y !== undefined
          ? { y: integer(action.y, `${field}.y`, -100_000, 100_000) }
          : {}),
      };
    }
    default:
      inputError(`${field}.type`, `${field}.type is not supported`);
  }
}

/** Validates untrusted `browser.session.execute` input against the allowed origins. */
export function normalizeBrowserSessionExecuteInput(
  value: unknown,
  allowedOrigins: ReadonlySet<string>,
): NormalizedBrowserSessionExecuteInput {
  const input = object(value, "input");
  keys(input, ["actions", "timeoutMs", "url", "viewport", "viewportSize"], "input");
  if (!Array.isArray(input.actions) || input.actions.length === 0) {
    inputError("actions", "actions must contain at least one action");
  }
  if (input.actions.length > MAX_BROWSER_SESSION_ACTIONS) {
    inputError("actions", `actions must contain at most ${MAX_BROWSER_SESSION_ACTIONS} actions`);
  }
  const timeoutMs =
    input.timeoutMs === undefined
      ? DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS
      : integer(
          input.timeoutMs,
          "timeoutMs",
          MIN_BROWSER_SESSION_TIMEOUT_MS,
          MAX_BROWSER_SESSION_TIMEOUT_MS,
        );
  const target = normalizeBrowserScreenshotInput(
    {
      url: string(input.url, "url", MAX_BROWSER_SESSION_URL_LENGTH),
      timeoutMs,
      ...(input.viewport !== undefined
        ? { viewport: input.viewport as BrowserScreenshotViewport }
        : {}),
      ...(input.viewportSize !== undefined
        ? {
            viewportSize: input.viewportSize as Partial<BrowserScreenshotViewportSize>,
          }
        : {}),
    },
    allowedOrigins,
  );
  return {
    actions: input.actions.map((action, index) => normalizedAction(action, index, allowedOrigins)),
    timeoutMs: target.timeoutMs,
    url: target.url,
    viewport: target.viewport,
    viewportSize: target.viewportSize ?? BROWSER_SCREENSHOT_VIEWPORT_PRESETS.desktop,
  };
}

const BROWSER_SESSION_SUMMARY_KEYS = [
  "actions",
  "capturedAt",
  "domTruncated",
  "finalUrl",
  "title",
] as const;

/** Serializes a validated session result for durable storage. */
export function browserSessionExecutionResponse(
  result: BrowserSessionExecutionResult,
): BrowserSessionExecutionResponse {
  return {
    actions: result.actions,
    capturedAt: result.capturedAt,
    dom: result.dom,
    domTruncated: result.domTruncated,
    finalUrl: result.finalUrl,
    screenshotBase64: Buffer.from(result.screenshot).toString("base64"),
    screenshotContentType: result.screenshotContentType,
    title: result.title,
  };
}

function validatedSessionResult(
  summary: Readonly<Record<string, unknown>>,
  evidence: { readonly dom: unknown; readonly screenshot: Uint8Array },
  expected: {
    readonly actions: readonly BrowserSessionAction[];
    readonly allowedOrigins: ReadonlySet<string>;
  },
): BrowserSessionExecutionResult {
  assertBrowserScreenshotImage(evidence.screenshot, "image/png");
  if (!Array.isArray(summary.actions) || summary.actions.length !== expected.actions.length) {
    throw new Error("Browser session actions are invalid.");
  }
  const actions = summary.actions.map((raw, index): BrowserSessionActionResult => {
    const action = object(raw, `actions[${index}]`);
    keys(action, ["index", "type", "url"], `actions[${index}]`);
    const actionIndex = integer(
      action.index,
      `actions[${index}].index`,
      0,
      MAX_BROWSER_SESSION_ACTIONS - 1,
    );
    const expectedAction = expected.actions[index];
    if (!expectedAction || actionIndex !== index || expectedAction.type !== action.type) {
      throw new Error("Browser session action result does not match the request.");
    }
    return {
      index: actionIndex,
      type: expectedAction.type,
      url: string(action.url, `actions[${index}].url`, MAX_BROWSER_SCREENSHOT_URL_LENGTH),
    };
  });
  const capturedAt = string(summary.capturedAt, "capturedAt", 64);
  if (Number.isNaN(Date.parse(capturedAt)) || new Date(capturedAt).toISOString() !== capturedAt) {
    throw new Error("Browser session capturedAt is invalid.");
  }
  if (summary.domTruncated !== true && summary.domTruncated !== false) {
    throw new Error("Browser session domTruncated is invalid.");
  }
  const finalUrl = string(summary.finalUrl, "finalUrl", MAX_BROWSER_SCREENSHOT_URL_LENGTH);
  normalizeBrowserScreenshotInput({ url: finalUrl }, expected.allowedOrigins);
  return {
    actions,
    capturedAt,
    dom: string(evidence.dom, "dom", MAX_BROWSER_SESSION_DOM_BYTES, {
      allowEmpty: true,
      trim: false,
    }),
    domTruncated: summary.domTruncated,
    finalUrl,
    screenshot: evidence.screenshot,
    screenshotContentType: "image/png",
    title: string(summary.title, "title", MAX_BROWSER_SESSION_TITLE_BYTES, {
      allowEmpty: true,
      trim: false,
    }),
  };
}

/**
 * Validates rendered session evidence: the summary (`actions`, `capturedAt`, `domTruncated`,
 * `finalUrl`, `title`) must answer the requested actions in order and end on an allowed origin,
 * the screenshot must be a valid PNG, and the DOM must fit its byte limit.
 */
export function browserSessionExecutionResultFromEvidence(
  summary: unknown,
  evidence: { readonly dom: string; readonly screenshot: Uint8Array },
  expected: {
    readonly actions: readonly BrowserSessionAction[];
    readonly allowedOrigins: ReadonlySet<string>;
  },
): BrowserSessionExecutionResult {
  const record = object(summary, "browser session result");
  keys(record, BROWSER_SESSION_SUMMARY_KEYS, "browser session result");
  return validatedSessionResult(record, evidence, expected);
}

/** Decodes and validates a stored {@link BrowserSessionExecutionResponse}. */
export function decodeBrowserSessionExecutionResult(
  value: unknown,
  expected: {
    readonly actions: readonly BrowserSessionAction[];
    readonly allowedOrigins: ReadonlySet<string>;
  },
): BrowserSessionExecutionResult {
  const result = object(value, "browser session response");
  keys(
    result,
    [...BROWSER_SESSION_SUMMARY_KEYS, "dom", "screenshotBase64", "screenshotContentType"],
    "browser session response",
  );
  if (result.screenshotContentType !== "image/png") {
    throw new Error("Browser session screenshot content type is invalid.");
  }
  const encoded = string(
    result.screenshotBase64,
    "screenshotBase64",
    Math.ceil((MAX_BROWSER_SCREENSHOT_RESPONSE_BYTES * 4) / 3) + 16,
  );
  if (encoded.length % 4 === 1 || !/^[a-z0-9+/]*={0,2}$/iu.test(encoded)) {
    throw new Error("Browser session screenshotBase64 is invalid.");
  }
  return validatedSessionResult(
    result,
    { dom: result.dom, screenshot: new Uint8Array(Buffer.from(encoded, "base64")) },
    expected,
  );
}
