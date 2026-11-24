import type { TeamsOutboundActivity } from "./connector.ts";
import { type TeamsAgentIdentity, teamsMarkdownMessageText } from "./messages.ts";

/** Teams ends a stream that stays open longer than two minutes. */
export const TEAMS_STREAM_MAX_DURATION_MS = 120_000;
/** Teams throttles streaming to one request per second; send the next only after success. */
export const TEAMS_STREAM_MIN_REQUEST_INTERVAL_MS = 1_000;

const MAX_INFORMATIVE_TEXT_CHARACTERS = 1_000;
const MAX_STATUS_PART_CHARACTERS = 256;
const DEFAULT_INFORMATIVE_TEXT = "Working on your request";

export interface TeamsAgentProgress {
  readonly eventType: string;
  readonly level: "debug" | "error" | "info" | "warn";
  readonly message: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TeamsAgentPlanTask {
  readonly details?: string;
  readonly id: string;
  readonly status: "completed" | "failed" | "in_progress" | "pending" | "skipped";
  readonly title: string;
}

export interface TeamsAgentPlanUpdate {
  readonly eventType: "agent.plan.updated" | "agent.task.updated";
  readonly plan: {
    readonly revision?: number;
    readonly tasks?: readonly TeamsAgentPlanTask[];
    readonly title: string;
  };
  readonly task?: TeamsAgentPlanTask;
}

function boundedPart(value: unknown, fallback: string) {
  const text =
    typeof value === "string" && value.trim() ? value.trim().replace(/\s+/gu, " ") : fallback;
  return Array.from(text).slice(0, MAX_STATUS_PART_CHARACTERS).join("");
}

function informativeText(value: string) {
  const text = value.trim() || DEFAULT_INFORMATIVE_TEXT;
  return Array.from(text).slice(0, MAX_INFORMATIVE_TEXT_CHARACTERS).join("");
}

export function teamsStreamInformativeActivity(input: {
  readonly sequence: number;
  readonly streamId?: string;
  readonly text: string;
}): TeamsOutboundActivity {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new RangeError("Teams stream sequence must be a positive integer.");
  }
  const streamId = input.streamId?.trim();
  if (input.sequence > 1 && !streamId) {
    throw new TypeError("Teams stream updates after the first require a streamId.");
  }
  return {
    entities: [
      {
        ...(streamId ? { streamId } : {}),
        streamSequence: input.sequence,
        streamType: "informative",
        type: "streaminfo",
      },
    ],
    text: informativeText(input.text),
    type: "typing",
  };
}

export function teamsStreamFinalActivity(input: {
  readonly streamId: string;
  readonly text: string;
}): TeamsOutboundActivity {
  const streamId = input.streamId.trim();
  if (!streamId) throw new TypeError("Teams stream final message requires a streamId.");
  if (!input.text.trim()) throw new TypeError("Teams stream final message text is required.");
  return {
    entities: [{ streamId, streamType: "final", type: "streaminfo" }],
    text: teamsMarkdownMessageText(input.text),
    textFormat: "markdown",
    type: "message",
  };
}

const PLAN_TASK_STATUS_LABELS: Record<TeamsAgentPlanTask["status"], string> = {
  completed: "Done",
  failed: "Failed",
  in_progress: "Working",
  pending: "Up next",
  skipped: "Done",
};

/** One-line informative status for a plan or task update; `undefined` when nothing changed. */
export function teamsAgentPlanText(update: TeamsAgentPlanUpdate): string | undefined {
  if (update.eventType === "agent.task.updated") {
    if (!update.task) return undefined;
    const title = boundedPart(update.task.title, "Agent task");
    const details = update.task.details ? ` — ${boundedPart(update.task.details, "")}` : "";
    return informativeText(`${PLAN_TASK_STATUS_LABELS[update.task.status]}: ${title}${details}`);
  }
  const title = boundedPart(update.plan.title, DEFAULT_INFORMATIVE_TEXT);
  const tasks = update.plan.tasks ?? [];
  if (!tasks.length) return informativeText(title);
  const finished = tasks.filter(
    (task) => task.status === "completed" || task.status === "skipped",
  ).length;
  const current =
    tasks.find((task) => task.status === "in_progress") ??
    tasks.find((task) => task.status === "pending");
  return informativeText(
    `${title} (${String(finished)}/${String(tasks.length)} done)${
      current
        ? ` — ${PLAN_TASK_STATUS_LABELS[current.status]}: ${boundedPart(current.title, "Agent task")}`
        : ""
    }`,
  );
}

function progressTaskId(event: TeamsAgentProgress) {
  const toolCallId = event.metadata?.toolCallId;
  if (typeof toolCallId === "string" && toolCallId.trim()) return toolCallId.trim();
  if (event.eventType.startsWith("memory.recall.")) return "memory-recall";
  if (event.eventType.startsWith("brain.retrieval.")) return "brain-retrieval";
  if (event.eventType.startsWith("sandbox.")) return "sandbox";
  return undefined;
}

/** One-line informative status for tool, memory, brain, and sandbox progress events. */
export function teamsProgressText(progress: TeamsAgentProgress): string | undefined {
  if (progress.eventType === "tool.policy-decided" || !progressTaskId(progress)) return undefined;
  const completed =
    progress.eventType.endsWith(".completed") || progress.eventType === "sandbox.ready";
  const failed = progress.level === "error" || progress.eventType.endsWith(".failed");
  const toolName = progress.metadata?.toolName;
  const title =
    typeof toolName === "string" && toolName.trim()
      ? `Use ${boundedPart(toolName, "tool")}`
      : boundedPart(progress.message, "Agent task");
  const details = boundedPart(progress.message, "Agent progress updated.");
  const status = failed ? "Failed" : completed ? "Done" : "Working";
  return informativeText(`${status}: ${title}${details === title ? "" : ` — ${details}`}`);
}

/** Final stream (or fallback) message text for a finished run, labelled with the agent identity. */
export function teamsTerminalText(input: {
  readonly body: string;
  readonly error?: string;
  readonly identity?: TeamsAgentIdentity;
  readonly status: "canceled" | "completed" | "failed";
}): string {
  if (input.status === "completed") {
    return teamsMarkdownMessageText(
      input.body.trim() ? input.body : "Agent run completed.",
      input.identity,
    );
  }
  const message =
    input.error?.trim() ||
    (input.status === "canceled" ? "Agent run canceled." : "Agent run failed.");
  const title = input.status === "canceled" ? "Request canceled" : "Request failed";
  return teamsMarkdownMessageText(`_${title}._\n\n${message}`, input.identity);
}
