import {
  MessageRecord,
  RunRecord,
  ThreadRecord,
  transientConversationMessageMetadata,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import {
  environmentId,
  ids,
  memoryDatabase,
  now,
  organizationId,
  projectId,
} from "./conversation-control.fixture.ts";
import { readConversationHistory } from "./index.ts";

export const threadId = ids[30]!;
export const runId = ids[32]!;
export const sourceMessageId = ids[33]!;

export function fixture(trigger: "api" | "heartbeat" | "schedule" = "heartbeat") {
  const thread = Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: ids[6]!,
        archived: false,
        channel: "telegram",
        createdAt: now.toISOString(),
        createdBy: { type: "system" as const },
        environmentId,
        id: threadId,
        organizationId,
        pinned: false,
        projectId,
        streamId: ids[31]!,
        title: "Proactive conversation",
        updatedAt: now.toISOString(),
        version: 5,
      },
      itemType: "thread" as const,
    }),
  );
  const run = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: ids[6]!,
        agentReleaseId: ids[5]!,
        attempt: 0,
        captureMode: "metadata-only" as const,
        completedAt: now.toISOString(),
        createdAt: now.toISOString(),
        environmentId,
        executor: "hosted",
        id: runId,
        idempotencyKey: "automation-run",
        organizationId,
        priority: 50,
        projectId,
        redactionPolicyVersion: 1 as const,
        schemaVersion: 1 as const,
        spanId: "0123456789abcdef",
        status: "completed" as const,
        threadId,
        traceId: "0123456789abcdef0123456789abcdef",
        trigger,
        updatedAt: now.toISOString(),
        version: 2,
      },
      itemType: "run" as const,
    }),
  );
  const sourceMessage = Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: ids[6]!,
        body: "thought i'd check in. wyd?",
        contentHash: createHash("sha256").update("thought i'd check in. wyd?").digest("hex"),
        createdAt: now.toISOString(),
        environmentId,
        id: sourceMessageId,
        metadata: transientConversationMessageMetadata(),
        organizationId,
        projectId,
        role: "assistant" as const,
        runId,
        sequence: 5,
        streamEventId: ids[34]!,
        threadId,
      },
      itemType: "message" as const,
    }),
  );
  return { run, sourceMessage, thread };
}

export function externalFixture() {
  const records = fixture("api");
  return {
    ...records,
    run: Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...records.run,
        data: {
          ...records.run.data,
          responsePublication: "external",
          userMessageId: ids[35]!,
          userMessageSequence: 4,
        },
      }),
    ),
  };
}

export function newerUserMessage(records: ReturnType<typeof externalFixture>) {
  return Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: records.run.data.agentDeploymentId,
        body: "One more detail.",
        contentHash: createHash("sha256").update("One more detail.").digest("hex"),
        createdAt: now.toISOString(),
        environmentId,
        id: ids[36]!,
        organizationId,
        projectId,
        role: "user" as const,
        runId: ids[37]!,
        sequence: 6,
        streamEventId: ids[38]!,
        threadId,
      },
      itemType: "message" as const,
    }),
  );
}

type Memory = ReturnType<typeof memoryDatabase>;

export function recordOfType<ItemType extends PlatformRecord["itemType"]>(
  memory: Memory,
  itemType: ItemType,
): Extract<PlatformRecord, { readonly itemType: ItemType }> | undefined {
  return [...memory.records.values()].find(
    (record): record is Extract<PlatformRecord, { readonly itemType: ItemType }> =>
      record.itemType === itemType,
  );
}

export function currentThread(memory: Memory) {
  const thread = recordOfType(memory, "thread");
  if (!thread) throw new Error("Thread was not persisted.");
  return thread;
}

export function put(memory: Memory, ...records: readonly PlatformRecord[]) {
  for (const record of records) memory.put(record);
}

export function input(records: ReturnType<typeof fixture>, content = "thought i'd check in. wyd?") {
  return {
    actor: { id: ids[7]!, type: "service-account" as const },
    content,
    idempotencyKey: `delivered-automation:${records.run.data.id}`,
    ...records,
  };
}

export async function history(memory: Memory) {
  return readConversationHistory(memory.database, {
    environmentId,
    organizationId,
    projectId,
    threadId,
  });
}
