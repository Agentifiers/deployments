import { describe, expect, it } from "bun:test";
import {
  MessageRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type Ulid,
} from "@deployments-ai/db";
import {
  conversationMessageIsNonReplayable,
  nonReplayableConversationMessageMetadata,
  transientConversationMessageMetadata,
} from "@deployments-ai/conversations";
import { Schema } from "effect";
import { processAgentRun } from "./index.ts";
import { boundedRecentMessages } from "./agent-run-input.ts";
import { loadCausalThreadMessages, THREAD_MESSAGE_QUERY_LIMIT } from "./record-readers.ts";
import type { AgentRunWorkerDependencies, MessageRecordValue } from "./types.ts";
import {
  fixtures,
  id,
  inMemoryDatabase,
  manifestWithRuntime,
  releaseWithManifest,
  workerDependencies,
} from "./agent-run.fixture.ts";

function externalizedHistory(index: number, body: string): MessageRecordValue {
  const { body: _inlineBody, ...data } = fixtures().userMessage.data;
  return Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: {
        ...data,
        bodyRef: {
          bucket: "message-bodies",
          byteSize: new TextEncoder().encode(body).byteLength,
          contentType: "text/plain",
          key: `history-${index}`,
          sha256: "c".repeat(64),
        },
        contentHash: `history-${index}`,
        id: id(700 + index),
        runId: id(800 + index),
        sequence: index,
      },
      itemType: "message" as const,
    }),
  );
}

