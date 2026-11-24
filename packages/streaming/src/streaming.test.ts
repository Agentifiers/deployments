import { describe, expect, it } from "bun:test";
import {
  appendThreadStreamEvents,
  assertActiveThreadStreamSession,
  createOffsetBeforeHistorySession,
  createThreadStreamEvent,
  durableStreamReadUrl,
  parseThreadStreamEvent,
  parseThreadStreamPath,
  StreamContractError,
  StreamSessionExpiredError,
  ThreadStreamDeduplicator,
  threadStreamPath,
  type DurableStreamTransport,
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

describe("thread streaming", () => {
  it("uses one tenant and environment scoped path per thread", () => {
    const path = threadStreamPath(scope);
    expect(path).toBe(
      "/v1/stream/org/organization-1/project/project-1/environment/environment-1/thread/thread-1",
    );
    expect(parseThreadStreamPath(path)).toEqual(scope);
  });

  it("rejects events from another environment before append", async () => {
    let appended = false;
    const transport: DurableStreamTransport = {
      append: async () => {
        appended = true;
        return {};
      },
      currentOffset: async () => "42",
    };
    expect(
      appendThreadStreamEvents({
        events: [event({ environmentId: "environment-2" })],
        producerId: "worker-1",
        producerType: "worker",
        scope,
        transport,
      }),
    ).rejects.toBeInstanceOf(StreamContractError);
    expect(appended).toBe(false);
  });

  it("requires correlation identifiers for known event types", () => {
    expect(() =>
      createThreadStreamEvent({
        ...scope,
        eventId: "missing-payload",
        eventType: "run.progress",
        occurredAt: "2026-07-22T00:00:00.000Z",
        runId: "run-1",
      } as never),
    ).toThrow(StreamContractError);
    expect(() =>
      createThreadStreamEvent({
        ...scope,
        eventId: "non-json-payload",
        eventType: "run.progress",
        occurredAt: "2026-07-22T00:00:00.000Z",
        payload: 1n,
        runId: "run-1",
      }),
    ).toThrow(StreamContractError);
    for (const payload of [
      { sequence: 0, text: "partial" },
      { modelCallId: " ", sequence: 0, text: "partial" },
      { modelCallId: "call-1", sequence: -1, text: "partial" },
      { modelCallId: "call-1", sequence: 1.5, text: "partial" },
      { modelCallId: "call-1", sequence: 0 },
      { messageSequence: 1, sequence: 0, text: "partial" },
    ]) {
      expect(() =>
        createThreadStreamEvent({
          ...scope,
          eventId: "invalid-chunk",
          eventType: "assistant-token.chunk",
          messageId: "message-1",
          occurredAt: "2026-07-22T00:00:00.000Z",
          payload,
          runId: "run-1",
        }),
      ).toThrow(StreamContractError);
    }
    expect(
      createThreadStreamEvent({
        ...scope,
        eventId: "valid-chunk",
        eventType: "assistant-token.chunk",
        messageId: "message-1",
        occurredAt: "2026-07-22T00:00:00.000Z",
        payload: { modelCallId: "call-1", sequence: 0, text: "" },
        runId: "run-1",
      }).payload,
    ).toEqual({ modelCallId: "call-1", sequence: 0, text: "" });
    expect(() =>
      createThreadStreamEvent({
        ...scope,
        eventId: "final-without-message",
        eventType: "assistant-message.finalized",
        occurredAt: "2026-07-22T00:00:00.000Z",
        payload: {},
        runId: "run-1",
      }),
    ).toThrow(StreamContractError);
    expect(() =>
      createThreadStreamEvent({
        ...scope,
        eventId: "tool-without-call",
        eventType: "tool.completed",
        occurredAt: "2026-07-22T00:00:00.000Z",
        payload: {},
        runId: "run-1",
      }),
    ).toThrow(StreamContractError);
  });

  it("rejects token chunks without the model call contract when parsed and appended", async () => {
    const chunk = {
      ...scope,
      eventId: "token-chunk",
      eventType: "assistant-token.chunk",
      messageId: "message-1",
      occurredAt: "2026-07-22T00:00:00.000Z",
      payload: { sequence: 3, text: "unscoped" },
      runId: "run-1",
    };
    let appended = false;

    expect(() => parseThreadStreamEvent(chunk)).toThrow("modelCallId");
    expect(
      appendThreadStreamEvents({
        events: [chunk],
        producerId: "worker-1",
        producerType: "worker",
        scope,
        transport: {
          append: async () => {
            appended = true;
            return {};
          },
          currentOffset: async () => "42",
        },
      }),
    ).rejects.toThrow("modelCallId");
    expect(appended).toBe(false);
  });

  it("serializes validated events through an idempotent producer identity", async () => {
    const calls: unknown[] = [];
    const transport: DurableStreamTransport = {
      append: async (input) => {
        calls.push(input);
        return { lastSuccessfulOffset: "42" };
      },
      currentOffset: async () => "42",
    };
    const result = await appendThreadStreamEvents({
      events: [event()],
      producerId: "worker-1",
      producerType: "worker",
      scope,
      transport,
    });
    expect(result.appendedCount).toBe(1);
    expect(result.lastSuccessfulOffset).toBe("42");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ producerId: "worker:worker-1" });
  });

  it("captures the durable offset before querying DynamoDB history", async () => {
    const order: string[] = [];
    const transport: DurableStreamTransport = {
      append: async () => ({}),
      currentOffset: async () => {
        order.push("offset");
        return "10";
      },
    };
    const result = await createOffsetBeforeHistorySession({
      canonicalMessageId: (message: { readonly messageId: string }) => message.messageId,
      claims: {
        ...scope,
        expiresAt: "2099-01-01T00:00:00.000Z",
        permissions: ["read"],
        sessionId: "session-1",
      },
      createReadUrl: (offset) => `https://stream.example.test/read?offset=${offset}`,
      finalizedMessageId: (message: {
        readonly messageId: string;
        readonly role: "assistant" | "user";
      }) => (message.role === "assistant" ? message.messageId : undefined),
      historyItemBytes: () => 100,
      readHistoryPage: async (_scope, cursor) => {
        order.push(`history:${cursor ?? "first"}`);
        return cursor
          ? { items: [{ messageId: "message-2", role: "assistant" as const }] }
          : {
              items: [{ messageId: "message-1", role: "user" as const }],
              nextCursor: "page-2",
            };
      },
      scope,
      transport,
    });
    expect(order).toEqual(["offset", "history:first", "history:page-2"]);
    expect(result.session.offset).toBe("10");
    expect(result.session.readUrl).toBe("https://stream.example.test/read?offset=10");
    expect(result.session.replayState.canonicalMessageIds).toEqual(["message-1", "message-2"]);
    expect(result.session.replayState.finalizedMessageIds).toEqual(["message-2"]);
    expect(result.history.items).toHaveLength(2);
    expect(
      new ThreadStreamDeduplicator(result.session.replayState).accept(
        event({
          eventId: "final-overlap",
          eventType: "assistant-message.finalized",
          messageId: "message-2",
        }),
      ),
    ).toBe(false);
    expect(
      new ThreadStreamDeduplicator(result.session.replayState).accept(
        event({
          eventId: "user-history-overlap",
          eventType: "user-message.accepted",
          messageId: "message-1",
        }),
      ),
    ).toBe(false);
    expect(
      new ThreadStreamDeduplicator(result.session.replayState).accept(
        event({
          eventId: "chunk-history-overlap",
          eventType: "assistant-token.chunk",
          messageId: "message-2",
          payload: { modelCallId: "call-1", sequence: 0, text: "late" },
        }),
      ),
    ).toBe(false);
    expect(
      new ThreadStreamDeduplicator(result.session.replayState).accept(
        event({
          eventId: "final-later-page",
          eventType: "assistant-message.finalized",
          messageId: "message-2",
        }),
      ),
    ).toBe(false);
  });

  it("returns one bounded history page and its continuation cursor", async () => {
    const cursors: Array<string | undefined> = [];
    const result = await createOffsetBeforeHistorySession({
      canonicalMessageId: (message: { readonly messageId: string }) => message.messageId,
      claims: {
        ...scope,
        expiresAt: "2099-01-01T00:00:00.000Z",
        permissions: ["read"],
        sessionId: "session-page",
      },
      createReadUrl: (offset) => `https://stream.example.test/read?offset=${offset}`,
      finalizedMessageId: (message: {
        readonly messageId: string;
        readonly role: "assistant" | "user";
      }) => (message.role === "assistant" ? message.messageId : undefined),
      historyItemBytes: () => 1,
      historyMode: "page",
      readHistoryPage: async (_scope, cursor) => {
        cursors.push(cursor);
        return {
          items: [{ messageId: "message-1", role: "assistant" as const }],
          nextCursor: "page-2",
        };
      },
      scope,
      transport: {
        append: async () => ({}),
        currentOffset: async () => "10",
      },
    });

    expect(cursors).toEqual([undefined]);
    expect(result.history.nextCursor).toBe("page-2");
    expect(result.session.replayState).toEqual({
      canonicalMessageIds: ["message-1"],
      finalizedMessageIds: ["message-1"],
    });
  });

  it("collects a complete replay seed while returning one history page", async () => {
    const cursors: Array<string | undefined> = [];
    const result = await createOffsetBeforeHistorySession({
      canonicalMessageId: (message: { readonly messageId: string }) => message.messageId,
      claims: {
        ...scope,
        expiresAt: "2099-01-01T00:00:00.000Z",
        permissions: ["read"],
        sessionId: "session-complete-seed",
      },
      createReadUrl: (offset) => `https://stream.example.test/read?offset=${offset}`,
      finalizedMessageId: (message: {
        readonly messageId: string;
        readonly role: "assistant" | "user";
      }) => (message.role === "assistant" ? message.messageId : undefined),
      historyItemBytes: () => 1,
      historyMode: "page",
      readHistoryPage: async (_scope, cursor) => {
        cursors.push(cursor);
        return cursor
          ? { items: [{ messageId: "message-2", role: "assistant" as const }] }
          : {
              items: [{ messageId: "message-1", role: "assistant" as const }],
              nextCursor: "page-2",
            };
      },
      replaySeedMode: "complete",
      scope,
      transport: {
        append: async () => ({}),
        currentOffset: async () => "10",
      },
    });

    expect(cursors).toEqual([undefined, "page-2"]);
    expect(result.history.items).toEqual([{ messageId: "message-1", role: "assistant" }]);
    expect(result.history.nextCursor).toBe("page-2");
    expect(result.session.replayState.finalizedMessageIds).toEqual(["message-1", "message-2"]);
  });

  it("rejects session claims that do not match the requested history scope", async () => {
    let historyRead = false;
    const transport: DurableStreamTransport = {
      append: async () => ({}),
      currentOffset: async () => "10",
    };

    expect(
      createOffsetBeforeHistorySession({
        canonicalMessageId: () => undefined,
        claims: {
          ...scope,
          expiresAt: "2099-01-01T00:00:00.000Z",
          permissions: ["read"],
          sessionId: "session-1",
        },
        createReadUrl: () => "https://stream.example.test/read",
        finalizedMessageId: () => undefined,
        historyItemBytes: () => 0,
        readHistoryPage: async () => {
          historyRead = true;
          return { items: [] };
        },
        scope: { ...scope, threadId: "thread-2" },
        transport,
      }),
    ).rejects.toBeInstanceOf(StreamContractError);
    expect(historyRead).toBe(false);
  });

  it("bounds paginated history assembly before exposing a session", async () => {
    const transport: DurableStreamTransport = {
      append: async () => ({}),
      currentOffset: async () => "10",
    };

    expect(
      createOffsetBeforeHistorySession({
        canonicalMessageId: () => undefined,
        claims: {
          ...scope,
          expiresAt: "2099-01-01T00:00:00.000Z",
          permissions: ["read"],
          sessionId: "session-1",
        },
        createReadUrl: () => "https://stream.example.test/read",
        finalizedMessageId: () => undefined,
        historyItemBytes: () => 0,
        maxHistoryPages: 2,
        readHistoryPage: async (_scope, cursor) => ({
          items: [],
          nextCursor: cursor === undefined ? "page-2" : "page-3",
        }),
        scope,
        transport,
      }),
    ).rejects.toThrow("exceeded the 2-page limit");
  });

  it("bounds total history items and bytes before exposing a session", async () => {
    const transport: DurableStreamTransport = {
      append: async () => ({}),
      currentOffset: async () => "10",
    };
    const sessionInput = {
      canonicalMessageId: () => undefined,
      claims: {
        ...scope,
        expiresAt: "2099-01-01T00:00:00.000Z",
        permissions: ["read" as const],
        sessionId: "session-bounded",
      },
      createReadUrl: () => "https://stream.example.test/read",
      finalizedMessageId: () => undefined,
      scope,
      transport,
    };

    expect(
      createOffsetBeforeHistorySession({
        ...sessionInput,
        historyItemBytes: () => 1,
        maxHistoryItems: 2,
        readHistoryPage: async () => ({ items: ["one", "two", "three"] }),
      }),
    ).rejects.toThrow("exceeded the 2-item limit");
    expect(
      createOffsetBeforeHistorySession({
        ...sessionInput,
        historyItemBytes: (item: string) => new TextEncoder().encode(item).byteLength,
        maxHistoryBytes: 4,
        readHistoryPage: async () => ({ items: ["abc", "de"] }),
      }),
    ).rejects.toThrow("exceeded the 4-byte limit");
    expect(
      createOffsetBeforeHistorySession({
        ...sessionInput,
        historyItemBytes: () => 4 * 1024 * 1024 + 1,
        readHistoryPage: async () => ({ items: ["oversized"] }),
      }),
    ).rejects.toThrow("exceeded the 4194304-byte limit");
  });

  it("rejects a session that expires while history is being assembled", async () => {
    const expiration = Date.parse("2026-07-22T00:00:01.000Z");
    const times = [expiration - 1, expiration];
    const transport: DurableStreamTransport = {
      append: async () => ({}),
      currentOffset: async () => "10",
    };

    expect(
      createOffsetBeforeHistorySession({
        canonicalMessageId: () => undefined,
        claims: {
          ...scope,
          expiresAt: new Date(expiration).toISOString(),
          permissions: ["read"],
          sessionId: "session-expiring",
        },
        createReadUrl: () => "https://stream.example.test/read",
        finalizedMessageId: () => undefined,
        historyItemBytes: () => 0,
        now: () => times.shift() ?? expiration,
        readHistoryPage: async () => ({ items: [] }),
        scope,
        transport,
      }),
    ).rejects.toBeInstanceOf(StreamSessionExpiredError);
  });

  it("enforces scoped session permissions and emits resumable read URLs", () => {
    const claims = {
      ...scope,
      expiresAt: "2099-01-01T00:00:00.000Z",
      permissions: ["read"] as const,
      sessionId: "session-1",
    };
    expect(() => assertActiveThreadStreamSession(claims, scope, "read")).not.toThrow();
    expect(() => assertActiveThreadStreamSession(claims, scope, "append")).toThrow(
      StreamContractError,
    );
    expect(
      durableStreamReadUrl({
        baseUrl: "https://streams.example.test/root/",
        cursor: "cursor-1",
        live: "sse",
        streamPath: threadStreamPath(scope),
      }),
    ).toBe(
      "https://streams.example.test/root/v1/stream/org/organization-1/project/project-1/environment/environment-1/thread/thread-1?cursor=cursor-1&live=sse",
    );
    expect(() =>
      durableStreamReadUrl({
        baseUrl: "http://streams.example.test",
        streamPath: threadStreamPath(scope),
      }),
    ).toThrow("must use HTTPS outside loopback development");
    expect(
      durableStreamReadUrl({
        allowInsecurePrivateHttp: true,
        baseUrl: "http://streams.internal",
        streamPath: threadStreamPath(scope),
      }),
    ).toStartWith("http://streams.internal/v1/stream/");
    expect(() =>
      durableStreamReadUrl({
        baseUrl: "https://user:password@streams.example.test",
        streamPath: threadStreamPath(scope),
      }),
    ).toThrow("must not include username or password");
    expect(
      durableStreamReadUrl({
        baseUrl: "http://127.0.0.1:4437",
        streamPath: threadStreamPath(scope),
      }),
    ).toStartWith("http://127.0.0.1:4437/v1/stream/");
    expect(
      durableStreamReadUrl({
        baseUrl: "https://streams.example.test",
        cursor: " cursor with spaces ",
        offset: " offset with spaces ",
        streamPath: threadStreamPath(scope),
      }),
    ).toContain("cursor=+cursor+with+spaces+&offset=+offset+with+spaces+");
    expect(() =>
      durableStreamReadUrl({
        baseUrl: "https://streams.example.test",
        cursor: "",
        streamPath: threadStreamPath(scope),
      }),
    ).toThrow("cursor must not be empty");
  });
});
