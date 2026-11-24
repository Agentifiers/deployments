import { describe, expect, test } from "bun:test";
import {
  applyStreamFrame,
  createSseFrameReader,
  EMPTY_LIVE_THREAD,
  foldStreamEvents,
  grantNeedsRenewal,
  streamReadUrl,
  type StreamCursorState,
  type StreamEventLike,
} from "./thread-stream.ts";

const STREAM_URL = "https://streams.example.com/v1/threads/01K6Z4B0000000000000000000/stream";

function chunk(eventId: string, sequence: number, text: string, modelCallId = "call-1") {
  return {
    eventId,
    eventType: "assistant-token.chunk",
    messageId: "msg-1",
    payload: { modelCallId, sequence, text },
    runId: "run-1",
  } satisfies StreamEventLike;
}

describe("streamReadUrl", () => {
  test("keeps the stream path and reads from the position over SSE", () => {
    expect(streamReadUrl(STREAM_URL, { offset: "0000_0042" })).toBe(
      "https://streams.example.com/v1/threads/01K6Z4B0000000000000000000/stream?offset=0000_0042&live=sse",
    );
    expect(streamReadUrl(STREAM_URL, { cursor: "c-7", offset: "0000_0042" })).toBe(
      "https://streams.example.com/v1/threads/01K6Z4B0000000000000000000/stream?offset=0000_0042&cursor=c-7&live=sse",
    );
  });
});

describe("grantNeedsRenewal", () => {
  const grant = {
    accessToken: "stream-token",
    expiresInMs: 300_000,
    offset: "0000_0000",
    streamUrl: STREAM_URL,
  };

  test("renews a token with under a minute of its lifetime left since it arrived", () => {
    expect(grantNeedsRenewal(grant, 239_000)).toBe(false);
    expect(grantNeedsRenewal(grant, 241_000)).toBe(true);
  });
});

describe("createSseFrameReader", () => {
  test("returns a frame once its blank line arrives, across chunk boundaries", () => {
    const reader = createSseFrameReader();
    expect(reader.push("event: da")).toEqual([]);
    expect(reader.push('ta\ndata: [{"a"')).toEqual([]);
    expect(reader.push(":1}]\n\nevent: control\ndata: {}\n")).toEqual([
      { data: '[{"a":1}]', event: "data" },
    ]);
    expect(reader.push("\n")).toEqual([{ data: "{}", event: "control" }]);
  });

  test("reads CRLF line breaks, including one split between chunks", () => {
    const reader = createSseFrameReader();
    expect(reader.push("event: control\r")).toEqual([]);
    expect(reader.push('\ndata: {"streamNextOffset":"1"}\r\n\r\n')).toEqual([
      { data: '{"streamNextOffset":"1"}', event: "control" },
    ]);
  });

  test("joins multi-line data, skips comments, and defaults the event to message", () => {
    const reader = createSseFrameReader();
    expect(reader.push(": keep-alive\n\nevent: data\ndata: [\ndata:1]\n\ndata: plain\n\n")).toEqual(
      [
        { data: "[\n1]", event: "data" },
        { data: "plain", event: "message" },
      ],
    );
  });
});

describe("applyStreamFrame", () => {
  const start: StreamCursorState = {
    closed: false,
    pending: [],
    position: { offset: "0000_0010" },
  };
  const event = { eventId: "evt-1", eventType: "run.started", payload: {}, runId: "run-1" };

  test("holds data until the next control frame commits it and moves the position", () => {
    const held = applyStreamFrame(start, { data: JSON.stringify([event]), event: "data" });
    expect(held).toEqual({
      committed: undefined,
      state: { closed: false, pending: [event], position: { offset: "0000_0010" } },
    });
    const control = '{"streamNextOffset":"0000_0020","streamCursor":"c-1","upToDate":true}';
    expect(applyStreamFrame(held.state, { data: control, event: "control" })).toEqual({
      committed: [event],
      state: { closed: false, pending: [], position: { cursor: "c-1", offset: "0000_0020" } },
    });
  });

  test("a control frame reporting streamClosed closes the cursor", () => {
    const control = '{"streamNextOffset":"0000_0030","streamClosed":true}';
    expect(applyStreamFrame(start, { data: control, event: "control" }).state).toEqual({
      closed: true,
      pending: [],
      position: { offset: "0000_0030" },
    });
  });

  test("drops malformed entries", () => {
    const data = JSON.stringify([{ eventType: "run.started" }, "text", event]);
    const held = applyStreamFrame(start, { data, event: "data" });
    expect(held.state.pending).toEqual([event]);
    expect(applyStreamFrame(held.state, { data: "not json", event: "data" }).state).toEqual(
      held.state,
    );
  });

  test("a control frame without an offset commits nothing and keeps the position", () => {
    const held = applyStreamFrame(start, { data: JSON.stringify([event]), event: "data" }).state;
    expect(applyStreamFrame(held, { data: '{"upToDate":true}', event: "control" })).toEqual({
      committed: undefined,
      state: { closed: false, pending: [event], position: { offset: "0000_0010" } },
    });
  });
});

