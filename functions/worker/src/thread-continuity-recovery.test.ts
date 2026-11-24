import { describe, expect, test } from "bun:test";
import type { PlatformRecord } from "@deployments-ai/db";
import { fixtures } from "./agent-run.fixture.ts";
import {
  enqueueThreadContinuityRecovery,
  threadContinuityRecoveryQueueMessage,
} from "./thread-continuity-recovery.ts";
import { agentRunQueueMessageGroupId, type AgentRunQueueEnqueueInput } from "./types.ts";

function completedRun(external = true) {
  const fixture = fixtures();
  return {
    ...fixture.run,
    data: {
      ...fixture.run.data,
      completedAt: "2026-09-05T00:00:00.000Z",
      ...(external ? { responsePublication: "external" as const } : {}),
      status: "completed" as const,
      userMessageId: fixture.queue.userMessageId,
      userMessageSequence: fixture.queue.userMessageSequence,
    },
  } as Extract<PlatformRecord, { readonly itemType: "run" }>;
}

function settledPublication(run: ReturnType<typeof completedRun>) {
  return {
    data: {
      agentDeploymentId: run.data.agentDeploymentId,
      environmentId: run.data.environmentId,
      id: "01J00000000000000000000030",
      organizationId: run.data.organizationId,
      projectId: run.data.projectId,
      runId: run.data.id,
      status: "published" as const,
      threadId: run.data.threadId,
      version: 2,
    },
    itemType: "message-publication" as const,
  } as Extract<PlatformRecord, { readonly itemType: "message-publication" }>;
}

describe("thread continuity checkpoint recovery", () => {
  test("queues a deterministic completed-run recovery after external delivery settles", async () => {
    const enqueued: AgentRunQueueEnqueueInput[] = [];
    const run = completedRun();

    await enqueueThreadContinuityRecovery(
      async (input) => void enqueued.push(input),
      run,
      settledPublication(run),
    );

    const message = threadContinuityRecoveryQueueMessage(run);
    expect(enqueued).toEqual([
      {
        deduplicationId: `thread-continuity-recovery:${run.data.id}:${run.data.version}`,
        message,
        messageGroupId: agentRunQueueMessageGroupId(message),
      },
    ]);
    expect(message.recoveryReason).toBe("thread-continuity-recovery");
  });

  test("rejects external recovery before its publication settles", async () => {
    expect(enqueueThreadContinuityRecovery(async () => undefined, completedRun())).rejects.toThrow(
      "requires a settled external publication",
    );
  });

  test("does not require a publication for an ordinary completed run", async () => {
    const enqueued: AgentRunQueueEnqueueInput[] = [];
    await enqueueThreadContinuityRecovery(
      async (input) => void enqueued.push(input),
      completedRun(false),
    );

    expect(enqueued).toHaveLength(1);
  });
});
