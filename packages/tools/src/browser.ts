import type { ToolAdapterDefinition } from "./types.ts";

export const BROWSER_SCREENSHOT_TOOL_NAME = "browser.capture_screenshot" as const;
export const BROWSER_SESSION_EXECUTE_TOOL_NAME = "browser.session.execute" as const;
export const MAX_BROWSER_SESSION_ACTIONS = 16;
export const MAX_BROWSER_SESSION_SELECTOR_LENGTH = 256;
export const MAX_BROWSER_SESSION_TEXT_LENGTH = 512;
export const MAX_BROWSER_SESSION_URL_LENGTH = 1_024;
export const MAX_BROWSER_SESSION_SELECT_VALUES = 4;
export const MAX_BROWSER_SESSION_SELECT_VALUE_LENGTH = 128;

const browserActionSchema = {
  oneOf: [
    {
      additionalProperties: false,
      properties: {
        type: { const: "navigate" },
        url: { maxLength: MAX_BROWSER_SESSION_URL_LENGTH, type: "string" },
      },
      required: ["type", "url"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        selector: { maxLength: MAX_BROWSER_SESSION_SELECTOR_LENGTH, type: "string" },
        type: { const: "click" },
      },
      required: ["type", "selector"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        clear: { type: "boolean" },
        selector: { maxLength: MAX_BROWSER_SESSION_SELECTOR_LENGTH, type: "string" },
        text: { maxLength: MAX_BROWSER_SESSION_TEXT_LENGTH, type: "string" },
        type: { const: "type" },
      },
      required: ["type", "selector", "text"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        selector: { maxLength: MAX_BROWSER_SESSION_SELECTOR_LENGTH, type: "string" },
        type: { const: "select" },
        values: {
          items: { maxLength: MAX_BROWSER_SESSION_SELECT_VALUE_LENGTH, type: "string" },
          maxItems: MAX_BROWSER_SESSION_SELECT_VALUES,
          minItems: 1,
          type: "array",
        },
      },
      required: ["type", "selector", "values"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        key: {
          enum: [
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
          ],
          type: "string",
        },
        selector: { maxLength: MAX_BROWSER_SESSION_SELECTOR_LENGTH, type: "string" },
        type: { const: "press" },
      },
      required: ["type", "key"],
      type: "object",
    },
    {
      additionalProperties: false,
      anyOf: [{ required: ["milliseconds"] }, { required: ["selector"] }],
      properties: {
        milliseconds: { maximum: 10_000, minimum: 1, type: "integer" },
        selector: { maxLength: MAX_BROWSER_SESSION_SELECTOR_LENGTH, type: "string" },
        type: { const: "wait" },
      },
      required: ["type"],
      type: "object",
    },
    {
      additionalProperties: false,
      anyOf: [{ required: ["x"] }, { required: ["y"] }],
      properties: {
        type: { const: "scroll" },
        x: { maximum: 100_000, minimum: -100_000, type: "integer" },
        y: { maximum: 100_000, minimum: -100_000, type: "integer" },
      },
      required: ["type"],
      type: "object",
    },
  ],
} as const;

/** Which URLs browser tools open; shared by every tool that takes a target URL. */
const BROWSER_TARGETS =
  "Accepts any public http or https URL, unless the operator limits browser tools to a list of sites. A private, loopback, or link-local target, a site outside that list, or a host whose DNS fails returns an error code instead of a page, and you can try another URL.";

export const browserScreenshotToolDefinition = {
  toolName: BROWSER_SCREENSHOT_TOOL_NAME,
  description: `Capture a screenshot of a web page in a headless browser. ${BROWSER_TARGETS} In thread-persistent sandboxes, also accepts http://127.0.0.1:<port>/ for a server running in this thread's sandbox (not the sandbox control port).`,
  effect: "read",
  requiredScopes: [],
  defaultPolicyAction: "allow",
  status: "active",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      format: { type: "string", enum: ["png", "jpeg", "webp"] },
      fullPage: { type: "boolean" },
      selector: { type: "string" },
      timeoutMs: { type: "number" },
      url: { type: "string", maxLength: 8192 },
      viewport: { type: "string", enum: ["mobile", "tablet", "desktop", "wide"] },
      viewportSize: {
        type: "object",
        additionalProperties: false,
        properties: {
          height: { type: "number" },
          width: { type: "number" },
        },
      },
      waitForSelector: { type: "string" },
    },
    required: ["url"],
  },
  egress: "public",
  execution: { type: "builtin", adapterKey: BROWSER_SCREENSHOT_TOOL_NAME },
} as const satisfies ToolAdapterDefinition;

