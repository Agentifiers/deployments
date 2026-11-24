/**
 * The browser's reader of one thread's Durable Streams feed on the stream gateway: read URLs, token
 * renewal, SSE frames, the commit rule, and the fold of committed events into live drafts. Pure;
 * `components/runs/use-thread-stream.ts` owns `fetch`, timers, and React state.
 */

import { fields } from "../data/server-input.ts";

/** What the console server hands the browser to read one thread's stream with. */
export interface ThreadStreamGrant {
  /** A read-only stream token that expires five minutes after it is issued. */
  readonly accessToken: string;
  /**
   * The token's lifetime when the console server handed it out, counted down on the browser's own
   * clock because the two clocks may disagree.
   */
  readonly expiresInMs: number;
  /** The stream's tail when the token was issued; a reader starts here once. */
  readonly offset: string;
  readonly streamUrl: string;
}

/** Where the next read starts, as the last control frame reported it. */
export interface StreamPosition {
  readonly offset: string;
  readonly cursor?: string;
}

export interface SseFrame {
  readonly event: string;
  readonly data: string;
}

/** The subset of a thread stream event the console reads. */
export interface StreamEventLike {
  readonly eventId: string;
  readonly eventType: string;
  readonly messageId?: string;
  readonly runId?: string;
  readonly payload: unknown;
}

/** One SSE response's progress: data entries stay pending until the next control frame. */
export interface StreamCursorState {
  readonly position: StreamPosition;
  readonly pending: readonly StreamEventLike[];
  readonly closed: boolean;
}

/** Assistant text streaming into a message the transcript does not hold yet. */
export interface LiveDraft {
  readonly messageId: string;
  readonly runId?: string;
  readonly modelCallId: string;
  readonly text: string;
  readonly nextSequence: number;
}

export interface LiveThreadState {
  readonly drafts: ReadonlyMap<string, LiveDraft>;
  /** The most recent event IDs, oldest first; replays and recovery append the same event again. */
  readonly seenEventIds: readonly string[];
  /** The most recently finalized messages, oldest first. A late chunk must not reopen one. */
  readonly finalizedMessageIds: readonly string[];
}

export type LiveStatus = "connecting" | "live" | "unavailable";

export const EMPTY_LIVE_THREAD: LiveThreadState = {
  drafts: new Map(),
  finalizedMessageIds: [],
  seenEventIds: [],
};

const RENEW_BEFORE_EXPIRY_MS = 60_000;
const SEEN_EVENT_LIMIT = 500;
const FINALIZED_MESSAGE_LIMIT = 100;

/** A CR that ends a chunk may be half of a CRLF, so it waits for the next chunk. */
const LINE_BREAK = /\r\n|\r(?!$)|\n/u;

type LiveEffect = "chunk" | "drop-message" | "drop-run" | "refresh";

/** What each event the console reacts to does to the live view; other event types are ignored. */
const LIVE_EFFECTS: Readonly<Record<string, LiveEffect>> = {
  "approval.requested": "refresh",
  "assistant-message.finalized": "drop-message",
  "assistant-token.chunk": "chunk",
  "run.canceled": "drop-run",
  "run.completed": "drop-run",
  "run.failed": "drop-run",
  "run.replayed": "refresh",
  "run.retry-requested": "refresh",
  "run.started": "refresh",
  "tool.running": "refresh",
  "user-message.accepted": "refresh",
};

export function streamReadUrl(streamUrl: string, position: StreamPosition): string {
  const url = new URL(streamUrl);
  url.searchParams.set("offset", position.offset);
  if (position.cursor !== undefined) url.searchParams.set("cursor", position.cursor);
  url.searchParams.set("live", "sse");
  return url.href;
}

/**
 * The gateway checks the token only when a read connects; renew one with under a minute left.
 * `elapsedMs` is the time since the grant arrived, on the browser's clock.
 */
export function grantNeedsRenewal(grant: ThreadStreamGrant, elapsedMs: number): boolean {
  return grant.expiresInMs - elapsedMs < RENEW_BEFORE_EXPIRY_MS;
}

/** Turns decoded text chunks into whole SSE frames; `event` defaults to `message`. */
export function createSseFrameReader(): { push(chunk: string): readonly SseFrame[] } {
  let partialLine = "";
  let event = "";
  let data: string[] = [];
  return {
    push(chunk) {
      const lines = (partialLine + chunk).split(LINE_BREAK);
      partialLine = lines.pop() ?? "";
      const frames: SseFrame[] = [];
      for (const line of lines) {
        if (line === "") {
          if (data.length > 0) frames.push({ data: data.join("\n"), event: event || "message" });
          event = "";
          data = [];
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /u, "");
          if (field === "event") event = value;
          else if (field === "data") data.push(value);
        }
      }
      return frames;
    },
  };
}

