import type { BrainErasure, BrainRepository } from "@deployments-ai/brains";
import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { key } from "../keys.ts";
import { PersistenceError } from "../persistence-types.ts";
import { EXECUTION_QUEUE_SHARD_COUNT } from "../record-key-secondary.ts";
import { BrainErasureJobRecord } from "../records/brain-runtime.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import {
  activeHumanCondition,
  activeMemberCondition,
  activeOrganizationCondition,
  activeOwnerGrantCondition,
} from "./authorization-conditions.ts";
import { brainGrantPlatformRecord, brainPlatformRecord, brainUlid } from "./record-mapping.ts";
import { updateBrainRecordOperations } from "./record-operations.ts";

export type BrainErasureJob = Extract<
  import("../records/index.ts").PlatformRecord,
  { readonly itemType: "brain-erasure-job" }
>;

export function brainErasureFromRecord(record: BrainErasureJob): BrainErasure {
  const data = record.data;
  return {
    brainId: data.brainId,
    ...(data.completedAt ? { completedAt: data.completedAt } : {}),
    ...(data.contentQuiescenceStartedAt
      ? { contentQuiescenceStartedAt: data.contentQuiescenceStartedAt }
      : {}),
    contentVerificationCount: data.contentVerificationCount,
    createdAt: data.createdAt,
    erasureGeneration: data.erasureGeneration,
    ...(data.error ? { error: data.error } : {}),
    ...(data.failedAttempts !== undefined ? { failedAttempts: data.failedAttempts } : {}),
    id: data.id,
    ...(data.leaseExpiresAt ? { leaseExpiresAt: data.leaseExpiresAt } : {}),
    ...(data.leaseOwner ? { leaseOwner: data.leaseOwner } : {}),
    nextDueAt: data.nextDueAt,
    organizationId: data.organizationId,
    phase: data.phase,
    priority: data.priority,
    ...(data.recordsDeleted !== undefined ? { recordsDeleted: data.recordsDeleted } : {}),
    requestedByPrincipalId: data.requestedByPrincipalId,
    ...(data.searchReceipt ? { searchReceipt: data.searchReceipt } : {}),
    ...(data.startedAt ? { startedAt: data.startedAt } : {}),
    status: data.status,
    updatedAt: data.updatedAt,
    version: data.version,
  };
}

export function brainErasureRecord(erasure: BrainErasure) {
  return Schema.decodeUnknownSync(BrainErasureJobRecord)(
    withCanonicalRecordKeys({
      data: { ...erasure },
      itemType: "brain-erasure-job" as const,
    }),
  );
}

/** The first page of due `pending` and `running` Brain erasure jobs per queue shard, oldest due first. */
export async function dueBrainErasureJobs(database: DynamoDatabaseService, now: string) {
  const jobs: BrainErasureJob[] = [];
  for (const status of ["pending", "running"] as const) {
    for (let shard = 0; shard < EXECUTION_QUEUE_SHARD_COUNT; shard += 1) {
      const page = await database.queryRecords("execution", {
        ExpressionAttributeValues: {
          ":due": key("99999999", now, "ZZZZZZZZZZZZZZZZZZZZZZZZZZ"),
          ":pk": key("QUEUE", "BRAIN-ERASURE-JOB", status, String(shard).padStart(2, "0")),
        },
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk AND gsi1sk <= :due",
        Limit: 25,
      });
      jobs.push(
        ...page.items.filter(
          (record): record is BrainErasureJob => record.itemType === "brain-erasure-job",
        ),
      );
    }
  }
  return jobs.toSorted((left, right) => left.data.nextDueAt.localeCompare(right.data.nextDueAt));
}

/** Failed jobs have exhausted their retries and stay in their queue partition until resumed. */
export async function countFailedBrainErasureJobs(database: DynamoDatabaseService) {
  let count = 0;
  for (let shard = 0; shard < EXECUTION_QUEUE_SHARD_COUNT; shard += 1) {
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await database.queryRecords("execution", {
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        ExpressionAttributeValues: {
          ":pk": key("QUEUE", "BRAIN-ERASURE-JOB", "failed", String(shard).padStart(2, "0")),
        },
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
      });
      count += page.items.filter((record) => record.itemType === "brain-erasure-job").length;
      cursor = page.lastEvaluatedKey;
    } while (cursor);
  }
  return count;
}

/**
 * Operator action for a Brain erasure that exhausted its automatic retries: returns it to the
 * due-work queue with a fresh retry budget. The job resumes at its recorded phase and keeps its
 * last error until it completes.
 */