describe("foldStreamEvents", () => {
  test("appends chunks in sequence order", () => {
    const { refresh, state } = foldStreamEvents(EMPTY_LIVE_THREAD, [
      chunk("evt-1", 0, "Hel"),
      chunk("evt-2", 1, "lo"),
    ]);
    expect(refresh).toBe(false);
    expect([...state.drafts.values()]).toEqual([
      { messageId: "msg-1", modelCallId: "call-1", nextSequence: 2, runId: "run-1", text: "Hello" },
    ]);
  });

  test("ignores a chunk that skips ahead and a repeated sequence", () => {
    const { state } = foldStreamEvents(EMPTY_LIVE_THREAD, [
      chunk("evt-1", 0, "a"),
      chunk("evt-2", 2, "c"),
      chunk("evt-3", 0, "a"),
      chunk("evt-4", 1, "b"),
    ]);
    expect(state.drafts.get("msg-1")?.text).toBe("ab");
    expect(state.drafts.get("msg-1")?.nextSequence).toBe(2);
  });

  test("a new modelCallId replaces the partial text", () => {
    const { state } = foldStreamEvents(EMPTY_LIVE_THREAD, [
      chunk("evt-1", 0, "first try"),
      chunk("evt-2", 0, "second", "call-2"),
    ]);
    expect([...state.drafts.values()]).toEqual([
      {
        messageId: "msg-1",
        modelCallId: "call-2",
        nextSequence: 1,
        runId: "run-1",
        text: "second",
      },
    ]);
  });

  test("joining a model call under way marks the missing start", () => {
    const { state } = foldStreamEvents(EMPTY_LIVE_THREAD, [chunk("evt-9", 3, "tail")]);
    expect(state.drafts.get("msg-1")?.text).toBe("…tail");
    expect(state.drafts.get("msg-1")?.nextSequence).toBe(4);
  });

  test("a finalized message drops its draft and asks for a refresh", () => {
    const streaming = foldStreamEvents(EMPTY_LIVE_THREAD, [chunk("evt-1", 0, "Hi")]).state;
    const finalized = {
      eventId: "evt-2",
      eventType: "assistant-message.finalized",
      messageId: "msg-1",
      payload: { body: "Hi" },
      runId: "run-1",
    };
    const { refresh, state } = foldStreamEvents(streaming, [finalized]);
    expect(refresh).toBe(true);
    expect([...state.drafts.keys()]).toEqual([]);
  });

  test("a chunk for a finalized message is ignored, even from another model call", () => {
    const finalized = {
      eventId: "evt-2",
      eventType: "assistant-message.finalized",
      messageId: "msg-1",
      payload: {},
      runId: "run-1",
    };
    const settled = foldStreamEvents(EMPTY_LIVE_THREAD, [chunk("evt-1", 0, "Hi"), finalized]);
    const late = foldStreamEvents(settled.state, [
      chunk("evt-3", 0, "late", "call-2"),
      { ...chunk("evt-4", 0, "next"), messageId: "msg-2" },
    ]);
    expect([...late.state.drafts.keys()]).toEqual(["msg-2"]);
  });

  test("a terminal run event drops only that run's drafts", () => {
    const other = { ...chunk("evt-2", 0, "other run"), messageId: "msg-2", runId: "run-2" };
    const streaming = foldStreamEvents(EMPTY_LIVE_THREAD, [chunk("evt-1", 0, "Hi"), other]).state;
    const failed = { eventId: "evt-3", eventType: "run.failed", payload: {}, runId: "run-1" };
    const { refresh, state } = foldStreamEvents(streaming, [failed]);
    expect(refresh).toBe(true);
    expect([...state.drafts.keys()]).toEqual(["msg-2"]);
  });

  test("an event ID seen before is ignored", () => {
    const accepted = {
      eventId: "evt-1",
      eventType: "user-message.accepted",
      messageId: "msg-0",
      payload: {},
      runId: "run-1",
    };
    const first = foldStreamEvents(EMPTY_LIVE_THREAD, [accepted]);
    expect(first.refresh).toBe(true);
    expect(foldStreamEvents(first.state, [accepted]).refresh).toBe(false);
    const replayed = foldStreamEvents(first.state, [chunk("evt-1", 0, "Hi")]);
    expect([...replayed.state.drafts.keys()]).toEqual([]);
  });

  test("ignores event types the console does not show", () => {
    const plan = { eventId: "evt-1", eventType: "agent.plan.updated", payload: {}, runId: "run-1" };
    const tool = { eventId: "evt-2", eventType: "tool.running", payload: {}, runId: "run-1" };
    expect(foldStreamEvents(EMPTY_LIVE_THREAD, [plan]).refresh).toBe(false);
    expect(foldStreamEvents(EMPTY_LIVE_THREAD, [plan, tool]).refresh).toBe(true);
  });

  test("remembers the 500 most recent event IDs", () => {
    const events = Array.from({ length: 501 }, (_, index) => ({
      eventId: `evt-${index}`,
      eventType: "run.progress",
      payload: {},
    }));
    const { seenEventIds } = foldStreamEvents(EMPTY_LIVE_THREAD, events).state;
    expect(seenEventIds.length).toBe(500);
    expect(seenEventIds[0]).toBe("evt-1");
    expect(seenEventIds[499]).toBe("evt-500");
  });
});