/**
 * A data frame's events wait for the next control frame, which commits them and moves the position.
 * `committed` is undefined unless a control frame did that; one without an offset moves nothing.
 */
export function applyStreamFrame(
  state: StreamCursorState,
  frame: SseFrame,
): { state: StreamCursorState; committed: readonly StreamEventLike[] | undefined } {
  if (frame.event === "data") {
    return {
      committed: undefined,
      state: { ...state, pending: [...state.pending, ...streamEvents(frame.data)] },
    };
  }
  const control = frame.event === "control" ? streamControl(frame.data) : undefined;
  if (control === undefined) return { committed: undefined, state };
  return { committed: state.pending, state: { ...control, pending: [] } };
}

/**
 * Folds committed events into the live drafts. `refresh` reports an event whose effect the polled
 * transcript or runs show; a finalized message or a terminal run drops the drafts it settles.
 */
export function foldStreamEvents(
  state: LiveThreadState,
  events: readonly StreamEventLike[],
): { state: LiveThreadState; refresh: boolean } {
  const seen = new Set(state.seenEventIds);
  const seenEventIds = [...state.seenEventIds];
  const finalized = new Set(state.finalizedMessageIds);
  const drafts = new Map(state.drafts);
  let refresh = false;
  for (const event of events) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    seenEventIds.push(event.eventId);
    switch (LIVE_EFFECTS[event.eventType]) {
      case "chunk": {
        const draft = withChunk(drafts, event);
        if (draft && !finalized.has(draft.messageId)) {
          drafts.set(draft.messageId, draft);
        }
        break;
      }
      case "drop-message":
        if (event.messageId !== undefined) {
          drafts.delete(event.messageId);
          finalized.add(event.messageId);
        }
        refresh = true;
        break;
      case "drop-run":
        for (const [messageId, draft] of drafts) {
          if (event.runId !== undefined && draft.runId === event.runId) drafts.delete(messageId);
        }
        refresh = true;
        break;
      case "refresh":
        refresh = true;
        break;
      case undefined:
        break;
    }
  }
  return {
    refresh,
    state: {
      drafts,
      finalizedMessageIds: [...finalized].slice(-FINALIZED_MESSAGE_LIMIT),
      seenEventIds: seenEventIds.slice(-SEEN_EVENT_LIMIT),
    },
  };
}

/**
 * The draft after one chunk, or `undefined` when the chunk is a duplicate or skips ahead. A new
 * `modelCallId` supersedes the draft. A reader joins at the stream's tail, so a model call already
 * under way starts mid-text, which the leading ellipsis shows.
 */
function withChunk(
  drafts: ReadonlyMap<string, LiveDraft>,
  event: StreamEventLike,
): LiveDraft | undefined {
  const chunk = tokenChunk(event.payload);
  if (chunk === undefined || event.messageId === undefined) return undefined;
  const draft = drafts.get(event.messageId);
  if (draft?.modelCallId === chunk.modelCallId) {
    return chunk.sequence === draft.nextSequence
      ? { ...draft, nextSequence: chunk.sequence + 1, text: draft.text + chunk.text }
      : undefined;
  }
  return {
    messageId: event.messageId,
    modelCallId: chunk.modelCallId,
    nextSequence: chunk.sequence + 1,
    text: chunk.sequence === 0 ? chunk.text : `…${chunk.text}`,
    ...(event.runId === undefined ? {} : { runId: event.runId }),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function streamEvents(data: string): StreamEventLike[] {
  const json = parseJson(data);
  return (Array.isArray(json) ? json : [json]).flatMap((entry) => {
    const event = streamEvent(entry);
    return event === undefined ? [] : [event];
  });
}

function streamEvent(value: unknown): StreamEventLike | undefined {
  const { eventId, eventType, messageId, payload, runId } = fields(value);
  if (typeof eventId !== "string" || typeof eventType !== "string") return undefined;
  return {
    eventId,
    eventType,
    payload,
    ...(typeof messageId === "string" ? { messageId } : {}),
    ...(typeof runId === "string" ? { runId } : {}),
  };
}

function streamControl(data: string): Omit<StreamCursorState, "pending"> | undefined {
  const { streamClosed, streamCursor, streamNextOffset } = fields(parseJson(data));
  if (typeof streamNextOffset !== "string" || streamNextOffset === "") return undefined;
  return {
    closed: streamClosed === true,
    position: {
      offset: streamNextOffset,
      ...(typeof streamCursor === "string" && streamCursor !== "" ? { cursor: streamCursor } : {}),
    },
  };
}

function tokenChunk(payload: unknown) {
  const { modelCallId, sequence, text } = fields(payload);
  if (typeof modelCallId !== "string" || modelCallId === "" || typeof text !== "string") {
    return undefined;
  }
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) {
    return undefined;
  }
  return { modelCallId, sequence, text };
}
