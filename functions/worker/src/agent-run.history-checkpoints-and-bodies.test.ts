import { describe, expect, it } from "bun:test";
import {
  ConversationCheckpointRecord,
  MessageRecord,
  RunRecord,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { processAgentRun } from "./index.ts";
import type { AgentRunWorkerDependencies } from "./types.ts";
import {
  fixtures,
  id,
  inMemoryDatabase,
  manifestWithRuntime,
  releaseWithManifest,
  workerDependencies,
} from "./agent-run.fixture.ts";

describe("DynamoDB agent run worker", () => {
  it("injects an opted-in durable checkpoint and non-replayable run context", async () => {
    const fixture = fixtures();
    const release = releaseWithManifest(
      fixture.release,
      manifestWithRuntime(fixture.release.data.manifest, {
        contextCheckpointMode: "auto",
        modelInputTokenBudget: 8_192,
        modelOutputTokenReserve: 512,
        modelToolProtocol: "gemma4",
      }),
    );
    const earlier = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.userMessage.data,
          body: "Earlier raw exchange.",
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
    const checkpoint = Schema.decodeUnknownSync(ConversationCheckpointRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDeploymentId: fixture.deployment.data.id,
          contentHash: "checkpoint-hash",
          createdAt: fixture.userMessage.data.createdAt,
          environmentId: fixture.run.data.environmentId,
          fromMessageCreatedAt: "2026-07-21T00:00:00.000Z",
          fromSequence: 0,
          id: id(72),
          organizationId: fixture.run.data.organizationId,
          projectId: fixture.run.data.projectId,
          runId: fixture.run.data.id,
          sourceMessageCount: 1,
          summary: "The user prefers concise answers and has an interview tomorrow.",
          threadId: fixture.run.data.threadId,
          throughMessageCharacterOffset: 8,
          throughMessageCreatedAt: "2026-07-21T00:05:00.000Z",
          throughSequence: 0,
        },
        itemType: "conversation-checkpoint" as const,
      }),
    );
    const run = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...fixture.run,
        data: { ...fixture.run.data, runContext: "Current structured workflow state." },
      }),
    );
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      earlier,
      triggering,
      checkpoint,
      run,
    ]);
    const { dependencies } = workerDependencies(memory.database);
    let observed:
      | Parameters<AgentRunWorkerDependencies["runtime"]["generateAssistantMessage"]>[0]
      | undefined;
    const checkpointDependencies: AgentRunWorkerDependencies = {
      ...dependencies,
      runtime: {
        generateAssistantMessage: async (request) => {
          observed = request;
          return { assistantMessage: "Checkpointed result." };
        },
      },
    };

    const result = await processAgentRun(
      { ...fixture.queue, userMessageSequence: triggering.data.sequence },
      checkpointDependencies,
    );

    expect(result.action).toBe("completed");
    expect(observed).toMatchObject({
      conversationCheckpoint: {
        fromMessageCreatedAt: "2026-07-21T00:00:00.000Z",
        fromSequence: 0,
        sourceMessageCount: 1,
        summary: "The user prefers concise answers and has an interview tomorrow.",
        throughMessageCharacterOffset: 8,
        throughMessageCreatedAt: "2026-07-21T00:05:00.000Z",
        throughSequence: 0,
      },
      historySelection: { availableMessages: 1, selectedMessages: 1 },
      modelInputTokenBudget: 8_192,
      modelOutputTokenReserve: 512,
      modelToolProtocol: "gemma4",
      promptCreatedAt: run.data.createdAt,
      runContext: "Current structured workflow state.",
    });
    expect(observed?.recentMessages).toEqual([
      expect.objectContaining({ content: "raw exchange.", sequence: 0 }),
    ]);
  });

  it("keeps the newest exact turns when a rolling checkpoint already covers them", async () => {
    const fixture = fixtures();
    const release = releaseWithManifest(
      fixture.release,
      manifestWithRuntime(fixture.release.data.manifest, {
        contextCheckpointMode: "auto",
      }),
    );
    const earlierUser = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.userMessage.data,
          body: "The package is inside the blue cabinet.",
          contentHash: "earlier-user-hash",
          id: id(73),
          sequence: 0,
        },
        itemType: "message" as const,
      }),
    );
    const earlierAssistant = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.userMessage.data,
          body: "Got it, the blue cabinet.",
          contentHash: "earlier-assistant-hash",
          id: id(74),
          role: "assistant" as const,
          sequence: 1,
        },
        itemType: "message" as const,
      }),
    );
    const triggering = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.userMessage.data,
          body: "Where did I say it was?",
          contentHash: "triggering-hash",
          sequence: 2,
        },
        itemType: "message" as const,
      }),
    );
    const checkpoint = Schema.decodeUnknownSync(ConversationCheckpointRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDeploymentId: fixture.deployment.data.id,
          contentHash: "checkpoint-hash",
          createdAt: fixture.userMessage.data.createdAt,
          environmentId: fixture.run.data.environmentId,
          fromSequence: 0,
          id: id(75),
          organizationId: fixture.run.data.organizationId,
          projectId: fixture.run.data.projectId,
          runId: fixture.run.data.id,
          sourceMessageCount: 2,
          summary: "The user and assistant discussed a package.",
          threadId: fixture.run.data.threadId,
          throughSequence: 1,
        },
        itemType: "conversation-checkpoint" as const,
      }),
    );
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      earlierUser,
      earlierAssistant,
      triggering,
      checkpoint,
      fixture.run,
    ]);
    const { dependencies } = workerDependencies(memory.database);
    let observed:
      | Parameters<AgentRunWorkerDependencies["runtime"]["generateAssistantMessage"]>[0]
      | undefined;
    const checkpointDependencies: AgentRunWorkerDependencies = {
      ...dependencies,
      runtime: {
        generateAssistantMessage: async (request) => {
          observed = request;
          return { assistantMessage: "It was in the blue cabinet." };
        },
      },
    };

    expect(
      processAgentRun(
        { ...fixture.queue, userMessageSequence: triggering.data.sequence },
        checkpointDependencies,
      ),
    ).resolves.toMatchObject({ action: "completed" });

    expect(observed?.conversationCheckpoint).toMatchObject({ throughSequence: 1 });
    expect(observed?.historySelection).toMatchObject({
      availableMessages: 2,
      selectedMessages: 2,
    });
    expect(observed?.recentMessages).toEqual([
      expect.objectContaining({ content: "The package is inside the blue cabinet.", sequence: 0 }),
      expect.objectContaining({ content: "Got it, the blue cabinet.", sequence: 1 }),
    ]);
  });

  it("materializes S3-backed prompt and causal history bodies before model generation", async () => {
    const fixture = fixtures();
    const release = releaseWithManifest(
      fixture.release,
      manifestWithRuntime(fixture.release.data.manifest, {
        recentMessageCharacterBudget: 2,
      }),
    );
    const { body: _promptBody, ...promptData } = fixture.userMessage.data;
    const triggering = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...promptData,
          bodyRef: {
            bucket: "message-bodies",
            byteSize: 19,
            contentType: "text/plain",
            key: "prompt",
            sha256: "a".repeat(64),
          },
          contentHash: "a".repeat(64),
          sequence: 1,
        },
        itemType: "message" as const,
      }),
    );
    const earlier = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...promptData,
          bodyRef: {
            bucket: "message-bodies",
            byteSize: 6,
            contentType: "text/plain",
            key: "history",
            sha256: "b".repeat(64),
          },
          contentHash: "b".repeat(64),
          id: id(53),
          role: "assistant" as const,
          runId: id(54),
          sequence: 0,
        },
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
    const reads: Ulid[] = [];
    let prompt = "";
    let recentBodies: readonly string[] = [];
    const blobDependencies: AgentRunWorkerDependencies = {
      ...dependencies,
      readMessageBody: async (message, signal) => {
        expect(signal?.aborted).toBe(false);
        reads.push(message.data.id);
        return message.data.id === triggering.data.id ? "Blob-backed prompt." : "漢字";
      },
      runtime: {
        generateAssistantMessage: async (request) => {
          prompt = request.prompt;
          recentBodies = request.recentMessages.map((message) => message.content);
          return { assistantMessage: "Blob-backed result." };
        },
      },
    };

    const result = await processAgentRun(
      { ...fixture.queue, userMessageSequence: triggering.data.sequence },
      blobDependencies,
    );

    expect(result.action).toBe("completed");
    expect(prompt).toBe("Blob-backed prompt.");
    expect(recentBodies).toEqual(["漢字"]);
    expect(reads).toEqual([triggering.data.id, earlier.data.id]);
  });
});