const approvedBrowserScreenshotInputSchema = {
  ...browserScreenshotToolDefinition.inputSchema,
  properties: {
    ...browserScreenshotToolDefinition.inputSchema.properties,
    sessionPlanId: { type: "string", minLength: 26, maxLength: 26 },
  },
  required: ["sessionPlanId", "url"],
} as const;

export const browserToolAdapterDefinitions: readonly ToolAdapterDefinition[] = [
  browserScreenshotToolDefinition,
  {
    toolName: "browser.session.plan",
    description: `Prepare an approval-gated browser session plan for a target URL. ${BROWSER_TARGETS}`,
    effect: "write",
    requiredScopes: [],
    defaultPolicyAction: "require_approval",
    status: "active",
    inputSchema: browserScreenshotToolDefinition.inputSchema,
    egress: "public",
    execution: { type: "builtin", adapterKey: "browser.session.plan" },
  },
  {
    toolName: "browser.screenshot.capture",
    description: "Capture screenshot evidence from an approved browser session.",
    effect: "read",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    status: "active",
    inputSchema: approvedBrowserScreenshotInputSchema,
    egress: "public",
    execution: { type: "builtin", adapterKey: "browser.screenshot.capture" },
  },
  {
    toolName: "browser.dom_snapshot.capture",
    description: "Capture DOM or page-state evidence from an approved browser session.",
    effect: "read",
    requiredScopes: [],
    defaultPolicyAction: "allow",
    status: "active",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionPlanId: { type: "string", minLength: 26, maxLength: 26 },
        url: { type: "string", maxLength: 8192 },
      },
      required: ["sessionPlanId", "url"],
    },
    egress: "public",
    execution: { type: "builtin", adapterKey: "browser.dom_snapshot.capture" },
  },
  {
    toolName: "browser.session.audit_report",
    description: "Record browser session actions, approvals, and captured evidence.",
    effect: "write",
    requiredScopes: [],
    defaultPolicyAction: "require_approval",
    status: "active",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        actions: { type: "array" },
        evidence: { type: "array" },
        sessionPlanId: { type: "string", minLength: 26, maxLength: 26 },
      },
      required: ["sessionPlanId"],
    },
    // Records the input as a private run artifact; it opens no page.
    egress: "platform",
    execution: { type: "builtin", adapterKey: "browser.session.audit_report" },
  },
  {
    toolName: BROWSER_SESSION_EXECUTE_TOOL_NAME,
    description:
      "Execute a bounded sequence of browser navigation and interaction actions, then capture rendered page evidence.",
    effect: "write",
    requiredScopes: [],
    defaultPolicyAction: "require_approval",
    providerOutboundMutation: true,
    status: "active",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        actions: {
          items: browserActionSchema,
          maxItems: MAX_BROWSER_SESSION_ACTIONS,
          minItems: 1,
          type: "array",
        },
        sessionPlanId: { type: "string", minLength: 26, maxLength: 26 },
        timeoutMs: { maximum: 60_000, minimum: 1_000, type: "integer" },
        url: { type: "string", maxLength: MAX_BROWSER_SESSION_URL_LENGTH },
        viewport: { type: "string", enum: ["mobile", "tablet", "desktop", "wide"] },
        viewportSize: {
          type: "object",
          additionalProperties: false,
          properties: {
            height: { type: "number" },
            width: { type: "number" },
          },
        },
      },
      required: ["actions", "sessionPlanId", "url"],
    },
    egress: "public",
    execution: { type: "builtin", adapterKey: BROWSER_SESSION_EXECUTE_TOOL_NAME },
  },
] as const;
