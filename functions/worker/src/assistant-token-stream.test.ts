import { afterAll, afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { ThreadStreamEvent } from "@deployments-ai/streaming";
import { stableCompletionMessageId } from "./agent-run-input.ts";
import { fixtures, inMemoryDatabase, workerDependencies } from "./agent-run.fixture.ts";
import {
  ASSISTANT_TOKEN_FLUSH_BYTES,
  ASSISTANT_TOKEN_FLUSH_INTERVAL_MS,
  ASSISTANT_TOKEN_MAX_PENDING_BYTES,
  createAssistantTokenStream,
} from "./assistant-token-stream.ts";
import type { AgentRunWorkerDependencies, RunRecordValue } from "./types.ts";

const warn = spyOn(console, "warn").mockImplementation(() => undefined);

afterEach(() => {
  warn.mockClear();
  vi.useRealTimers();
});

afterAll(() => {
  warn.mockRestore();
});

function tokenStream(
  appendThreadEvent: NonNullable<AgentRunWorkerDependencies["appendThreadEvent"]>,
  run: RunRecordValue = fixtures().run,
) {
  const base = workerDependencies(inMemoryDatabase([]).database).dependencies;
  return createAssistantTokenStream({ ...base, appendThreadEvent }, run);
}

/** Records appended chunks; `appended(n)` resolves once n chunks have landed. */
function recordingStream(run?: RunRecordValue) {
  const events: ThreadStreamEvent[] = [];
  const waiters: { readonly count: number; readonly resolve: () => void }[] = [];
  const stream = tokenStream(async (event) => {
    events.push(event);
    for (const waiter of waiters.filter((candidate) => candidate.count <= events.length)) {
      waiter.resolve();
    }
  }, run)!;
  const appended = (count: number) =>
    events.length >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => void waiters.push({ count, resolve }));
  return { appended, events, stream };
}

const payloads = (events: readonly ThreadStreamEvent[]) => events.map((event) => event.payload);

describe("assistant token stream", () => {
  it("coalesces deltas into ordered chunks of the run's completion message", async () => {
    const run = fixtures().run;
    const { events, stream } = recordingStream(run);

    stream.append({ modelCallId: "call-1", text: "Hel" });
    stream.append({ modelCallId: "call-1", text: "lo" });
    await stream.flush("call-1");
    stream.append({ modelCallId: "call-2", text: "Retry" });
    stream.append({ modelCallId: "call-2", text: "" });
    await stream.flush("call-2");

    expect(payloads(events)).toEqual([
      { modelCallId: "call-1", sequence: 0, text: "Hello" },
      { modelCallId: "call-2", sequence: 0, text: "Retry" },
    ]);
    expect(events[0]).toMatchObject({
      actor: { type: "worker" },
      environmentId: run.data.environmentId,
      eventType: "assistant-token.chunk",
      messageId: stableCompletionMessageId(run.data.id),
      organizationId: run.data.organizationId,
      projectId: run.data.projectId,
      runId: run.data.id,
      threadId: run.data.threadId,
    });
    expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
  });

  it("flushes by size immediately and by time once the interval elapses", async () => {
    vi.useFakeTimers();
    const { appended, events, stream } = recordingStream();
    const full = "x".repeat(ASSISTANT_TOKEN_FLUSH_BYTES);

    stream.append({ modelCallId: "call-1", text: full });
    await appended(1);
    stream.append({ modelCallId: "call-1", text: "tail" });
    vi.advanceTimersByTime(ASSISTANT_TOKEN_FLUSH_INTERVAL_MS - 1);
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await appended(2);

    expect(payloads(events)).toEqual([
      { modelCallId: "call-1", sequence: 0, text: full },
      { modelCallId: "call-1", sequence: 1, text: "tail" },
    ]);
  });

  it("serializes appends so chunks land in order", async () => {
    const events: ThreadStreamEvent[] = [];
    let inFlight = 0;
    let maximumInFlight = 0;
    const stream = tokenStream(async (event) => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await Promise.resolve();
      events.push(event);
      inFlight -= 1;
    })!;

    for (const text of ["a", "b", "c"]) {
      stream.append({ modelCallId: "call-1", text: text.repeat(ASSISTANT_TOKEN_FLUSH_BYTES) });
    }
    await stream.flush("call-1");

    expect(maximumInFlight).toBe(1);
    expect(payloads(events)).toMatchObject([{ sequence: 0 }, { sequence: 1 }, { sequence: 2 }]);
  });

  it("stops streaming a model call after a failed append without failing the flush", async () => {
    const events: ThreadStreamEvent[] = [];
    let attempts = 0;
    const stream = tokenStream(async (event) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("durable streams unavailable");
      }
      events.push(event);
    })!;

    stream.append({ modelCallId: "call-1", text: "z".repeat(ASSISTANT_TOKEN_FLUSH_BYTES) });
    stream.append({ modelCallId: "call-1", text: "dropped" });
    await stream.flush("call-1");
    stream.append({ modelCallId: "call-2", text: "next" });
    await stream.flush("call-2");

    expect(payloads(events)).toEqual([{ modelCallId: "call-2", sequence: 0, text: "next" }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("bounds undelivered text while an append stalls", async () => {
    const events: ThreadStreamEvent[] = [];
    let started!: () => void;
    const firstAppend = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stream = tokenStream(async (event) => {
      started();
      await stalled;
      events.push(event);
    })!;
    const delta = "y".repeat(ASSISTANT_TOKEN_FLUSH_BYTES);

    stream.append({ modelCallId: "call-1", text: delta });
    await firstAppend;
    for (let total = delta.length; total <= ASSISTANT_TOKEN_MAX_PENDING_BYTES; ) {
      stream.append({ modelCallId: "call-1", text: delta });
      total += delta.length;
    }
    release();
    await stream.flush("call-1");
    stream.append({ modelCallId: "call-2", text: "after" });
    await stream.flush("call-2");

    expect(payloads(events)).toEqual([
      { modelCallId: "call-1", sequence: 0, text: delta },
      { modelCallId: "call-2", sequence: 0, text: "after" },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not stream runs whose output stays out of the thread", () => {
    const run = fixtures().run;
    const append = async () => undefined;

    for (const data of [
      { ...run.data, trigger: "heartbeat" as const },
      { ...run.data, trigger: "schedule" as const },
      { ...run.data, responsePublication: "external" as const },
    ]) {
      expect(tokenStream(append, { ...run, data })).toBeUndefined();
    }
  });
});
