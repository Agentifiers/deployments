import type { PlatformRecord } from "@deployments-ai/db";
import {
  agentRunQueueMessageGroupId,
  EXTERNAL_PUBLICATION_SETTLED_RECOVERY_REASON,
  type AgentRunQueueEnqueue,
  type AgentRunQueueMessage,
  type RunRecordValue,
} from "./types.ts";

type MessagePublication = Extract<PlatformRecord, { readonly itemType: "message-publication" }>;

export function externalPublicationRecoveryQueueMessage(run: RunRecordValue): AgentRunQueueMessage {
  if (run.data.userMessageId === undefined || run.data.userMessageSequence === undefined) {
    throw new Error("External publication recovery requires the run trigger message binding.");
  }
  return {
    environmentId: run.data.environmentId,
    idempotencyKey: run.data.idempotencyKey,
    organizationId: run.data.organizationId,
    projectId: run.data.projectId,
    recoveryReason: EXTERNAL_PUBLICATION_SETTLED_RECOVERY_REASON,
    runId: run.data.id,
    spanId: run.data.spanId,
    threadId: run.data.threadId,
    traceId: run.data.traceId,
    userMessageId: run.data.userMessageId,
    userMessageSequence: run.data.userMessageSequence,
  };
}

function assertSettledPublication(run: RunRecordValue, publication: MessagePublication) {
  if (publication.data.status !== "published" && publication.data.status !== "released") {
    throw new Error(
      "External publication recovery requires a publication that must be published or released.",
    );
  }
  if (
    run.data.status !== "completed" ||
    (run.data.trigger !== "heartbeat" &&
      run.data.trigger !== "schedule" &&
      run.data.responsePublication !== "external")
  ) {
    throw new Error("External publication recovery requires an eligible completed run.");
  }
  if (
    publication.data.runId !== run.data.id ||
    publication.data.threadId !== run.data.threadId ||
    publication.data.agentDeploymentId !== run.data.agentDeploymentId ||
    publication.data.organizationId !== run.data.organizationId ||
    publication.data.projectId !== run.data.projectId ||
    publication.data.environmentId !== run.data.environmentId
  ) {
    throw new Error("External publication recovery scope does not match its completed run.");
  }
}

export async function enqueueExternalPublicationSettledRecovery(
  enqueueRun: AgentRunQueueEnqueue,
  run: RunRecordValue,
  publication: MessagePublication,
  signal?: AbortSignal,
): Promise<void> {
  assertSettledPublication(run, publication);
  const message = externalPublicationRecoveryQueueMessage(run);
  await enqueueRun(
    {
      deduplicationId: `${EXTERNAL_PUBLICATION_SETTLED_RECOVERY_REASON}:${publication.data.id}:${publication.data.version}`,
      message,
      messageGroupId: agentRunQueueMessageGroupId(message),
    },
    signal,
  );
}
