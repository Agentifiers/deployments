import type { RouteResponse } from "../server/platform-api.ts";

type Run = RouteResponse<"getRunById">;
type Approval = RouteResponse<"getApproval">;

export type RunStatus = Run["status"];
export type RunAction = "cancel" | "retry" | "replay";

export const RUN_ACTIONS: Readonly<Record<RunStatus, readonly RunAction[]>> = {
  canceled: ["replay"],
  completed: ["replay"],
  failed: ["retry", "replay"],
  queued: ["cancel"],
  running: ["cancel"],
  "waiting-for-approval": ["cancel"],
  "waiting-for-tool": ["cancel"],
};

const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["canceled", "completed", "failed"];

export function isRunInFlight(status: RunStatus): boolean {
  return !TERMINAL_RUN_STATUSES.includes(status);
}

export function runErrorText(error: Run["error"]): string | undefined {
  if (error === undefined) return undefined;
  const { code, message } = error;
  if (typeof message !== "string") return JSON.stringify(error);
  return typeof code === "string" ? `${code}: ${message}` : message;
}

/** Where the person can fix a failed run; the page turns it into a link. */
export type RunErrorFix = "agent-configuration";

export interface RunErrorAdvice {
  readonly explanation: string;
  readonly fix?: RunErrorFix;
}

/**
 * Plain advice for run failures people hit, keyed by the error's `code`. The runtime records
 * some failures as a message alone, so `RUN_ERROR_MESSAGES` maps those by exact message.
 */
const RUN_ERROR_CODES: Readonly<Record<string, RunErrorAdvice>> = {};

const RUN_ERROR_MESSAGES: Readonly<Record<string, RunErrorAdvice>> = {
  "Runtime workspace memory mode requires a workspaceId.": {
    explanation:
      "This agent keeps its memory per workspace, so every run needs a workspace. Start the run in a workspace, or change the agent's memory setting.",
    fix: "agent-configuration",
  },
};

export function runErrorAdvice(error: Run["error"]): RunErrorAdvice | undefined {
  if (error === undefined) return undefined;
  const { code, message } = error;
  return (
    (typeof code === "string" ? RUN_ERROR_CODES[code] : undefined) ??
    (typeof message === "string" ? RUN_ERROR_MESSAGES[message] : undefined)
  );
}

export function canResolveApproval(
  approval: Pick<Approval, "executionPurpose" | "status">,
  runStatus: RunStatus,
): boolean {
  return (
    approval.status === "pending" &&
    approval.executionPurpose !== "evaluation" &&
    runStatus === "waiting-for-approval"
  );
}

type ToolCall = RouteResponse<"listRunToolCalls">["toolCalls"][number];

/** A client-executed tool call the run waits on; only the caller that holds it can answer. */
export function awaitsClientResult(
  toolCall: Pick<ToolCall, "executionType" | "status">,
  runStatus: RunStatus,
): boolean {
  return (
    toolCall.executionType === "client" &&
    toolCall.status === "running" &&
    runStatus === "waiting-for-tool"
  );
}

export type ParsedToolOutput =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> | undefined }
  | { readonly ok: false; readonly message: string };

/** A completed client tool call needs a JSON object as its output; a failed one may omit it. */
export function parseToolOutput(text: string, outcome: "completed" | "failed"): ParsedToolOutput {
  if (text.trim() === "") {
    return outcome === "failed"
      ? { ok: true, value: undefined }
      : { message: "A completed tool call needs a JSON object as its output.", ok: false };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { message: "The output must be valid JSON.", ok: false };
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ok: true, value: value as Readonly<Record<string, unknown>> }
    : { message: "The output must be a JSON object.", ok: false };
}
