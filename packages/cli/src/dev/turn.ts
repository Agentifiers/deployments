import type { RunResponse, ToolCallResponse } from "@deployments-ai/api-contract/runtime";
import type { RuntimeSdk } from "@agentifiers/deployments-sdk";
import { CliError, ExitCode } from "../errors.ts";
import { sanitizeTerminalText } from "../output.ts";
import {
  readRunStream,
  TERMINAL_RUN_EVENT_TYPES,
  type RunStreamEvent,
  type RunStreamPosition,
} from "../run-stream.ts";
import type { TurnInteraction } from "./prompts.ts";
import type { DevRenderer } from "./render.ts";

type RunStatus = RunResponse["status"];

/** Statuses in which the run makes no progress without the client. */
const SETTLED_RUN_STATUSES: Readonly<Record<RunStatus, boolean>> = {
  canceled: true,
  completed: true,
  failed: true,
  queued: false,
  running: false,
  "waiting-for-approval": true,
  "waiting-for-tool": true,
};

const DEFAULT_RETRY_DELAY_MS = 1_000;

export interface RunTurnOptions {
  readonly runtime: RuntimeSdk;
  readonly threadId: string;
  readonly runId: string;
  readonly renderer: DevRenderer;
  /** Absent when nobody can answer prompts; waiting runs then fail the turn. */
  readonly interaction: TurnInteraction | undefined;
  readonly retryDelayMs?: number;
}

function pausesRun(event: RunStreamEvent): boolean {
  if (event.eventType === "approval.requested") return true;
  const payload = event.payload;
  return (
    event.eventType === "tool.running" &&
    typeof payload === "object" &&
    payload !== null &&
    "pendingAction" in payload
  );
}

async function waitingToolCalls(options: RunTurnOptions): Promise<ToolCallResponse[]> {
  const toolCalls: ToolCallResponse[] = [];
  let cursor: string | undefined;
  do {
    const page = await options.runtime.toolCalls.list(options.runId, cursor ? { cursor } : {});
    toolCalls.push(...page.data.toolCalls);
    cursor = page.data.nextCursor;
  } while (cursor);
  return toolCalls;
}

function interactionFor(options: RunTurnOptions, waitingFor: string): TurnInteraction {
  if (options.interaction) return options.interaction;
  throw new CliError(
    `Run ${options.runId} is waiting for ${waitingFor}; rerun deployments dev in an interactive terminal to respond.`,
    ExitCode.usage,
  );
}

async function resolveApprovals(options: RunTurnOptions): Promise<number> {
  const interaction = interactionFor(options, "approval");
  let resolved = 0;
  for (const toolCall of await waitingToolCalls(options)) {
    if (!toolCall.approvalId || toolCall.status !== "waiting") continue;
    const approval = (await options.runtime.approvals.get(options.runId, toolCall.approvalId)).data;
    if (approval.status !== "pending") continue;
    options.renderer.approval(approval, toolCall);
    const decision = await interaction.decideApproval(approval, toolCall);
    await options.runtime.approvals.resolve(options.runId, approval.id, {
      decision,
      threadId: options.threadId,
    });
    options.renderer.notice(`Approval ${approval.id} ${decision}.`);
    resolved += 1;
  }
  return resolved;
}

async function resolveClientToolResult(
  options: RunTurnOptions,
  interaction: TurnInteraction,
  toolCall: ToolCallResponse,
  now: number,
): Promise<boolean> {
  if (toolCall.expiresAt !== undefined && Date.parse(toolCall.expiresAt) <= now) {
    options.renderer.notice(
      `Client tool call ${toolCall.id} (${sanitizeTerminalText(toolCall.toolName)}) expired at ${sanitizeTerminalText(toolCall.expiresAt)}; the server will time it out.`,
    );
    return false;
  }
  const answer = await interaction.provideClientToolResult(toolCall);
  await options.runtime.toolCalls.resolve(options.runId, toolCall.id, {
    ...(toolCall.externalOperationId ? { externalOperationId: toolCall.externalOperationId } : {}),
    outcome: answer.outcome,
    ...(answer.output !== undefined ? { output: answer.output } : {}),
    threadId: options.threadId,
  });
  options.renderer.notice(`Client tool call ${toolCall.id} resolved as ${answer.outcome}.`);
  return true;
}

/** Resolves the run's running tool calls; exported for focused tests. */
export async function resolveToolResults(
  options: RunTurnOptions,
  now: () => number = Date.now,
): Promise<number> {
  const interaction = interactionFor(options, "a tool result");
  let resolved = 0;
  for (const toolCall of await waitingToolCalls(options)) {
    if (toolCall.status !== "running") continue;
    if (toolCall.executionType === "client") {
      if (await resolveClientToolResult(options, interaction, toolCall, now())) resolved += 1;
      continue;
    }
    if (!toolCall.externalOperationId) {
      throw new CliError(
        `Tool call ${toolCall.id} is waiting without an external operation ID and cannot be resolved.`,
        ExitCode.unexpected,
      );
    }
    const answer = await interaction.provideToolResult(toolCall);
    await options.runtime.toolCalls.resolve(options.runId, toolCall.id, {
      externalOperationId: toolCall.externalOperationId,
      outcome: answer.outcome,
      outputSummary: answer.outputSummary,
      threadId: options.threadId,
    });
    options.renderer.notice(`Tool call ${toolCall.id} resolved as ${answer.outcome}.`);
    resolved += 1;
  }
  return resolved;
}

async function renderAssistantReply(options: RunTurnOptions) {
  const message = (await options.runtime.runs.getMessage(options.threadId, options.runId)).data;
  if (message.body !== undefined) {
    options.renderer.assistantMessage(message.body);
    return;
  }
  options.renderer.notice(`Assistant message ${message.id} has no inline body.`);
}

/** Describes a run that did not complete, or undefined for a completed run. */
export function unsuccessfulRunMessage(run: RunResponse): string | undefined {
  if (run.status === "completed") return undefined;
  const detail = run.error?.message;
  return `Run ${run.id} ${run.status}${typeof detail === "string" && detail.trim() ? `: ${sanitizeTerminalText(detail)}` : "."}`;
}

/**
 * Streams one run of a preview turn until it ends, answering approvals and tool results that
 * pause it along the way, and returns the terminal run.
 */
export async function runTurn(options: RunTurnOptions): Promise<RunResponse> {
  const { runtime, threadId, runId, renderer } = options;
  renderer.startTurn();
  let position: RunStreamPosition | undefined;
  while (true) {
    let stopped = false;
    position = await readRunStream({
      runtime,
      threadId,
      runId,
      follow: true,
      ...(position ? { position } : {}),
      onEvent: (event) => {
        renderer.event(event);
        stopped ||= TERMINAL_RUN_EVENT_TYPES[String(event.eventType)] === true || pausesRun(event);
        return stopped;
      },
      onIdle: async () => {
        stopped = SETTLED_RUN_STATUSES[(await runtime.runs.get(threadId, runId)).data.status];
        return stopped;
      },
    });
    renderer.flush();
    const run = (await runtime.runs.get(threadId, runId)).data;
    if (run.status === "completed" || run.status === "failed" || run.status === "canceled") {
      if (run.status === "completed" && !renderer.streamedAssistantText) {
        await renderAssistantReply(options);
      }
      return run;
    }
    const progressed =
      run.status === "waiting-for-approval"
        ? (await resolveApprovals(options)) > 0
        : run.status === "waiting-for-tool"
          ? (await resolveToolResults(options)) > 0
          : stopped;
    if (!progressed) await Bun.sleep(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  }
}
