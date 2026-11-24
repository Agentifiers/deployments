import type { RunStatus } from "./run-state.ts";

/** What a chat composer is doing with its current turn. */
export type ChatPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "submitting"; readonly attempt: ChatAttempt }
  | { readonly kind: "streaming"; readonly runId: string }
  | { readonly kind: "waiting-for-approval"; readonly runId: string }
  | { readonly kind: "waiting-for-tool"; readonly runId: string }
  | { readonly kind: "completed"; readonly runId: string }
  | {
      readonly kind: "failed";
      /** Absent when the message never became a run. */
      readonly runId?: string;
      readonly reason: string;
      /** The message that failed to submit, so sending it again reuses its idempotency key. */
      readonly attempt?: ChatAttempt;
    };

export interface ChatAttempt {
  readonly content: string;
  readonly idempotencyKey: string;
}

/** One conversation: its thread once the first turn opens it, and the current turn's phase. */
export interface ChatSession {
  readonly threadId?: string;
  readonly phase: ChatPhase;
}

export interface ChatRun {
  readonly id: string;
  readonly status: RunStatus;
  readonly error?: string | undefined;
}

export type ChatEvent =
  | { readonly type: "submit"; readonly attempt: ChatAttempt }
  | { readonly type: "thread-opened"; readonly threadId: string }
  | { readonly type: "submitted"; readonly threadId: string; readonly run: ChatRun }
  | { readonly type: "submit-failed"; readonly reason: string }
  | { readonly type: "run-changed"; readonly run: ChatRun }
  | { readonly type: "reset" };

export const NEW_CHAT: ChatSession = { phase: { kind: "idle" } };

const MAX_CONTENT_BYTES = 256 * 1024;

function phaseOfRun(run: ChatRun): ChatPhase {
  switch (run.status) {
    case "queued":
    case "running":
      return { kind: "streaming", runId: run.id };
    case "waiting-for-approval":
    case "waiting-for-tool":
    case "completed":
      return { kind: run.status, runId: run.id };
    case "failed":
      return { kind: "failed", reason: run.error ?? "The run failed.", runId: run.id };
    case "canceled":
      return { kind: "failed", reason: "The run was canceled.", runId: run.id };
  }
}

export function chatReducer(session: ChatSession, event: ChatEvent): ChatSession {
  switch (event.type) {
    case "submit":
      return canSend(session.phase)
        ? { ...session, phase: { attempt: event.attempt, kind: "submitting" } }
        : session;
    case "thread-opened":
      return session.phase.kind === "submitting"
        ? { ...session, threadId: event.threadId }
        : session;
    case "submitted":
      return session.phase.kind === "submitting"
        ? { phase: phaseOfRun(event.run), threadId: event.threadId }
        : session;
    case "submit-failed":
      return session.phase.kind === "submitting"
        ? {
            ...session,
            phase: { attempt: session.phase.attempt, kind: "failed", reason: event.reason },
          }
        : session;
    case "run-changed": {
      const { phase } = session;
      if (!("runId" in phase) || phase.runId !== event.run.id) return session;
      const next = phaseOfRun(event.run);
      return next.kind === phase.kind ? session : { ...session, phase: next };
    }
    case "reset":
      return NEW_CHAT;
  }
}

/** The run the session follows, while one is in flight or settled. */
export function currentRunId(phase: ChatPhase): string | undefined {
  return "runId" in phase ? phase.runId : undefined;
}

/** A new message waits until the current run settles; approvals and tool results resume it. */
export function canSend(phase: ChatPhase): boolean {
  return phase.kind === "idle" || phase.kind === "completed" || phase.kind === "failed";
}

/**
 * The next submission's attempt. Resending the message that failed to submit repeats its key,
 * because a failure without a response may have applied it.
 */
export function nextAttempt(phase: ChatPhase, content: string, newKey: () => string): ChatAttempt {
  const previous = phase.kind === "failed" ? phase.attempt : undefined;
  return previous?.content === content ? previous : { content, idempotencyKey: newKey() };
}

export type ParsedMessage =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly message?: string };

export function parseChatMessage(text: string): ParsedMessage {
  const content = text.trim();
  if (content === "") return { ok: false };
  return new TextEncoder().encode(content).byteLength <= MAX_CONTENT_BYTES
    ? { content, ok: true }
    : { message: "A message can be at most 256 KiB.", ok: false };
}
