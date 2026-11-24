import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { key } from "../keys.ts";
import { BrainIndexJobRecord } from "../records/brain-runtime.ts";
import { BrainIndexStateRecord } from "../records/brain-search.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import { getBrainIndexState } from "./index-suppression.ts";

export type BrainIndexJob = Extract<PlatformRecord, { readonly itemType: "brain-index-job" }>;

/** Claims a failing Brain index job may consume before it fails terminally. */
export const BRAIN_INDEX_MAX_ATTEMPTS = 12;
export const BRAIN_INDEX_RETRIES_EXHAUSTED = "retries-exhausted";
export const BRAIN_INDEX_PERMANENT_FAILURE = "permanent-failure";
export const BRAIN_INDEX_BRAIN_INACTIVE = "The Brain is no longer active.";

export type BrainIndexJobClaim =
  | { readonly job: BrainIndexJob; readonly outcome: "claimed" }
  /** The Brain was archived or erased; the job was retired without running. */
  | { readonly job: BrainIndexJob; readonly outcome: "brain-inactive" }
  /** Another writer changed the job first; the current owner of the job drives it. */
  | { readonly outcome: "superseded" };

/**
 * Terminal jobs are never claimed or redispatched: succeeded (including skipped)
 * jobs, and failed jobs that exhausted their retries and dropped their due time.
 */
export function isTerminalBrainIndexJob(job: BrainIndexJob) {
  return (
    job.data.status === "succeeded" ||
    (job.data.status === "failed" && job.data.skipReason !== undefined)
  );
}

export async function getBrainIndexJob(
  database: DynamoDatabaseService,
  input: {
    readonly documentId: string;
    readonly idempotencyKey: string;
    readonly organizationId: string;
  },
) {
  const value = await database.getRecord(
    "execution",
    {
      pk: key("ORG", input.organizationId, "DOCUMENT", input.documentId),
      sk: key("BRAIN-INDEX-JOB", input.idempotencyKey),
    },
    true,
  );
  return value?.itemType === "brain-index-job" && value.data.organizationId === input.organizationId
    ? value
    : undefined;
}

function record(data: BrainIndexJob["data"], previous: BrainIndexJob) {
  return Schema.decodeUnknownSync(BrainIndexJobRecord)(
    withCanonicalRecordKeys({ ...previous, data }),
  );
}

function brainKey(job: BrainIndexJob) {
  return { pk: key("ORG", job.data.organizationId), sk: key("BRAIN", job.data.brainId) };
}

async function brainIsActive(database: DynamoDatabaseService, job: BrainIndexJob) {
  const brain = await database.getRecord("control", brainKey(job), true);
  return (
    brain?.itemType === "brain" &&
    brain.data.organizationId === job.data.organizationId &&
    brain.data.status === "active"
  );
}

/**
 * Claims a queued job while its Brain is active. A lost claim is classified rather than
 * escaping: an inactive Brain retires the job terminally, and a concurrent job change
 * yields to whoever made it. Only a conflict that changed neither is rethrown for retry.
 */
