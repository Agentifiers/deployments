import {
  AgentDeploymentRecord,
  ConversationCheckpointRecord,
  MessageRecord,
  MessagePublicationRecord,
  RunRecord,
  RunLookupRecord,
  ThreadRecord,
  transientConversationMessageMetadata,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  deployment,
  environmentId,
  ids,
  memoryDatabase,
  now,
  organizationId,
  principal,
  projectId,
  serviceAccountId,
} from "./runtime-lifecycle.fixture.ts";
import { createThread } from "./runtime-listing.ts";
import type { RuntimeApiDependencies } from "./runtime-support.ts";

const predecessorDeploymentId = ids[20]!;
const predecessorThreadId = ids[21]!;
const predecessorCheckpointId = ids[22]!;
const predecessorRunId = ids[23]!;

function predecessorDeployment(agentDefinitionId = deployment().data.agentDefinitionId) {
  return Schema.decodeUnknownSync(AgentDeploymentRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId,
        agentReleaseId: ids[24]!,
        createdAt: now.toISOString(),
        currentState: "stopped" as const,
        desiredState: "stopped" as const,
        environmentId,
        id: predecessorDeploymentId,
        organizationId,
        projectId,
        updatedAt: now.toISOString(),
        version: 3,
      },
      itemType: "agent-deployment" as const,
    }),
  );
}

function predecessorThread(
  options: { readonly version?: number; readonly workspaceId?: Ulid } = {},
) {
  return Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: predecessorDeploymentId,
        archived: false,
        channel: "api",
        createdAt: now.toISOString(),
        createdBy: { id: serviceAccountId, type: "service-account" as const },
        environmentId,
        id: predecessorThreadId,
        organizationId,
        pinned: false,
        projectId,
        streamId: ids[25]!,
        title: "Prior release conversation",
        updatedAt: now.toISOString(),
        version: options.version ?? 18,
        ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      },
      itemType: "thread" as const,
    }),
  );
}

function predecessorCheckpoint(throughSequence = 18) {
  return Schema.decodeUnknownSync(ConversationCheckpointRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: predecessorDeploymentId,
        contentHash: "a".repeat(64),
        createdAt: now.toISOString(),
        environmentId,
        fromMessageCreatedAt: "2026-07-20T23:00:00.000Z",
        fromSequence: 0,
        id: predecessorCheckpointId,
        organizationId,
        projectId,
        runId: predecessorRunId,
        sourceMessageCount: 18,
        summary: "A compact, non-sensitive continuity summary.",
        threadId: predecessorThreadId,
        throughMessageCreatedAt: "2026-07-21T00:00:00.000Z",
        throughSequence,
      },
      itemType: "conversation-checkpoint" as const,
    }),
  );
}

function predecessorMessage(sequence: number, transient = false) {
  return Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: predecessorDeploymentId,
        body: "Neutral continuity fixture.",
        contentHash: "b".repeat(64),
        createdAt: now.toISOString(),
        environmentId,
        id: ids[27]!,
        ...(transient ? { metadata: transientConversationMessageMetadata() } : {}),
        organizationId,
        projectId,
        role: "assistant" as const,
        sequence,
        threadId: predecessorThreadId,
      },
      itemType: "message" as const,
    }),
  );
}

function completedPredecessorRun(sequence: number) {
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: predecessorDeploymentId,
        agentReleaseId: ids[24]!,
        attempt: 1,
        captureMode: "metadata-only" as const,
        completedAt: now.toISOString(),
        createdAt: now.toISOString(),
        environmentId,
        executor: "hosted",
        id: ids[28]!,
        idempotencyKey: "continuity-recovery-run",
        organizationId,
        priority: 50,
        projectId,
        redactionPolicyVersion: 1 as const,
        responsePublication: "external" as const,
        schemaVersion: 1 as const,
        spanId: "0123456789abcdef",
        status: "completed" as const,
        threadId: predecessorThreadId,
        traceId: "0123456789abcdef0123456789abcdef",
        trigger: "chat",
        updatedAt: now.toISOString(),
        userMessageId: ids[27]!,
        userMessageSequence: sequence,
        version: 2,
      },
      itemType: "run" as const,
    }),
  );
}