describe("DynamoDB agent run worker", () => {
  it("reads reachable history bodies together and returns them oldest first within budget", async () => {
    const bodies = ["Never reached.", "漢字", "abcdefghi", "wxyz"];
    const messages = bodies.map((body, index) => externalizedHistory(index, body));
    const reads: Ulid[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const selected = await boundedRecentMessages(messages, 15, {
      readMessageBody: async (message) => {
        reads.push(message.data.id);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        for (let tick = 0; tick < message.data.sequence; tick += 1) await Promise.resolve();
        inFlight -= 1;
        return bodies[message.data.sequence]!;
      },
    } as AgentRunWorkerDependencies);

    expect(selected.map((message) => message.content)).toEqual(["漢字", "abcdefghi", "wxyz"]);
    expect(maxInFlight).toBe(3);
    expect([...reads].sort()).toEqual([id(701), id(702), id(703)]);
  });

  it("fails with the newest unreadable history body and cancels reads it no longer needs", async () => {
    const messages = ["oldest", "older", "newest"].map((body, index) =>
      externalizedHistory(index, body),
    );
    let oldestSignal: AbortSignal | undefined;

    const selected = boundedRecentMessages(messages, 100, {
      readMessageBody: async (message, signal): Promise<string> => {
        if (message.data.sequence === 1) throw new Error("older body unavailable");
        if (message.data.sequence === 0) {
          oldestSignal = signal;
          const aborted = Promise.withResolvers<void>();
          signal?.addEventListener("abort", () => aborted.resolve());
          await aborted.promise;
          throw signal?.reason;
        }
        await Promise.resolve();
        throw new Error("newest body unavailable");
      },
    } as AgentRunWorkerDependencies);

    expect(selected).rejects.toThrow("newest body unavailable");
    expect(oldestSignal?.aborted).toBe(true);
  });

  it("excludes transient and replay-protected turns from the model history budget", async () => {
    const fixture = fixtures();
    const visible = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.userMessage.data,
          body: "Visible conversation.",
          contentHash: "visible-hash",
          id: id(58),
          runId: id(59),
          sequence: 0,
        },
        itemType: "message" as const,
      }),
    );
    const transient = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.userMessage.data,
          body: "Transient heartbeat.",
          contentHash: "transient-hash",
          id: id(60),
          metadata: transientConversationMessageMetadata(),
          runId: id(61),
          sequence: 1,
        },
        itemType: "message" as const,
      }),
    );
    const protectedMessage = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.userMessage.data,
          body: "Private Brain answer available through an authenticated artifact.",
          contentHash: "protected-hash",
          id: id(62),
          metadata: nonReplayableConversationMessageMetadata(),
          runId: id(63),
          sequence: 2,
        },
        itemType: "message" as const,
      }),
    );
    expect(conversationMessageIsNonReplayable(protectedMessage.data.metadata)).toBe(true);
    expect(
      boundedRecentMessages(
        [visible, transient, protectedMessage],
        100,
        {} as AgentRunWorkerDependencies,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        content: "Visible conversation.",
        messageId: visible.data.id,
      }),
    ]);
  });

  it("paginates past transient and replay-protected turns to retain older history", async () => {
    const fixture = fixtures();
    const visible = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.userMessage.data,
          body: "Visible before the heartbeats.",
          contentHash: "visible-before-heartbeats",
          id: id(100),
          runId: id(101),
          sequence: 0,
        },
        itemType: "message" as const,
      }),
    );
    const transientMessages = Array.from({ length: 256 }, (_, index) =>
      Schema.decodeUnknownSync(MessageRecord)(
        withCanonicalRecordKeys({
          data: {
            ...fixture.userMessage.data,
            body: `Transient heartbeat ${index}.`,
            contentHash: `transient-${index}`,
            id: id(200 + index),
            metadata:
              index % 2 === 0
                ? transientConversationMessageMetadata()
                : nonReplayableConversationMessageMetadata(),
            runId: id(500 + index),
            sequence: index + 1,
          },
          itemType: "message" as const,
        }),
      ),
    );
    const triggering = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.userMessage.data,
          sequence: transientMessages.length + 1,
        },
        itemType: "message" as const,
      }),
    );
    const memory = inMemoryDatabase([visible, ...transientMessages, triggering]);

    const result = await loadCausalThreadMessages(
      memory.database,
      { ...fixture.queue, userMessageSequence: triggering.data.sequence },
      triggering,
      10_000,
    );

    expect(result.priorMessages.map((message) => message.data.body)).toEqual([
      "Visible before the heartbeats.",
    ]);
    expect(memory.queryInputs.length).toBeGreaterThan(2);
  });

  it("stops paginating once newest visible history covers the character budget", async () => {
    const fixture = fixtures();
    const visible = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.userMessage.data,
          body: "x".repeat(20_000),
          contentHash: "large-visible-history",
          id: id(900),
          runId: id(901),
          sequence: 0,
        },
        itemType: "message" as const,
      }),
    );
    const triggering = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: { ...fixture.userMessage.data, sequence: 1 },
        itemType: "message" as const,
      }),
    );
    const memory = inMemoryDatabase([triggering]);
    let pages = 0;
    const database = {
      ...memory.database,
      queryRecords: async () => {
        pages += 1;
        return { items: [visible], lastEvaluatedKey: { page: pages } };
      },
    } as DynamoDatabaseService;

    const result = await loadCausalThreadMessages(
      database,
      { ...fixture.queue, userMessageSequence: triggering.data.sequence },
      triggering,
      10_000,
    );

    expect(result.priorMessages).toHaveLength(1);
    expect(pages).toBe(1);
  });

  it("reports causal history truncation after the bounded transient-page scan", async () => {
    const fixture = fixtures();
    const transient = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.userMessage.data,
          body: "Transient heartbeat backlog.",
          contentHash: "transient-backlog",
          id: id(1_000),
          metadata: transientConversationMessageMetadata(),
          runId: id(3_000),
          sequence: 0,
        },
        itemType: "message" as const,
      }),
    );
    const triggering = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: { ...fixture.userMessage.data, sequence: 1 },
        itemType: "message" as const,
      }),
    );
    const memory = inMemoryDatabase([triggering]);
    const expectedMaximumPages = 128;
    let pages = 0;
    const database = {
      ...memory.database,
      queryRecords: async () => {
        pages += 1;
        return {
          items: Array.from({ length: THREAD_MESSAGE_QUERY_LIMIT }, () => transient),
          ...(pages <= expectedMaximumPages ? { lastEvaluatedKey: { page: pages } } : {}),
        };
      },
    } as DynamoDatabaseService;

    expect(
      loadCausalThreadMessages(
        database,
        { ...fixture.queue, userMessageSequence: triggering.data.sequence },
        triggering,
        10_000,
      ),
    ).rejects.toThrow("Causal thread history exceeded the 128-page scan limit");
    expect(pages).toBe(expectedMaximumPages);
  });

  it("reads every history page so the triggering message cannot be omitted", async () => {
    const fixture = fixtures();
    const earlier = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.userMessage.data,
          body: "Earlier message.",
          contentHash: "earlier-hash",
          id: id(50),
          sequence: 0,
        },
        itemType: "message" as const,
      }),
    );
    const triggering = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: { ...fixture.userMessage.data, sequence: 1 },
        itemType: "message" as const,
      }),
    );
    const memory = inMemoryDatabase(
      [fixture.release, fixture.deployment, fixture.thread, earlier, triggering, fixture.run],
      { queryPageSize: 1 },
    );
    const { dependencies } = workerDependencies(memory.database);

    const result = await processAgentRun(
      { ...fixture.queue, userMessageSequence: triggering.data.sequence },
      dependencies,
    );

    expect(result.action).toBe("completed");
    expect(memory.queryInputs.length).toBeGreaterThan(1);
  });

  it("excludes messages after the triggering user message from model context", async () => {
    const fixture = fixtures();
    const future = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.userMessage.data,
          body: "Future message.",
          contentHash: "future-hash",
          id: id(51),
          sequence: 1,
        },
        itemType: "message" as const,
      }),
    );
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      future,
      fixture.run,
    ]);
    const { dependencies } = workerDependencies(memory.database);
    let recentBodies: readonly string[] = [];
    const causalDependencies: AgentRunWorkerDependencies = {
      ...dependencies,
      runtime: {
        generateAssistantMessage: async (request) => {
          recentBodies = request.recentMessages.map((message) => message.content);
          return { assistantMessage: "Causal result." };
        },
      },
    };

    const result = await processAgentRun(fixture.queue, causalDependencies);

    expect(result.action).toBe("completed");
    expect(recentBodies).toEqual([]);
  });

  it("bounds older causal history using the pinned release budget", async () => {
    const fixture = fixtures();
    const release = releaseWithManifest(
      fixture.release,
      manifestWithRuntime(fixture.release.data.manifest, {
        recentMessageCharacterBudget: 25,
      }),
    );
    const earlier = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.userMessage.data,
          body: "Earlier context that should be truncated.",
          contentHash: "earlier-hash",
          id: id(52),
          sequence: 0,
        },
        itemType: "message" as const,
      }),
    );
    const triggering = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: { ...fixture.userMessage.data, sequence: 1 },
        itemType: "message" as const,
      }),
    );
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      earlier,
      triggering,
      fixture.run,
    ]);
    const { dependencies } = workerDependencies(memory.database);
    let recentBodies: readonly string[] = [];
    const boundedDependencies: AgentRunWorkerDependencies = {
      ...dependencies,
      runtime: {
        generateAssistantMessage: async (generationRequest) => {
          recentBodies = generationRequest.recentMessages.map((message) => message.content);
          return { assistantMessage: "Bounded result." };
        },
      },
    };

    const result = await processAgentRun(
      { ...fixture.queue, userMessageSequence: triggering.data.sequence },
      boundedDependencies,
    );

    expect(result.action).toBe("completed");
    expect(recentBodies).toEqual(["Earlier context that shou"]);
    expect(recentBodies.join("").length).toBeLessThanOrEqual(25);
    expect(recentBodies.join(" ")).not.toContain("should be truncated");
  });
});