export async function claimBrainIndexJob(input: {
  readonly database: DynamoDatabaseService;
  readonly job: BrainIndexJob;
  readonly leaseExpiresAt: string;
  readonly leaseOwner: string;
  readonly now: string;
}): Promise<BrainIndexJobClaim | undefined> {
  if (
    input.job.data.status !== "queued" ||
    (input.job.data.nextDueAt && input.job.data.nextDueAt > input.now)
  ) {
    return undefined;
  }
  const claimed = record(
    {
      ...input.job.data,
      attempt: input.job.data.attempt + 1,
      leaseExpiresAt: input.leaseExpiresAt,
      leaseOwner: input.leaseOwner,
      startedAt: input.now,
      status: "running",
      updatedAt: input.now,
      version: input.job.data.version + 1,
    },
    input.job,
  );
  try {
    await input.database.transactWrite([
      {
        conditionExpression: "#itemType = :itemType AND #data.#status = :active",
        expressionAttributeNames: {
          "#data": "data",
          "#itemType": "itemType",
          "#status": "status",
        },
        expressionAttributeValues: { ":active": "active", ":itemType": "brain" },
        key: brainKey(input.job),
        kind: "condition-check",
        table: "control",
      },
      { kind: "put", previousRecord: input.job, record: claimed },
    ]);
  } catch (cause) {
    if (!isDatabaseWriteConflict(cause)) throw cause;
    if (!(await brainIsActive(input.database, input.job))) {
      try {
        const retired = await skipBrainIndexJob({
          // Brain archive and erasure are one-way, so this condition only guards the read race.
          conditions: [
            {
              conditionExpression:
                "attribute_not_exists(pk) OR #itemType <> :itemType OR #data.#status <> :active",
              expressionAttributeNames: {
                "#data": "data",
                "#itemType": "itemType",
                "#status": "status",
              },
              expressionAttributeValues: { ":active": "active", ":itemType": "brain" },
              key: brainKey(input.job),
              kind: "condition-check",
              table: "control",
            },
          ],
          database: input.database,
          job: input.job,
          now: input.now,
          reason: BRAIN_INDEX_BRAIN_INACTIVE,
        });
        return { job: retired, outcome: "brain-inactive" };
      } catch (retireCause) {
        if (isDatabaseWriteConflict(retireCause)) return { outcome: "superseded" };
        throw retireCause;
      }
    }
    const current = await getBrainIndexJob(input.database, input.job.data);
    if (current?.data.version !== input.job.data.version) return { outcome: "superseded" };
    throw cause;
  }
  return { job: claimed, outcome: "claimed" };
}

export async function recoverExpiredBrainIndexJob(input: {
  readonly database: DynamoDatabaseService;
  readonly job: BrainIndexJob;
  readonly now: string;
}) {
  if (
    input.job.data.status !== "running" ||
    !input.job.data.leaseExpiresAt ||
    input.job.data.leaseExpiresAt > input.now
  ) {
    return undefined;
  }
  return recordFailedAttempt({
    database: input.database,
    error: "The previous Brain index worker lease expired before completion.",
    job: input.job,
    next:
      input.job.data.attempt >= BRAIN_INDEX_MAX_ATTEMPTS
        ? { skipReason: BRAIN_INDEX_RETRIES_EXHAUSTED }
        : { nextDueAt: input.now },
    now: input.now,
  });
}

export async function failBrainIndexJob(input: {
  readonly cause: unknown;
  readonly database: DynamoDatabaseService;
  readonly job: BrainIndexJob;
  readonly now: string;
  readonly permanent: boolean;
}) {
  if (input.job.data.status !== "running") {
    throw new TypeError("Only a running Brain index job can fail.");
  }
  const delaySeconds = Math.min(3_600, 2 ** Math.min(10, input.job.data.attempt) * 5);
  return recordFailedAttempt({
    database: input.database,
    error: String(input.cause instanceof Error ? input.cause.message : input.cause).slice(0, 2_000),
    job: input.job,
    next: input.permanent
      ? { skipReason: BRAIN_INDEX_PERMANENT_FAILURE }
      : input.job.data.attempt >= BRAIN_INDEX_MAX_ATTEMPTS
        ? { skipReason: BRAIN_INDEX_RETRIES_EXHAUSTED }
        : { nextDueAt: new Date(Date.parse(input.now) + delaySeconds * 1_000).toISOString() },
    now: input.now,
  });
}

async function recordFailedAttempt(input: {
  readonly database: DynamoDatabaseService;
  readonly error: string;
  readonly job: BrainIndexJob;
  readonly next: { readonly nextDueAt: string } | { readonly skipReason: string };
  readonly now: string;
}) {
  const {
    leaseExpiresAt: _leaseExpiresAt,
    leaseOwner: _leaseOwner,
    nextDueAt: _nextDueAt,
    ...withoutLease
  } = input.job.data;
  const failed = record(
    {
      ...withoutLease,
      error: input.error,
      ...input.next,
      status: "failed",
      updatedAt: input.now,
      version: input.job.data.version + 1,
    },
    input.job,
  );
  const state = "skipReason" in input.next ? await failedIndexState(input) : undefined;
  await input.database.transactWrite([
    ...(state ? [state] : []),
    { kind: "put", previousRecord: input.job, record: failed },
  ]);
  return failed;
}

