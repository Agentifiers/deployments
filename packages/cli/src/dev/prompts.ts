import * as prompts from "@clack/prompts";
import {
  MAX_TOOL_RESULT_OUTPUT_BYTES,
  type ApprovalResponse,
  type ToolCallResponse,
} from "@deployments-ai/api-contract/runtime";
import { CliError, ExitCode } from "../errors.ts";
import { sanitizeTerminalLines, sanitizeTerminalText } from "../output.ts";

/** Maximum `outputSummary` length accepted by the tool-result resolution API. */
const TOOL_OUTPUT_SUMMARY_MAX_CHARACTERS = 1_000;
const EXIT_COMMAND = "/exit";

interface ToolResultAnswer {
  readonly outcome: "completed" | "failed";
  readonly outputSummary: string;
}

interface ClientToolResultAnswer {
  readonly outcome: "completed" | "failed";
  /** Structured JSON object output; optional when the outcome is failed. */
  readonly output?: Readonly<Record<string, unknown>>;
}

/** Decisions a person makes while a preview run waits on them. */
export interface TurnInteraction {
  decideApproval(
    approval: ApprovalResponse,
    toolCall: ToolCallResponse,
  ): Promise<"approved" | "rejected">;
  provideToolResult(toolCall: ToolCallResponse): Promise<ToolResultAnswer>;
  provideClientToolResult(toolCall: ToolCallResponse): Promise<ClientToolResultAnswer>;
}

function canceled(): never {
  throw new CliError("Operation canceled.", ExitCode.canceled);
}

/** Compact JSON for tool output, or an error message when the input cannot be sent. */
function compactToolOutput(input: string | undefined): { json: string } | { error: string } {
  let json: string;
  try {
    json = JSON.stringify(JSON.parse(input ?? ""));
  } catch {
    return { error: "Enter valid JSON." };
  }
  return json.length > TOOL_OUTPUT_SUMMARY_MAX_CHARACTERS
    ? {
        error: `Output must serialize to at most ${TOOL_OUTPUT_SUMMARY_MAX_CHARACTERS} characters.`,
      }
    : { json };
}

/** Parsed JSON object output for a client tool, or an error message when it cannot be sent. */
function clientToolOutput(
  input: string | undefined,
  optional: boolean,
): { output: Record<string, unknown> | undefined } | { error: string } {
  if (optional && !input?.trim()) return { output: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input ?? "");
  } catch {
    return { error: "Enter valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "Output must be a JSON object." };
  }
  const bytes = new TextEncoder().encode(JSON.stringify(parsed)).byteLength;
  return bytes > MAX_TOOL_RESULT_OUTPUT_BYTES
    ? { error: `Output must serialize to at most ${MAX_TOOL_RESULT_OUTPUT_BYTES} UTF-8 bytes.` }
    : { output: parsed as Record<string, unknown> };
}

function selectOutcome() {
  return prompts.select({
    message: "Tool outcome",
    options: [
      { value: "completed" as const, label: "Completed" },
      { value: "failed" as const, label: "Failed" },
    ],
  });
}

export const clackInteraction: TurnInteraction = {
  async decideApproval(_approval, toolCall) {
    const decision = await prompts.select({
      message: `Approve ${sanitizeTerminalText(toolCall.toolName)}?`,
      options: [
        { value: "approved" as const, label: "Approve" },
        { value: "rejected" as const, label: "Reject" },
      ],
    });
    if (prompts.isCancel(decision)) canceled();
    return decision;
  },
  async provideToolResult(toolCall) {
    const output = await prompts.text({
      message: `JSON output for ${sanitizeTerminalText(toolCall.toolName)} (${sanitizeTerminalText(toolCall.inputSummary)})`,
      placeholder: '{"result": "..."}',
      validate: (input) => {
        const compact = compactToolOutput(input);
        return "error" in compact ? compact.error : undefined;
      },
    });
    if (prompts.isCancel(output)) canceled();
    const compact = compactToolOutput(output);
    if ("error" in compact) throw new CliError(compact.error, ExitCode.validation);
    const outcome = await selectOutcome();
    if (prompts.isCancel(outcome)) canceled();
    return { outcome, outputSummary: compact.json };
  },
  async provideClientToolResult(toolCall) {
    prompts.note(
      sanitizeTerminalLines(JSON.stringify(toolCall.input ?? {}, null, 2)).join("\n"),
      `Client tool ${sanitizeTerminalText(toolCall.toolName)}${toolCall.expiresAt ? ` (expires ${sanitizeTerminalText(toolCall.expiresAt)})` : ""}`,
    );
    const outcome = await selectOutcome();
    if (prompts.isCancel(outcome)) canceled();
    const optional = outcome === "failed";
    const text = await prompts.text({
      message: optional ? "JSON output object (optional)" : "JSON output object",
      placeholder: '{"result": "..."}',
      validate: (input) => {
        const parsed = clientToolOutput(input, optional);
        return "error" in parsed ? parsed.error : undefined;
      },
    });
    if (prompts.isCancel(text)) canceled();
    const parsed = clientToolOutput(text, optional);
    if ("error" in parsed) throw new CliError(parsed.error, ExitCode.validation);
    return parsed.output === undefined ? { outcome } : { outcome, output: parsed.output };
  },
};

/** Prompts for the next message; resolves undefined when the person ends the session. */
export async function promptMessage(): Promise<string | undefined> {
  const message = await prompts.text({
    message: "Message",
    placeholder: `${EXIT_COMMAND} to quit`,
    validate: (input) => (input?.trim() ? undefined : "Enter a message."),
  });
  if (prompts.isCancel(message) || message.trim() === EXIT_COMMAND) return undefined;
  return message;
}
