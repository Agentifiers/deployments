import { describe, expect, it } from "bun:test";
import {
  AgentDeploymentRecord,
  ConversationCheckpointRecord,
  MessageRecord,
  RunRecord,
  ThreadRecord,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { processAgentRun } from "./index.ts";
import { boundedRecentMessages } from "./agent-run-input.ts";
import { loadCausalThreadMessages } from "./record-readers.ts";
import type {
  AgentDeploymentRecordValue,
  AgentRunWorkerDependencies,
  RunRecordValue,
  ThreadRecordValue,
} from "./types.ts";
import { fixtures, id, inMemoryDatabase, workerDependencies } from "./agent-run.fixture.ts";

function inheritedCheckpoint(
  fixture: {
    readonly deployment: AgentDeploymentRecordValue;
    readonly run: RunRecordValue;
    readonly thread: ThreadRecordValue;
  },
  predecessorThreadId: Ulid,
  throughSequence: number,
) {
  return Schema.decodeUnknownSync(ConversationCheckpointRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: fixture.deployment.data.id,
        contentHash: "inherited-checkpoint",
        continuedFromCheckpointId: id(1111),
        continuedFromThreadId: predecessorThreadId,
        continuedFromThroughSequence: throughSequence,
        createdAt: fixture.thread.data.createdAt,
        environmentId: fixture.run.data.environmentId,
        fromSequence: 0,
        id: id(1110),
        organizationId: fixture.run.data.organizationId,
        projectId: fixture.run.data.projectId,
        runId: fixture.run.data.id,
        sourceMessageCount: throughSequence + 1,
        summary: "Earlier conversation.",
        threadId: fixture.thread.data.id,
        throughSequence: 0,
      },
      itemType: "conversation-checkpoint" as const,
    }),
  );
}

