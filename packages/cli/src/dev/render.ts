import type { ApprovalResponse, ToolCallResponse } from "@deployments-ai/api-contract/runtime";
import pc from "picocolors";
import {
  approvalDestinationLines,
  sanitizeTerminalLines,
  sanitizeTerminalText,
} from "../output.ts";
import type { RunStreamEvent } from "../run-stream.ts";
import type { CliIo } from "../types.ts";

function record(input: unknown): Readonly<Record<string, unknown>> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function text(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  return sanitizeTerminalText(input) || undefined;
}

/** Renders the human-readable progress of preview turns. */
export class DevRenderer {
  readonly #io: CliIo;
  readonly #color: boolean;
  #partialLine = "";
  #modelCallId: string | undefined;
  #streamedAssistantText = false;

  constructor(io: CliIo, color: boolean) {
    this.#io = io;
    this.#color = color;
  }

  /** Whether assistant tokens were streamed since the last `startTurn`. */
  get streamedAssistantText(): boolean {
    return this.#streamedAssistantText;
  }

  startTurn() {
    this.#partialLine = "";
    this.#modelCallId = undefined;
    this.#streamedAssistantText = false;
  }

  event(event: RunStreamEvent) {
    const type = String(event.eventType);
    const payload = record(event.payload);
    if (type === "assistant-token.chunk") {
      if (typeof payload.text !== "string") return;
      // A new model call (fallback attempt or the generation after tools) supersedes the partial
      // text so far; printed lines cannot be retracted, so end the current line and continue.
      const modelCallId = typeof payload.modelCallId === "string" ? payload.modelCallId : undefined;
      if (modelCallId !== this.#modelCallId) {
        this.flush();
        this.#modelCallId = modelCallId;
      }
      this.#streamedAssistantText = true;
      const lines = `${this.#partialLine}${payload.text}`.split(/\r?\n/u);
      this.#partialLine = lines.pop() ?? "";
      for (const line of lines) this.#assistantLines(line);
      return;
    }
    if (type === "assistant-message.finalized") {
      this.flush();
      this.#modelCallId = undefined;
      return;
    }
    if (type.startsWith("tool.")) {
      this.flush();
      this.#tool(type, event, payload);
      return;
    }
    if (type === "approval.requested") {
      this.flush();
      const approvalId = text(event.approvalId);
      this.notice(`Approval requested${approvalId ? ` (${approvalId})` : ""}.`);
    }
  }

  /** Prints any assistant text still waiting for a line break. */
  flush() {
    if (!this.#partialLine) return;
    this.#assistantLines(this.#partialLine);
    this.#partialLine = "";
  }

  assistantMessage(body: string) {
    this.#assistantLines(body);
  }

  approval(approval: ApprovalResponse, toolCall: ToolCallResponse) {
    this.notice(
      `Tool ${sanitizeTerminalText(toolCall.toolName)} (${toolCall.effect}) needs approval ${approval.id}: ${sanitizeTerminalText(toolCall.inputSummary)}`,
    );
    for (const line of approvalDestinationLines(approval)) this.notice(line);
  }

  notice(message: string) {
    this.#io.stdout(this.#color ? pc.dim(message) : message);
  }

  warning(message: string) {
    this.#io.stderr(this.#color ? pc.yellow(message) : message);
  }

  #assistantLines(value: string) {
    for (const line of sanitizeTerminalLines(value)) this.#io.stdout(line);
  }

  #tool(type: string, event: RunStreamEvent, payload: Readonly<Record<string, unknown>>) {
    const metadata = record(payload.metadata);
    const pendingAction = record(payload.pendingAction);
    const name =
      text(payload.toolName) ??
      text(metadata.toolName) ??
      text(pendingAction.toolName) ??
      text(event.toolCallId) ??
      "tool";
    const input = text(metadata.inputSummary) ?? text(pendingAction.inputSummary);
    const status = type.slice("tool.".length);
    const line = `  ${name} ${status}${input ? ` - ${input}` : ""}`;
    this.#io.stdout(this.#color ? pc.cyan(line) : line);
  }
}