export async function resumeBrainErasure(
  database: DynamoDatabaseService,
  input: {
    readonly brainId: string;
    readonly erasureId: string;
    readonly now: string;
    readonly organizationId: string;
  },
) {
  const current = await database.getRecord(
    "execution",
    {
      pk: key("ORG", input.organizationId, "BRAIN", input.brainId),
      sk: key("BRAIN-ERASURE-JOB", input.erasureId),
    },
    true,
  );
  if (current?.itemType !== "brain-erasure-job" || current.data.brainId !== input.brainId) {
    throw new PersistenceError(
      "not-found",
      "brain_erasure_not_found",
      "The Brain erasure is unavailable.",
    );
  }
  if (current.data.status !== "failed") {
    throw new PersistenceError(
      "conflict",
      "brain_erasure_not_failed",
      `Only a failed Brain erasure can be resumed; this one is ${current.data.status}.`,
    );
  }
  const { failedAttempts: _failedAttempts, ...data } = current.data;
  const resumed = Schema.decodeUnknownSync(BrainErasureJobRecord)(
    withCanonicalRecordKeys({
      ...current,
      data: {
        ...data,
        nextDueAt: input.now,
        status: "pending",
        updatedAt: input.now,
        version: current.data.version + 1,
      },
    }),
  );
  await database.transactWrite([{ kind: "put", previousRecord: current, record: resumed }]);
  return brainErasureFromRecord(resumed);
}

export function makeBrainErasureRepository(
  database: DynamoDatabaseService,
): Pick<BrainRepository, "beginErasure" | "getErasure"> {
  return {
    async beginErasure({ authorizingGrant, brain, erasure, eventId, previous }) {
      if (
        previous.status === "erasing" ||
        brain.status !== "erasing" ||
        brain.version !== previous.version + 1 ||
        erasure.erasureGeneration !== brain.version ||
        erasure.status !== "pending" ||
        erasure.phase !== "draining" ||
        erasure.version !== 0 ||
        erasure.brainId !== brain.id ||
        erasure.organizationId !== brain.organizationId ||
        authorizingGrant.permission !== "owner" ||
        authorizingGrant.status !== "active" ||
        authorizingGrant.target.type !== "principal"
      ) {
        throw new TypeError("Brain erasure requires an active generation-bound owner fence.");
      }
      const previousRecord = brainPlatformRecord(previous);
      const nextRecord = brainPlatformRecord(brain);
      const operation = brainErasureRecord(erasure);
      try {
        await transactWithSemanticEvents(
          database,
          [
            activeOrganizationCondition(brain.organizationId),
            activeHumanCondition(authorizingGrant.target.principalId),
            activeMemberCondition(brain.organizationId, authorizingGrant.target.principalId),
            activeOwnerGrantCondition(brainGrantPlatformRecord(authorizingGrant)),
            // The version-guarded Brain put is the only operation on the Brain item: DynamoDB
            // rejects transactions that target one item twice, and every status change bumps
            // the version, so the put's version fence also fences the observed status.
            ...updateBrainRecordOperations(previousRecord, nextRecord, brain.updatedAt),
            { kind: "put", record: operation },
          ],
          [
            makeSemanticEventRecord({
              actor: { id: brainUlid(erasure.requestedByPrincipalId), type: "principal" },
              aggregateId: brainUlid(brain.id),
              aggregateType: "brain",
              aggregateVersion: brain.version + 1,
              eventId: brainUlid(eventId),
              eventType: "brain.erasure-requested",
              occurredAt: brain.updatedAt,
              organizationId: brainUlid(brain.organizationId),
              payload: {
                brainId: brain.id,
                erasureGeneration: erasure.erasureGeneration,
                erasureId: erasure.id,
                status: brain.status,
              },
            }),
          ],
          eventId,
        );
      } catch (cause) {
        if (!isDatabaseWriteConflict(cause)) throw cause;
        throw new PersistenceError(
          "conflict",
          "brain_erasure_conflict",
          "The Brain, its owner grant, or its organization changed before erasure could start.",
        );
      }
      return brainErasureFromRecord(operation);
    },

    async getErasure(organizationId, brainId, erasureId) {
      const value = await database.getRecord(
        "execution",
        {
          pk: key("ORG", organizationId, "BRAIN", brainId),
          sk: key("BRAIN-ERASURE-JOB", erasureId),
        },
        true,
      );
      return value?.itemType === "brain-erasure-job" && value.data.brainId === brainId
        ? brainErasureFromRecord(value)
        : undefined;
    },
  };
}
