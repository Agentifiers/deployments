import { describe, expect, it } from "bun:test";
import {
  createThreadStreamEvent,
  ThreadStreamDeduplicator,
  type ThreadStreamScope,
} from "./index.ts";

const scope: ThreadStreamScope = {
  environmentId: "environment-1",
  organizationId: "organization-1",
  projectId: "project-1",
  threadId: "thread-1",
};

function event(overrides: Partial<ReturnType<typeof createThreadStreamEvent>> = {}) {
  return createThreadStreamEvent({
    ...scope,
    eventId: "event-1",
    eventType: "run.progress",
    occurredAt: "2026-07-22T00:00:00.000Z",
    payload: { message: "working" },
    runId: "run-1",
    ...overrides,
  });
}

describe("thread stream replay deduplication", () => {
  it("deduplicates replayed events and finalized messages, dropping chunks only once finalized", () => {
    const deduplicator = new ThreadStreamDeduplicator();
    expect(deduplicator.accept(event())).toBe(true);
    expect(deduplicator.accept(event())).toBe(false);
    expect(
      deduplicator.accept(
        event({
          eventId: "chunk-1",
          eventType: "assistant-token.chunk",
          messageId: "message-1",
          payload: { modelCallId: "call-1", sequence: 0, text: "Hel" },
        }),
      ),
    ).toBe(true);
    expect(
      deduplicator.accept(
        event({
          eventId: "chunk-2",
          eventType: "assistant-token.chunk",
          messageId: "message-1",
          payload: { modelCallId: "call-1", sequence: 1, text: "lo" },
        }),
      ),
    ).toBe(true);
    expect(
      deduplicator.accept(
        event({
          eventId: "chunk-2",
          eventType: "assistant-token.chunk",
          messageId: "message-1",
          payload: { modelCallId: "call-1", sequence: 1, text: "lo" },
        }),
      ),
    ).toBe(false);
    expect(
      deduplicator.accept(
        event({
          eventId: "final-1",
          eventType: "assistant-message.finalized",
          messageId: "message-1",
        }),
      ),
    ).toBe(true);
    expect(
      deduplicator.accept(
        event({
          eventId: "final-2",
          eventType: "assistant-message.finalized",
          messageId: "message-1",
        }),
      ),
    ).toBe(false);
    expect(
      deduplicator.accept(
        event({
          eventId: "chunk-late",
          eventType: "assistant-token.chunk",
          messageId: "message-1",
          payload: { modelCallId: "call-2", sequence: 0, text: "late" },
        }),
      ),
    ).toBe(false);
  });

  it("applies the compact history boundary to messages but never to live token chunks", () => {
    const deduplicator = new ThreadStreamDeduplicator({
      finalizedMessageIds: [],
      historyThroughSequence: 100,
    });
    expect(
      deduplicator.accept(
        event({
          eventId: "history-page-overlap",
          eventType: "assistant-message.finalized",
          messageId: "message-100",
          payload: { sequence: 100 },
        }),
      ),
    ).toBe(false);
    expect(
      deduplicator.accept(
        event({
          eventId: "token-for-history-sequence",
          eventType: "assistant-token.chunk",
          messageId: "message-100",
          payload: { modelCallId: "call-100", sequence: 7, text: "live" },
        }),
      ),
    ).toBe(true);
    expect(
      deduplicator.accept(
        event({
          eventId: "new-live-token",
          eventType: "assistant-token.chunk",
          messageId: "message-101",
          payload: { modelCallId: "call-101", sequence: 0, text: "new" },
        }),
      ),
    ).toBe(true);
    expect(
      deduplicator.accept(
        event({
          eventId: "new-live-message",
          eventType: "assistant-message.finalized",
          messageId: "message-101",
          payload: { sequence: 101 },
        }),
      ),
    ).toBe(true);
  });

  it("bounds live replay state and releases history overlap after catch-up", () => {
    const deduplicator = new ThreadStreamDeduplicator(
      { canonicalMessageIds: ["history-user"], finalizedMessageIds: ["history-assistant"] },
      { maxEventIds: 2, maxMessageIds: 2 },
    );
    expect(
      deduplicator.accept(
        event({
          eventId: "history-chunk",
          eventType: "assistant-token.chunk",
          messageId: "history-assistant",
          payload: { modelCallId: "call-1", sequence: 0, text: "late" },
        }),
      ),
    ).toBe(false);
    expect(
      deduplicator.accept(
        event({
          eventId: "live-final",
          eventType: "assistant-message.finalized",
          messageId: "live-message",
        }),
      ),
    ).toBe(true);
    deduplicator.markUpToDate();
    expect(
      deduplicator.accept(
        event({
          eventId: "post-catch-up-chunk",
          eventType: "assistant-token.chunk",
          messageId: "history-assistant",
          payload: { modelCallId: "call-1", sequence: 1, text: "late" },
        }),
      ),
    ).toBe(false);
    expect(
      deduplicator.accept(
        event({
          eventId: "live-final-duplicate",
          eventType: "assistant-message.finalized",
          messageId: "live-message",
        }),
      ),
    ).toBe(false);

    expect(deduplicator.accept(event({ eventId: "bounded-1" }))).toBe(true);
    expect(deduplicator.accept(event({ eventId: "bounded-2" }))).toBe(true);
    expect(deduplicator.accept(event({ eventId: "bounded-3" }))).toBe(true);
    expect(deduplicator.accept(event({ eventId: "bounded-1" }))).toBe(true);

    expect(
      deduplicator.accept(
        event({ eventId: "message-1", eventType: "user-message.accepted", messageId: "m1" }),
      ),
    ).toBe(true);
    expect(
      deduplicator.accept(
        event({ eventId: "message-2", eventType: "user-message.accepted", messageId: "m2" }),
      ),
    ).toBe(true);
    expect(
      deduplicator.accept(
        event({ eventId: "message-3", eventType: "user-message.accepted", messageId: "m3" }),
      ),
    ).toBe(true);
    expect(
      deduplicator.accept(
        event({
          eventId: "message-1-replay",
          eventType: "user-message.accepted",
          messageId: "m1",
        }),
      ),
    ).toBe(true);
  });

  it("retains the full bounded history seed until stream catch-up", () => {
    const deduplicator = new ThreadStreamDeduplicator(
      {
        canonicalMessageIds: ["history-1", "history-2", "history-3"],
        finalizedMessageIds: [],
      },
      { maxMessageIds: 2, maxSeedMessageIds: 3 },
    );

    expect(
      deduplicator.accept(
        event({
          eventId: "oldest-history-overlap",
          eventType: "user-message.accepted",
          messageId: "history-1",
        }),
      ),
    ).toBe(false);
    expect(
      () =>
        new ThreadStreamDeduplicator(
          {
            canonicalMessageIds: ["history-1", "history-2", "history-3", "history-4"],
            finalizedMessageIds: [],
          },
          { maxSeedMessageIds: 3 },
        ),
    ).toThrow("exceeds the 3-message limit");
  });

  it("preserves live message deduplication when a full history seed is merged", () => {
    const deduplicator = new ThreadStreamDeduplicator(
      {
        canonicalMessageIds: ["history-user-1", "history-user-2"],
        finalizedMessageIds: ["history-assistant-1", "history-assistant-2"],
      },
      { maxEventIds: 8, maxMessageIds: 2 },
    );
    expect(
      deduplicator.accept(
        event({
          eventId: "live-user-event",
          eventType: "user-message.accepted",
          messageId: "live-user",
        }),
      ),
    ).toBe(true);
    expect(
      deduplicator.accept(
        event({
          eventId: "live-assistant-event",
          eventType: "assistant-message.finalized",
          messageId: "live-assistant",
        }),
      ),
    ).toBe(true);

    deduplicator.markUpToDate();

    expect(
      deduplicator.accept(
        event({
          eventId: "live-user-replay",
          eventType: "user-message.accepted",
          messageId: "live-user",
        }),
      ),
    ).toBe(false);
    expect(
      deduplicator.accept(
        event({
          eventId: "live-assistant-replay",
          eventType: "assistant-message.finalized",
          messageId: "live-assistant",
        }),
      ),
    ).toBe(false);
  });
});