function settledPredecessorPublication(run: ReturnType<typeof completedPredecessorRun>) {
  return Schema.decodeUnknownSync(MessagePublicationRecord)(
    withCanonicalRecordKeys({
      data: {
        actor: { id: serviceAccountId, type: "service-account" as const },
        agentDeploymentId: predecessorDeploymentId,
        commandHash: "c".repeat(64),
        createdAt: now.toISOString(),
        deliveredContentHash: "d".repeat(64),
        environmentId,
        id: ids[29]!,
        messageId: ids[30]!,
        messageSequence: 20,
        organizationId,
        projectId,
        publishedAt: now.toISOString(),
        runId: run.data.id,
        safeContentHash: "e".repeat(64),
        sourceMessageId: ids[30]!,
        sourceMessageSequence: 20,
        status: "published" as const,
        streamEventId: ids[31]!,
        threadId: predecessorThreadId,
        updatedAt: now.toISOString(),
        version: 2,
      },
      itemType: "message-publication" as const,
    }),
  );
}

function predecessorRunLookup(run: ReturnType<typeof completedPredecessorRun>) {
  return Schema.decodeUnknownSync(RunLookupRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: now.toISOString(),
        environmentId,
        idempotencyKey: run.data.idempotencyKey,
        organizationId,
        projectId,
        runId: run.data.id,
        threadId: predecessorThreadId,
      },
      itemType: "run-lookup" as const,
    }),
  );
}

function dependencies(
  seed: Parameters<typeof memoryDatabase>[0],
  enqueueRun: RuntimeApiDependencies["enqueueRun"] = async () => undefined,
) {
  const memory = memoryDatabase(seed);
  const generated = [ids[7]!, ids[8]!, ids[9]!, ids[10]!];
  return {
    dependencies: {
      database: memory.database,
      enqueueRun,
      generateId: async () => generated.shift()!,
      now: () => now,
    } as unknown as RuntimeApiDependencies,
    memory,
  };
}