describe("DynamoDB agent run worker", () => {
  it("fills spare history budget from the predecessor without applying successor sequence offsets", async () => {
    const fixture = fixtures();
    const predecessorThread = Schema.decodeUnknownSync(ThreadRecord)(
      withCanonicalRecordKeys({
        data: { ...fixture.thread.data, id: id(1100) },
        itemType: "thread" as const,
      }),
    );
    const currentThread = Schema.decodeUnknownSync(ThreadRecord)(
      withCanonicalRecordKeys({
        data: { ...fixture.thread.data, continuedFromThreadId: predecessorThread.data.id },
        itemType: "thread" as const,
      }),
    );
    const historyMessage = (
      messageId: Ulid,
      threadId: Ulid,
      sequence: number,
      body: string,
      createdAt = fixture.userMessage.data.createdAt,
    ) =>
      Schema.decodeUnknownSync(MessageRecord)(
        withCanonicalRecordKeys({
          data: { ...fixture.userMessage.data, id: messageId, threadId, sequence, body, createdAt },
          itemType: "message" as const,
        }),
      );
    const older = historyMessage(id(1101), predecessorThread.data.id, 1, "Old.");
    const recent = historyMessage(id(1102), predecessorThread.data.id, 300, "Recent predecessor.");
    const postHandoff = historyMessage(
      id(1103),
      predecessorThread.data.id,
      301,
      "Too late.",
      "2026-07-23T00:00:00.000Z",
    );
    const backdatedPostHandoff = historyMessage(
      id(1109),
      predecessorThread.data.id,
      302,
      "Backdated after handoff.",
    );
    const current = historyMessage(id(1104), currentThread.data.id, 1, "xxCurrent.");
    const trigger = historyMessage(
      fixture.userMessage.data.id,
      currentThread.data.id,
      2,
      "Continue.",
    );
    const future = historyMessage(id(1105), currentThread.data.id, 3, "Future successor turn.");
    const unrelated = historyMessage(id(1106), id(1107), 0, "Unrelated.");
    const checkpoint = Schema.decodeUnknownSync(ConversationCheckpointRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDeploymentId: fixture.deployment.data.id,
          contentHash: "continuity-checkpoint",
          createdAt: trigger.data.createdAt,
          environmentId: fixture.run.data.environmentId,
          fromSequence: 0,
          id: id(1108),
          organizationId: fixture.run.data.organizationId,
          projectId: fixture.run.data.projectId,
          runId: fixture.run.data.id,
          sourceMessageCount: 1,
          summary: "Earlier context.",
          threadId: currentThread.data.id,
          throughMessageCharacterOffset: 2,
          throughSequence: 1,
        },
        itemType: "conversation-checkpoint" as const,
      }),
    );
    const memory = inMemoryDatabase([
      predecessorThread,
      currentThread,
      fixture.deployment,
      older,
      recent,
      postHandoff,
      current,
      trigger,
      future,
      unrelated,
      checkpoint,
      backdatedPostHandoff,
      inheritedCheckpoint(fixture, predecessorThread.data.id, 300),
    ]);
    const queue = { ...fixture.queue, userMessageSequence: trigger.data.sequence };
    const scope = {
      agentDefinitionId: fixture.release.data.agentDefinitionId,
      currentAgentDeploymentId: fixture.deployment.data.id,
      environmentId: queue.environmentId,
      organizationId: queue.organizationId,
      projectId: queue.projectId,
      threadId: queue.threadId,
      ...(currentThread.data.workspaceId ? { workspaceId: currentThread.data.workspaceId } : {}),
    };
    const context = await loadCausalThreadMessages(
      memory.database,
      queue,
      trigger,
      100,
      "auto",
      scope,
    );
    expect(context.checkpoint?.data.id).toBe(checkpoint.data.id);
    expect(context.priorMessages.map((record) => record.data.id)).toEqual([
      older.data.id,
      recent.data.id,
      current.data.id,
    ]);
    const selected = await boundedRecentMessages(
      context.priorMessages,
      100,
      {} as AgentRunWorkerDependencies,
      undefined,
      checkpoint.data,
    );
    expect(selected.map((message) => message.content)).toEqual([
      "Old.",
      "Recent predecessor.",
      "Current.",
    ]);
    const constrained = await loadCausalThreadMessages(
      memory.database,
      queue,
      trigger,
      current.data.body!.length,
      "auto",
      scope,
    );
    expect(constrained.priorMessages.map((record) => record.data.id)).toEqual([current.data.id]);
    const packed = await boundedRecentMessages(
      context.priorMessages,
      "Current.".length,
      {} as AgentRunWorkerDependencies,
      undefined,
      checkpoint.data,
    );
    expect(packed.map((message) => message.content)).toEqual(["Current."]);
  });

  it("retains exact predecessor turns with their trusted timing in a continued thread", async () => {
    const fixture = fixtures();
    const predecessorDeployment = Schema.decodeUnknownSync(AgentDeploymentRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.deployment.data,
          id: id(53),
        },
        itemType: "agent-deployment" as const,
      }),
    );
    const predecessorThread = Schema.decodeUnknownSync(ThreadRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.thread.data,
          agentDeploymentId: predecessorDeployment.data.id,
          id: id(54),
          streamId: id(55),
          title: "Synthetic predecessor",
        },
        itemType: "thread" as const,
      }),
    );
    const currentThread = Schema.decodeUnknownSync(ThreadRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.thread.data,
          continuedFromThreadId: predecessorThread.data.id,
        },
        itemType: "thread" as const,
      }),
    );
    const predecessorMessage = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.userMessage.data,
          agentDeploymentId: predecessorDeployment.data.id,
          body: "A synthetic activity was underway.",
          contentHash: "predecessor-message-hash",
          createdAt: "2026-07-21T00:00:00.000Z",
          id: id(56),
          role: "assistant" as const,
          threadId: predecessorThread.data.id,
        },
        itemType: "message" as const,
      }),
    );
    const run = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.run.data,
          createdAt: "2026-07-22T00:00:00.000Z",
          updatedAt: "2026-07-22T00:00:00.000Z",
        },
        itemType: "run" as const,
      }),
    );
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      predecessorDeployment,
      currentThread,
      predecessorThread,
      predecessorMessage,
      inheritedCheckpoint(fixture, predecessorThread.data.id, predecessorMessage.data.sequence),
      fixture.userMessage,
      run,
    ]);
    const { dependencies } = workerDependencies(memory.database);
    let observed:
      | Parameters<AgentRunWorkerDependencies["runtime"]["generateAssistantMessage"]>[0]
      | undefined;
    const timingDependencies: AgentRunWorkerDependencies = {
      ...dependencies,
      runtime: {
        generateAssistantMessage: async (request) => {
          observed = request;
          return { assistantMessage: "Time-aware synthetic result." };
        },
      },
    };

    const result = await processAgentRun(fixture.queue, timingDependencies);

    expect(result.action).toBe("completed");
    expect(observed?.recentMessages).toEqual([
      expect.objectContaining({
        content: predecessorMessage.data.body,
        createdAt: predecessorMessage.data.createdAt,
        messageId: predecessorMessage.data.id,
        role: "assistant",
      }),
    ]);
    expect(observed?.conversationTimingAnchor).toBeUndefined();
  });
});
