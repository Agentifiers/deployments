import type { RuntimeToolExecutionResult } from "@deployments-ai/agent-runtime";
import type { SandboxManagerService } from "@deployments-ai/sandbox-hosts";
import {
  COMPUTER_ACTION_TOOL_NAME,
  COMPUTER_ACTIONS,
  COMPUTER_COORDINATE_MAX,
  COMPUTER_KEY_MODIFIERS,
  COMPUTER_SCREENSHOT_TOOL_NAME,
  COMPUTER_SCROLL_DIRECTIONS,
  COMPUTER_SCROLL_MAX_AMOUNT,
  COMPUTER_SETTLE_DEFAULT_MS,
  COMPUTER_SETTLE_MAX_MS,
  COMPUTER_TYPE_MAX_CHARACTERS,
  type ComputerAction,
} from "@deployments-ai/tools";
import { Schema } from "effect";
import { readSandboxFile } from "./browser-sandbox-job.ts";
import { optionalInteger, toolInput } from "./builtin-tool-support.ts";
import { COMPUTER_SCRIPT, ComputerScriptOutput } from "./computer-guest-script.ts";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tools.ts";
import { acquireThreadSandbox, runGuestScript } from "./sandbox-file-runtime-tools.ts";
import type { ThreadSandboxWorkspace } from "./thread-sandbox/contracts.ts";

export interface RuntimeComputerToolOptions {
  readonly manager: SandboxManagerService;
  readonly threadSandbox?: ThreadSandboxWorkspace;
}

type ComputerRequest = Parameters<ExecuteRuntimeBuiltinTool>[0];

/** Outside `/workspace`, so thread snapshots never include captures. */
const SCREENSHOT_DIRECTORY = "/var/tmp/deployments-ai-computer";
/** A 1280x800 desktop PNG is well under 1 MiB; the model takes at most 5 MiB per image. */
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

const decodeOutput = Schema.decodeUnknownSync(ComputerScriptOutput);

function oneOf<const T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new TypeError(`${name} must be one of ${allowed.join(", ")}.`);
}

function point(input: Readonly<Record<string, unknown>>, xName: string, yName: string) {
  const bounds = { maximum: COMPUTER_COORDINATE_MAX, minimum: 0 };
  const x = optionalInteger(input, xName, bounds);
  const y = optionalInteger(input, yName, bounds);
  if (x === undefined || y === undefined)
    throw new TypeError(`${xName} and ${yName} are required.`);
  return { [xName]: x, [yName]: y };
}