describe("thread release continuity", () => {
  test("creates a deployment-owned successor with the complete predecessor checkpoint", async () => {
    const previousDeployment = predecessorDeployment();
    const previousThread = predecessorThread();
    const previousCheckpoint = predecessorCheckpoint();
    const { dependencies: runtime, memory } = dependencies([
      deployment(),
      previousDeployment,
      previousThread,
      previousCheckpoint,
    ]);

    const result = await createThread(runtime, principal(), {
      agentDeploymentId: deployment().data.id,
      continueFromThreadId: predecessorThreadId,
      title: "Current release conversation",
    });

    expect(result).toMatchObject({
      agentDeploymentId: deployment().data.id,
      continuedFromThreadId: predecessorThreadId,
      id: ids[7],
      version: 0,
    });
    const copiedCheckpoint = [...memory.records.values()].find(
      (record) => record.itemType === "conversation-checkpoint" && record.data.threadId === ids[7],
    );
    expect(copiedCheckpoint?.data).toMatchObject({
      agentDeploymentId: deployment().data.id,
      continuedFromCheckpointId: predecessorCheckpointId,
      continuedFromThreadId: predecessorThreadId,
      fromMessageCreatedAt: "2026-07-20T23:00:00.000Z",
      fromSequence: 0,
      runId: predecessorRunId,
      sourceMessageCount: 18,
      summary: previousCheckpoint.data.summary,
      throughMessageCreatedAt: "2026-07-21T00:00:00.000Z",
      throughSequence: 0,
    });
    expect(memory.transactions[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conditionExpression: expect.stringContaining("#version = :version"),
          key: { pk: previousThread.pk, sk: previousThread.sk },
          table: "execution",
        }),
      ]),
    );
    const event = [...memory.records.values()].find(
      (record) =>
        record.itemType === "semantic-event" && record.data.eventType === "thread.created",
    );
    expect(event?.itemType).toBe("semantic-event");
    if (event?.itemType !== "semantic-event") throw new Error("Thread event was not persisted.");
    expect(event.data.payload).toMatchObject({
      continuedFromCheckpointId: predecessorCheckpointId,
      continuedFromThreadId: predecessorThreadId,
    });
  });

  test("rejects a predecessor owned by another agent definition", async () => {
    const { dependencies: runtime } = dependencies([
      deployment(),
      predecessorDeployment(ids[26]!),
      predecessorThread(),
      predecessorCheckpoint(),
    ]);

    expect(
      createThread(runtime, principal(), {
        agentDeploymentId: deployment().data.id,
        continueFromThreadId: predecessorThreadId,
      }),
    ).rejects.toMatchObject({ code: "thread_continuity_mismatch", status: 409 });
  });

  test("rejects a predecessor whose checkpoint does not cover its latest message", async () => {
    const { dependencies: runtime } = dependencies([
      deployment(),
      predecessorDeployment(),
      predecessorThread({ version: 19 }),
      predecessorCheckpoint(18),
      predecessorMessage(19),
    ]);

    expect(
      createThread(runtime, principal(), {
        agentDeploymentId: deployment().data.id,
        continueFromThreadId: predecessorThreadId,
      }),
    ).rejects.toMatchObject({ code: "thread_continuity_incomplete", status: 409 });
  });

  test("queues recoverable completed runs before rejecting incomplete continuity", async () => {
    const run = completedPredecessorRun(19);
    const message = {
      ...predecessorMessage(19),
      data: {
        ...predecessorMessage(19).data,
        id: ids[27]!,
        role: "user" as const,
        runId: run.data.id,
      },
    };
    const enqueued: Parameters<RuntimeApiDependencies["enqueueRun"]>[0][] = [];
    const { dependencies: runtime } = dependencies(
      [
        deployment(),
        predecessorDeployment(),
        predecessorThread({ version: 19 }),
        predecessorCheckpoint(18),
        message,
        run,
        predecessorRunLookup(run),
        settledPredecessorPublication(run),
      ],
      async (input) => void enqueued.push(input),
    );

    expect(
      createThread(runtime, principal(), {
        agentDeploymentId: deployment().data.id,
        continueFromThreadId: predecessorThreadId,
      }),
    ).rejects.toMatchObject({ code: "thread_continuity_incomplete", status: 409 });

    expect(enqueued).toEqual([
      {
        deduplicationId: `thread-continuity-recovery:${run.data.id}:${run.data.version}`,
        message: {
          environmentId,
          idempotencyKey: run.data.idempotencyKey,
          organizationId,
          projectId,
          recoveryReason: "thread-continuity-recovery",
          runId: run.data.id,
          spanId: run.data.spanId,
          threadId: predecessorThreadId,
          traceId: run.data.traceId,
          userMessageId: run.data.userMessageId!,
          userMessageSequence: 19,
        },
        messageGroupId: `${organizationId}:${projectId}:${environmentId}:${predecessorThreadId}`,
      },
    ]);
  });

  test("continues when only transient messages follow the complete checkpoint", async () => {
    const { dependencies: runtime } = dependencies([
      deployment(),
      predecessorDeployment(),
      predecessorThread({ version: 19 }),
      predecessorCheckpoint(18),
      predecessorMessage(19, true),
    ]);

    expect(
      createThread(runtime, principal(), {
        agentDeploymentId: deployment().data.id,
        continueFromThreadId: predecessorThreadId,
      }),
    ).resolves.toMatchObject({ continuedFromThreadId: predecessorThreadId });
  });
});
