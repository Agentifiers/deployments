import {
  MessageRecord,
  RunRecord,
  RuntimeLeaseRecord,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import type { AgentManifestV1, AgentRuntimeToolRequest } from "@deployments-ai/agent-manifest";
import { Schema } from "effect";
import {
  agentRunQueueMessageGroupId,
  processAgentRunQueueDelivery,
  type QueueRecord,
} from "./queue.ts";
import type { AgentRunQueueMessage, AgentRunWorkerDependencies } from "./types.ts";

type AgentRunFixture = ReturnType<typeof import("./agent-run.fixture.ts").fixtures>;

const id = (value: number) => `01ARZ3NDEKTSV4RRFFQ69G${String(value).padStart(4, "0")}` as Ulid;

/** Narrows a fixture run to the deployment/release pins every customer-run fixture carries. */
export function customerRunPins(run: {
  readonly agentDeploymentId?: Ulid | undefined;
  readonly agentReleaseId?: Ulid | undefined;
}): { readonly agentDeploymentId: Ulid; readonly agentReleaseId: Ulid } {
  if (!run.agentDeploymentId || !run.agentReleaseId) {
    throw new Error("Fixture run is not a customer run pinned to a deployment and release.");
  }
  return { agentDeploymentId: run.agentDeploymentId, agentReleaseId: run.agentReleaseId };
}

export function additionalRunOnThread(fixture: AgentRunFixture) {
  const runId = id(60);
  const userMessage = Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: {
        ...fixture.userMessage.data,
        body: "Produce the second answer.",
        contentHash: "second-user-hash",
        id: id(61),
        runId,
        sequence: 2,
      },
      itemType: "message" as const,
    }),
  );
  const run = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...fixture.run.data,
        id: runId,
        idempotencyKey: "run/request-2",
      },
      itemType: "run" as const,
    }),
  );
  const queue: AgentRunQueueMessage = {
    ...fixture.queue,
    idempotencyKey: run.data.idempotencyKey,
    runId,
    userMessageId: userMessage.data.id,
    userMessageSequence: userMessage.data.sequence,
  };
  return { queue, run, userMessage };
}

export function manifestWithTriggers(
  manifest: AgentManifestV1,
  triggers: NonNullable<AgentManifestV1["spec"]["triggers"]>,
): AgentManifestV1 {
  return {
    ...manifest,
    spec: {
      ...manifest.spec,
      triggers,
    },
  };
}

export function manifestWithToolRequests(
  manifest: AgentManifestV1,
  toolRequests: readonly AgentRuntimeToolRequest[],
): AgentManifestV1 {
  const capabilities = new Map(
    (manifest.spec.capabilities?.tools ?? []).map((capability) => [capability.name, capability]),
  );
  for (const request of toolRequests) {
    if (!capabilities.has(request.toolName)) {
      capabilities.set(request.toolName, {
        name: request.toolName,
        required: false,
        requiredScopes: request.requiredScopes,
      });
    }
  }
  return {
    ...manifest,
    spec: {
      ...manifest.spec,
      capabilities: { tools: [...capabilities.values()] },
      runtime: {
        ...manifest.spec.runtime,
        toolRequests,
      },
    },
  };
}

export function abandonedRunWithLease(fixture: AgentRunFixture) {
  const run = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...fixture.run.data,
        attempt: 1,
        claimedAt: "2026-07-22T00:00:00.000Z",
        claimedBy: "worker-abandoned",
        executionSlot: 0,
        heartbeatAt: "2026-07-22T00:00:00.000Z",
        status: "running" as const,
        version: 1,
      },
      itemType: "run" as const,
    }),
  );
  const lease = Schema.decodeUnknownSync(RuntimeLeaseRecord)(
    withCanonicalRecordKeys({
      data: {
        acquiredAt: "2026-07-22T00:00:00.000Z",
        expiresAt: "2026-07-22T00:00:00.050Z",
        id: fixture.thread.data.id,
        leaseKey: `agent-run-thread/${fixture.thread.data.id}`,
        owner: run.data.claimedBy!,
        renewedAt: "2026-07-22T00:00:00.000Z",
        runId: run.data.id,
        threadId: fixture.thread.data.id,
        version: 0,
      },
      itemType: "runtime-lease" as const,
    }),
  );
  return { lease, run };
}

export function fifoQueueRecord(
  message: AgentRunQueueMessage,
  messageId: string,
  receiptHandle: string,
): QueueRecord {
  return {
    body: JSON.stringify(message),
    messageGroupId: agentRunQueueMessageGroupId(message),
    messageId,
    receiptHandle,
  };
}

/**
 * Delivers records the way SQS FIFO does: message groups concurrently, and a group's next record
 * only after the previous one was processed (a record handed back blocks the rest of its group).
 * Returns the IDs of records that were not processed, in delivery order.
 */
export async function processQueueRecords(
  records: readonly QueueRecord[],
  dependencies: AgentRunWorkerDependencies,
): Promise<string[]> {
  const groups = Map.groupBy(
    records,
    (record, index) => record.messageGroupId ?? `ungrouped:${index}`,
  );
  const processed = new Set<string>();
  await Promise.all(
    [...groups.values()].map(async (group) => {
      for (const record of group) {
        if ((await processAgentRunQueueDelivery(record, dependencies)) !== "processed") return;
        processed.add(record.messageId);
      }
    }),
  );
  return records.flatMap((record) => (processed.has(record.messageId) ? [] : [record.messageId]));
}