function boundedString(input: Readonly<Record<string, unknown>>, name: string, maximum: number) {
  const value = input[name];
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${name} must be a string of 1 to ${maximum} characters.`);
  }
  return value;
}

/** Validates model input into exactly the fields the guest script reads for the action. */
export function computerActionInput(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> & { readonly action: ComputerAction } {
  const action = oneOf(input.action, COMPUTER_ACTIONS, "action");
  switch (action) {
    case "click":
    case "double_click":
    case "right_click":
    case "move":
      return { action, ...point(input, "x", "y") };
    case "drag":
      return { action, ...point(input, "x", "y"), ...point(input, "toX", "toY") };
    case "type":
      return { action, text: boundedString(input, "text", COMPUTER_TYPE_MAX_CHARACTERS) };
    case "key": {
      const modifiers = input.modifiers ?? [];
      if (!Array.isArray(modifiers)) throw new TypeError("modifiers must be an array.");
      return {
        action,
        key: boundedString(input, "key", 32),
        modifiers: [...new Set(modifiers.map((m) => oneOf(m, COMPUTER_KEY_MODIFIERS, "modifier")))],
      };
    }
    case "scroll":
      return {
        action,
        ...point(input, "x", "y"),
        amount:
          optionalInteger(input, "amount", { maximum: COMPUTER_SCROLL_MAX_AMOUNT, minimum: 1 }) ??
          3,
        direction: oneOf(input.direction, COMPUTER_SCROLL_DIRECTIONS, "direction"),
      };
    case "launch": {
      const url = input.url === undefined ? undefined : boundedString(input, "url", 2_048);
      if (url !== undefined && !/^https?:\/\//iu.test(url)) {
        throw new TypeError("url must be an http or https URL.");
      }
      const app = boundedString(input, "app", 200);
      if (!/^[\w.+-]+$/u.test(app))
        throw new TypeError("app must be a program name, such as firefox.");
      return { action, app, ...(url ? { url } : {}) };
    }
  }
}

function describeAction(action: Readonly<Record<string, unknown>>) {
  const at = (x: unknown, y: unknown) => `(${String(x)}, ${String(y)})`;
  switch (action.action) {
    case "type":
      return `typed ${String(action.text).length} characters`;
    case "key":
      return `pressed ${[...(action.modifiers as string[]), action.key].join("+")}`;
    case "launch":
      return `launched ${String(action.app)}`;
    case "drag":
      return `dragged from ${at(action.x, action.y)} to ${at(action.toX, action.toY)}`;
    case "scroll":
      return `scrolled ${String(action.direction)} at ${at(action.x, action.y)}`;
    default:
      return `${String(action.action).replace("_", " ")} at ${at(action.x, action.y)}`;
  }
}

export function createRuntimeComputerBuiltinExecutors(
  options: RuntimeComputerToolOptions,
): Readonly<Record<string, ExecuteRuntimeBuiltinTool>> {
  const run = async (
    request: ComputerRequest,
    action: Readonly<Record<string, unknown>> | undefined,
    settleMs: number,
  ): Promise<RuntimeToolExecutionResult> => {
    if (request.sandboxPolicy?.mode !== "thread-persistent") {
      throw new TypeError(`${request.toolName} requires a thread-persistent sandbox policy.`);
    }
    const sandbox = await acquireThreadSandbox(options.threadSandbox, request, request.toolName);
    const screenshotPath = `${SCREENSHOT_DIRECTORY}/${request.decision.toolCallId}.png`;
    const result = await runGuestScript(options.manager, {
      args: { ...(action ? { action } : {}), screenshotPath, settleMs },
      decode: decodeOutput,
      request,
      sandbox,
      script: COMPUTER_SCRIPT,
      toolName: request.toolName,
    });
    if (result.status === "no_desktop") {
      return {
        output: { error: { code: "no_desktop", message: "The sandbox image has no desktop." } },
        outputSummary: `Tool ${request.toolName} failed: this install's sandbox image has no desktop.`,
        status: "completed",
      };
    }
    let screenshot: Uint8Array;
    try {
      screenshot = await readSandboxFile(
        options.manager,
        sandbox,
        screenshotPath,
        MAX_SCREENSHOT_BYTES,
        request.signal,
      );
    } catch (cause) {
      throw new Error(`${request.toolName} could not read the desktop screenshot.`, { cause });
    }
    const { launchStatus, screenHeight, screenWidth, windows } = result;
    const size = `${screenWidth}x${screenHeight}`;
    const described = action ? describeAction(action) : "";
    const outcome = !action
      ? "Captured the desktop"
      : result.actionError !== undefined
        ? `The ${String(action.action)} action failed (${result.actionError}); captured the desktop`
        : launchStatus === "starting"
          ? `${described[0]!.toUpperCase()}${described.slice(1)}, which is still starting; take a screenshot in a few seconds instead of launching it again`
          : `${described[0]!.toUpperCase()}${described.slice(1)}`;
    return {
      artifacts: [
        {
          content: screenshot,
          contentType: "image/png",
          fileName: `computer-${request.decision.toolCallId}.png`,
          label: `Desktop screenshot (${size})`,
          metadata: {
            capturedAt: new Date().toISOString(),
            kind: "computer-screenshot",
            screenHeight,
            screenWidth,
            source: request.toolName,
            toolCallId: request.decision.toolCallId,
            viewport: size,
          },
          type: "screenshot",
          visibility: "private",
        },
      ],
      output: {
        ...(action ? { action: action.action } : {}),
        ...(launchStatus ? { launchStatus } : {}),
        ...(result.actionError === undefined
          ? {}
          : { error: { code: "action_failed", message: result.actionError } }),
        screenHeight,
        screenWidth,
        windows,
      },
      outputSummary: `${outcome}: ${size} screenshot, ${windows.length} open window${windows.length === 1 ? "" : "s"}.`,
      status: "completed",
    };
  };

  return {
    [COMPUTER_ACTION_TOOL_NAME]: async (request) => {
      const input = toolInput(request.input ?? {});
      const action = computerActionInput(input);
      const settleMs =
        optionalInteger(input, "settleMs", { maximum: COMPUTER_SETTLE_MAX_MS, minimum: 0 }) ??
        COMPUTER_SETTLE_DEFAULT_MS;
      return run(request, action, settleMs);
    },
    [COMPUTER_SCREENSHOT_TOOL_NAME]: async (request) => run(request, undefined, 0),
  };
}
