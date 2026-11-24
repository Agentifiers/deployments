import { describe, expect, test } from "bun:test";
import {
  canSend,
  chatReducer,
  NEW_CHAT,
  nextAttempt,
  parseChatMessage,
  type ChatEvent,
  type ChatSession,
} from "./chat-session.ts";
import { parseToolOutput } from "./run-state.ts";

const THREAD = "01K0000000000000000000000T";
const RUN = "01K0000000000000000000000R";
const attempt = { content: "Hello", idempotencyKey: "key-1" };

const play = (events: readonly ChatEvent[], from: ChatSession = NEW_CHAT) =>
  events.reduce(chatReducer, from);

describe("chatReducer", () => {
  test("a turn goes from submitting through streaming to completed, following the run", () => {
    const phases: string[] = [];
    let session = NEW_CHAT;
    for (const event of [
      { attempt, type: "submit" },
      { threadId: THREAD, type: "thread-opened" },
      { run: { id: RUN, status: "queued" }, threadId: THREAD, type: "submitted" },
      { run: { id: RUN, status: "running" }, type: "run-changed" },
      { run: { id: RUN, status: "waiting-for-approval" }, type: "run-changed" },
      { run: { id: RUN, status: "running" }, type: "run-changed" },
      { run: { id: RUN, status: "waiting-for-tool" }, type: "run-changed" },
      { run: { id: RUN, status: "completed" }, type: "run-changed" },
    ] satisfies ChatEvent[]) {
      session = chatReducer(session, event);
      phases.push(session.phase.kind);
    }
    expect(phases).toEqual([
      "submitting",
      "submitting",
      "streaming",
      "streaming",
      "waiting-for-approval",
      "streaming",
      "waiting-for-tool",
      "completed",
    ]);
    expect(session.threadId).toBe(THREAD);
  });

  test("a failed or canceled run fails the turn with its reason and keeps the thread", () => {
    const submitted = play([
      { attempt, type: "submit" },
      { run: { id: RUN, status: "running" }, threadId: THREAD, type: "submitted" },
    ]);
    expect(
      chatReducer(submitted, {
        run: { error: "model_error: upstream", id: RUN, status: "failed" },
        type: "run-changed",
      }),
    ).toEqual({
      phase: { kind: "failed", reason: "model_error: upstream", runId: RUN },
      threadId: THREAD,
    });
    expect(
      chatReducer(submitted, { run: { id: RUN, status: "canceled" }, type: "run-changed" }).phase,
    ).toEqual({ kind: "failed", reason: "The run was canceled.", runId: RUN });
  });

  test("a failed submission keeps the attempt, so resending the same text repeats its key", () => {
    const failed = play([
      { attempt, type: "submit" },
      { reason: "Service unavailable", type: "submit-failed" },
    ]);
    expect(failed.phase).toEqual({ attempt, kind: "failed", reason: "Service unavailable" });
    expect(nextAttempt(failed.phase, "Hello", () => "key-2")).toBe(attempt);
    expect(nextAttempt(failed.phase, "Hello again", () => "key-2")).toEqual({
      content: "Hello again",
      idempotencyKey: "key-2",
    });
  });

  test("ignores sends while a run is in flight and updates for another run", () => {
    const streaming = play([
      { attempt, type: "submit" },
      { run: { id: RUN, status: "running" }, threadId: THREAD, type: "submitted" },
    ]);
    expect(canSend(streaming.phase)).toBe(false);
    expect(chatReducer(streaming, { attempt, type: "submit" })).toBe(streaming);
    expect(
      chatReducer(streaming, {
        run: { id: "01K0000000000000000000000S", status: "completed" },
        type: "run-changed",
      }),
    ).toBe(streaming);
    const waiting = chatReducer(streaming, {
      run: { id: RUN, status: "waiting-for-tool" },
      type: "run-changed",
    });
    expect(canSend(waiting.phase)).toBe(false);
  });

  test("a completed turn accepts the next message on the same thread; reset starts over", () => {
    const completed = play([
      { attempt, type: "submit" },
      { run: { id: RUN, status: "completed" }, threadId: THREAD, type: "submitted" },
    ]);
    expect(canSend(completed.phase)).toBe(true);
    const second = chatReducer(completed, {
      attempt: { content: "And then?", idempotencyKey: "key-2" },
      type: "submit",
    });
    expect(second.threadId).toBe(THREAD);
    expect(second.phase.kind).toBe("submitting");
    expect(chatReducer(second, { type: "reset" })).toBe(NEW_CHAT);
  });
});

describe("parseChatMessage", () => {
  test("trims the message and refuses empty or oversized text", () => {
    expect(parseChatMessage("  hi \n")).toEqual({ content: "hi", ok: true });
    expect(parseChatMessage("   ")).toEqual({ ok: false });
    expect(parseChatMessage("x".repeat(256 * 1024 + 1))).toEqual({
      message: "A message can be at most 256 KiB.",
      ok: false,
    });
  });
});

describe("parseToolOutput", () => {
  test("a completed result needs a JSON object; a failed one may be empty", () => {
    expect(parseToolOutput('{"temperature": 21}', "completed")).toEqual({
      ok: true,
      value: { temperature: 21 },
    });
    expect(parseToolOutput("", "completed").ok).toBe(false);
    expect(parseToolOutput("", "failed")).toEqual({ ok: true, value: undefined });
    expect(parseToolOutput("[1]", "completed")).toEqual({
      message: "The output must be a JSON object.",
      ok: false,
    });
    expect(parseToolOutput("{", "failed")).toEqual({
      message: "The output must be valid JSON.",
      ok: false,
    });
  });
});
