import { describe, expect, test } from "bun:test";
import {
  MessageRecord,
  RunRecord,
  TimelineEventRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { loadFinalizedRunMessage } from "./run-message-read.ts";
import { type RuntimeApiDependencies, type RuntimeApiPrincipal } from "./runtime-support.ts";

const ids = Array.from(
  { length: 10 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}`,
) as Ulid[];
const [environmentId, organizationId, projectId, threadId, runId, messageId] = ids as [
  Ulid,
  Ulid,
  Ulid,
  Ulid,
  Ulid,
  Ulid,
];
const timestamp = "2026-08-10T12:00:00.000Z";

function completedRun(status: "completed" | "running" = "completed") {
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: ids[6]!,
        agentReleaseId: ids[7]!,
        attempt: 0,
        captureMode: "metadata-only" as const,
        ...(status === "completed" ? { completedAt: timestamp } : {}),
        createdAt: timestamp,
        environmentId,
        executor: "hosted",
        id: runId,
        idempotencyKey: "run-message-test",
        organizationId,
        priority: 50,
        projectId,
        redactionPolicyVersion: 1 as const,
        schemaVersion: 1 as const,
        spanId: "0123456789abcdef",
        status,
        threadId,
        traceId: "0123456789abcdef0123456789abcdef",
        trigger: "schedule",
        updatedAt: timestamp,
        version: 2,
      },
      itemType: "run" as const,
    }),
  );
}

function finalizedMessage() {
  return Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: ids[6]!,
        body: "hey you",
        contentHash: "a".repeat(64),
        createdAt: timestamp,
        environmentId,
        id: messageId,
        organizationId,
        projectId,
        role: "assistant" as const,
        runId,
        sequence: 4,
        threadId,
      },
      itemType: "message" as const,
    }),
  );
}

function completionTimeline() {
  return Schema.decodeUnknownSync(TimelineEventRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        data: { messageId, messageSequence: 4 },
        environmentId,
        eventType: "run.completed",
        id: ids[8]!,
        organizationId,
        projectId,
        runId,
        sequence: 2,
        threadId,
      },
      itemType: "timeline-event" as const,
    }),
  );
}

function principal(): RuntimeApiPrincipal {
  return {
    credential: { data: { scopes: ["runs:read"] } },
    scope: { environmentId, organizationId, projectId },
    serviceAccount: { data: { scopes: ["runs:read"] } },
  } as unknown as RuntimeApiPrincipal;
}

function dependencies(seed: readonly PlatformRecord[]): RuntimeApiDependencies {
  const records = new Map(seed.map((record) => [`${record.pk}\n${record.sk}`, record]));
  const database = {
    getRecord: (
      _table: Parameters<DynamoDatabaseService["getRecord"]>[0],
      key: Parameters<DynamoDatabaseService["getRecord"]>[1],
    ) => {
      const record = records.get(`${key.pk}\n${key.sk}`);
      return Promise.resolve(record);
    },
    queryRecords: (
      _table: Parameters<DynamoDatabaseService["queryRecords"]>[0],
      input: Parameters<DynamoDatabaseService["queryRecords"]>[1],
    ) => {
      const values = input.ExpressionAttributeValues ?? {};
      const partition = values[":pk"];
      const prefix = values[":prefix"];
      return Promise.resolve({
        items: seed.filter(
          (record) =>
            record.pk === partition && (typeof prefix !== "string" || record.sk.startsWith(prefix)),
        ),
      });
    },
  } as unknown as DynamoDatabaseService;
  return { database } as unknown as RuntimeApiDependencies;
}

describe("finalized run message lookup", () => {
  test("loads the canonical assistant message directly from completion evidence", async () => {
    const message = finalizedMessage();
    expect(
      loadFinalizedRunMessage(
        dependencies([completionTimeline(), message]),
        principal(),
        completedRun(),
      ),
    ).resolves.toEqual(message);
  });

  test("rejects a run before it is completed", async () => {
    expect(
      loadFinalizedRunMessage(dependencies([]), principal(), completedRun("running")),
    ).rejects.toMatchObject({ code: "run_not_completed", status: 409 });
  });

  test("rejects a message that does not match completion evidence", async () => {
    const mismatched = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        ...finalizedMessage(),
        data: { ...finalizedMessage().data, runId: ids[9]! },
      }),
    );
    expect(
      loadFinalizedRunMessage(
        dependencies([completionTimeline(), mismatched]),
        principal(),
        completedRun(),
      ),
    ).rejects.toMatchObject({ code: "run_message_mismatch", status: 409 });
  });
});
