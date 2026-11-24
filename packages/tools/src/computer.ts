import type { ToolAdapterDefinition } from "./types.ts";

export const COMPUTER_SCREENSHOT_TOOL_NAME = "computer.screenshot" as const;
export const COMPUTER_ACTION_TOOL_NAME = "computer.action" as const;
export const COMPUTER_TOOL_NAMES = [
  COMPUTER_SCREENSHOT_TOOL_NAME,
  COMPUTER_ACTION_TOOL_NAME,
] as const;

export const COMPUTER_ACTIONS = [
  "click",
  "double_click",
  "right_click",
  "move",
  "drag",
  "type",
  "key",
  "scroll",
  "launch",
] as const;
export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];

export const COMPUTER_KEY_MODIFIERS = ["ctrl", "shift", "alt", "super"] as const;
export const COMPUTER_SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;
export const COMPUTER_TYPE_MAX_CHARACTERS = 4_000;
export const COMPUTER_SETTLE_DEFAULT_MS = 1_000;
export const COMPUTER_SETTLE_MAX_MS = 5_000;
export const COMPUTER_SCROLL_MAX_AMOUNT = 50;
export const COMPUTER_COORDINATE_MAX = 16_384;

const coordinate = (description: string) =>
  ({
    description,
    maximum: COMPUTER_COORDINATE_MAX,
    minimum: 0,
    type: "integer",
  }) as const;

export const computerScreenshotToolDefinition = {
  defaultPolicyAction: "allow",
  egress: "public",
  description:
    "Capture the sandbox desktop as a screenshot and list its open windows. Coordinates for computer.action are pixels of this screenshot, with the origin at the top left.",
  effect: "read",
  execution: { adapterKey: COMPUTER_SCREENSHOT_TOOL_NAME, type: "builtin" },
  inputSchema: { additionalProperties: false, properties: {}, type: "object" },
  requiredScopes: [],
  status: "active",
  toolName: COMPUTER_SCREENSHOT_TOOL_NAME,
} as const satisfies ToolAdapterDefinition;

export const computerActionToolDefinition = {
  defaultPolicyAction: "allow",
  egress: "public",
  description:
    "Act on the sandbox desktop with the mouse or keyboard, or launch an app, then wait settleMs and return a new screenshot. x and y are pixels of the latest computer screenshot. type and key go to the focused window; click a field before typing into it.",
  effect: "execute",
  execution: { adapterKey: COMPUTER_ACTION_TOOL_NAME, type: "builtin" },
  inputSchema: {
    additionalProperties: false,
    properties: {
      action: {
        description:
          "click, double_click, right_click, and move need x and y. drag needs x, y, toX, and toY. type needs text. key needs key. scroll needs x, y, and direction. launch needs app.",
        enum: [...COMPUTER_ACTIONS],
        type: "string",
      },
      amount: {
        description: "Scroll steps; defaults to 3.",
        maximum: COMPUTER_SCROLL_MAX_AMOUNT,
        minimum: 1,
        type: "integer",
      },
      app: {
        description: "App to launch, such as firefox or xterm.",
        maxLength: 200,
        minLength: 1,
        type: "string",
      },
      direction: { enum: [...COMPUTER_SCROLL_DIRECTIONS], type: "string" },
      key: {
        description:
          "Key to press: enter, tab, escape, space, backspace, delete, home, end, pageup, pagedown, up, down, left, right, f1 to f12, or one character.",
        maxLength: 32,
        minLength: 1,
        type: "string",
      },
      modifiers: {
        description: "Modifier keys held while key is pressed.",
        items: { enum: [...COMPUTER_KEY_MODIFIERS], type: "string" },
        maxItems: COMPUTER_KEY_MODIFIERS.length,
        type: "array",
      },
      settleMs: {
        description: "Milliseconds to wait before the screenshot; defaults to 1000.",
        maximum: COMPUTER_SETTLE_MAX_MS,
        minimum: 0,
        type: "integer",
      },
      text: {
        description: "Text to type into the focused window.",
        maxLength: COMPUTER_TYPE_MAX_CHARACTERS,
        minLength: 1,
        type: "string",
      },
      toX: coordinate("Drag end X."),
      toY: coordinate("Drag end Y."),
      url: {
        description: "URL the launched app opens.",
        maxLength: 2_048,
        type: "string",
      },
      x: coordinate("Screenshot pixel X."),
      y: coordinate("Screenshot pixel Y."),
    },
    required: ["action"],
    type: "object",
  },
  providerOutboundMutation: true,
  requiredScopes: [],
  status: "active",
  toolName: COMPUTER_ACTION_TOOL_NAME,
} as const satisfies ToolAdapterDefinition;

export const computerToolAdapterDefinitions: readonly ToolAdapterDefinition[] = [
  computerScreenshotToolDefinition,
  computerActionToolDefinition,
];
