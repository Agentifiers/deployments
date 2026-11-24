import type { PlatformRecord } from "@deployments-ai/db";
import {
  agentRunQueueMessageGroupId,
  THREAD_CONTINUITY_RECOVERY_REASON,
  type AgentRunQueueEnqueue,
  type AgentRunQueueMessage,
  type RunRecordValue,
} from "./types.ts";

type MessagePublication = Extract<PlatformRecord, { readonly itemType: "message-publication" }>;

function requiresSettledExternalPublication(run: RunRecordValue) {
  return (
    run.data.trigger === "heartbeat" ||
    run.data.trigger === "schedule" ||
    run.data.responsePublication === "external"
  );
}

function assertReplayableCompletedRun(run: RunRecordValue) {
  if (
    run.data.status !== "completed" ||
    run.data.userMessageId === undefined ||
    run.data.userMessageSequence === undefined
  ) {
    throw new Error("Thread continuity recovery requires a replayable completed run.");
  }
}

function assertRecoveryEligible(run: RunRecordValue, publication?: MessagePublication) {
  assertReplayableCompletedRun(run);
  if (!requiresSettledExternalPublication(run)) return;
  if (
    !publication ||
    (publication.data.status !== "published" && publication.data.status !== "released")
  ) {
    throw new Error("Thread continuity recovery requires a settled external publication.");
  }
  if (
    publication.data.runId !== run.data.id ||
    publication.data.threadId !== run.data.threadId ||
    publication.data.agentDeploymentId !== run.data.agentDeploymentId ||
    publication.data.organizationId !== run.data.organizationId ||
    publication.data.projectId !== run.data.projectId ||
    publication.data.environmentId !== run.data.environmentId
  ) {
    throw new Error("Thread continuity recovery publication scope does not match its run.");
  }
}

export function threadContinuityRecoveryQueueMessage(run: RunRecordValue): AgentRunQueueMessage {
  assertReplayableCompletedRun(run);
  return {
    environmentId: run.data.environmentId,
    idempotencyKey: run.data.idempotencyKey,
    organizationId: run.data.organizationId,
    projectId: run.data.projectId,
    recoveryReason: THREAD_CONTINUITY_RECOVERY_REASON,
    runId: run.data.id,
    spanId: run.data.spanId,
    threadId: run.data.threadId,
    traceId: run.data.traceId,
    userMessageId: run.data.userMessageId!,
    userMessageSequence: run.data.userMessageSequence!,
  };
}

export async function enqueueThreadContinuityRecovery(
  enqueueRun: AgentRunQueueEnqueue,
  run: RunRecordValue,
  publication?: MessagePublication,
  signal?: AbortSignal,
): Promise<void> {
  assertRecoveryEligible(run, publication);
  const message = threadContinuityRecoveryQueueMessage(run);
  await enqueueRun(
    {
      deduplicationId: `${THREAD_CONTINUITY_RECOVERY_REASON}:${run.data.id}:${run.data.version}`,
      message,
      messageGroupId: agentRunQueueMessageGroupId(message),
    },
    signal,
  );
}