async function failedIndexState(input: {
  readonly database: DynamoDatabaseService;
  readonly error: string;
  readonly job: BrainIndexJob;
  readonly now: string;
}): Promise<TransactionOperation | undefined> {
  const job = input.job.data;
  const previous = await getBrainIndexState(input.database, job.organizationId, job.documentId);
  const anotherJobOwnsState =
    previous !== undefined &&
    previous.data.attemptId !== job.id &&
    previous.data.projectionGeneration >= job.expectedProjectionGeneration;
  if (anotherJobOwnsState) return undefined;
  const publishedChunkIds = previous?.data.chunkIds ?? [];
  const state = Schema.decodeUnknownSync(BrainIndexStateRecord)(
    withCanonicalRecordKeys({
      data: {
        attemptId: job.id,
        brainId: job.brainId,
        chunkIds: publishedChunkIds,
        components: job.components.map((component) => ({
          componentId: component.componentId,
          kind: component.kind,
          status: "failed" as const,
          updatedAt: input.now,
        })),
        createdAt: previous?.data.createdAt ?? input.now,
        documentId: job.documentId,
        documentVersionId: job.documentVersionId,
        embeddingProfileId: job.embeddingProfileId,
        lastError: input.error,
        organizationId: job.organizationId,
        placementGeneration: job.placementGeneration,
        projectionGeneration: job.expectedProjectionGeneration,
        provider: job.provider,
        schemaGeneration: job.schemaGeneration,
        sourceId: job.sourceId,
        status: "failed" as const,
        targetId: job.targetId,
        updatedAt: input.now,
        version: previous ? previous.data.version + 1 : 0,
      },
      itemType: "brain-index-state" as const,
    }),
  );
  return { kind: "put", ...(previous ? { previousRecord: previous } : {}), record: state };
}

export async function requeueBrainIndexJob(input: {
  readonly database: DynamoDatabaseService;
  readonly job: BrainIndexJob;
  readonly now: string;
}) {
  if (input.job.data.status !== "failed" || isTerminalBrainIndexJob(input.job)) {
    throw new TypeError("Only a retryable failed Brain index job can be requeued.");
  }
  const queued = record(
    {
      ...input.job.data,
      status: "queued",
      updatedAt: input.now,
      version: input.job.data.version + 1,
    },
    input.job,
  );
  await input.database.transactWrite([{ kind: "put", previousRecord: input.job, record: queued }]);
  return queued;
}

/**
 * Ends a job whose work is no longer needed (stale input, a stronger committed mutation, or an
 * inactive Brain) as a terminal skip. `conditions` must hold in the same transaction.
 */
export async function skipBrainIndexJob(input: {
  readonly conditions?: readonly TransactionOperation[];
  readonly database: DynamoDatabaseService;
  readonly job: BrainIndexJob;
  readonly now: string;
  readonly reason: string;
}) {
  if (input.job.data.status !== "running" && input.job.data.status !== "queued") {
    throw new TypeError("Only a queued or running Brain index job can be skipped.");
  }
  const {
    leaseExpiresAt: _leaseExpiresAt,
    leaseOwner: _leaseOwner,
    ...withoutLease
  } = input.job.data;
  const skipped = record(
    {
      ...withoutLease,
      completedAt: input.now,
      skipReason: input.reason.slice(0, 2_000),
      status: "succeeded",
      updatedAt: input.now,
      version: input.job.data.version + 1,
    },
    input.job,
  );
  await input.database.transactWrite([
    ...(input.conditions ?? []),
    { kind: "put", previousRecord: input.job, record: skipped },
  ]);
  return skipped;
}
