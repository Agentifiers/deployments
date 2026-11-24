import { createHash } from "node:crypto";
import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  type ObjectIdentifier,
  type S3Client,
} from "@aws-sdk/client-s3";
import { brainStoragePrefix, type BrainRepository } from "@deployments-ai/brains";
import {
  brainErasureFromRecord,
  brainUlid,
  BrainErasureJobRecord,
  governanceBrainIds,
  key,
  isDatabaseWriteConflict,
  makeSemanticEventRecord,
  transactWithSemanticEvents,
  withCanonicalRecordKeys,
  type BrainErasureJob,
  type BrainTenantInventory,
  type DynamoDatabaseService,
  type GovernanceStore,
  type PlatformRecord,
  type TenantRecord,
  apiPersistence,
} from "@deployments-ai/db";
import {
  blobReferences,
  distinctTenantRecords,
  type GovernanceObjectStore,
} from "@deployments-ai/governance";
import { Schema } from "effect";
import type { BrainSearchErasureResult } from "./search-erasure.ts";

const QUIESCENCE_MS = 5 * 60_000;
const RETRY_MS = 5 * 60_000;
const FAILURE_RETRY_MAX_MS = 60 * 60_000;
/** Consecutive failed attempts, counting leases lost to crashed or timed-out workers, before retries stop. */
const MAX_FAILED_ATTEMPTS = 8;
const LEASE_MS = 15 * 60_000;
const MAX_DERIVED_MEMORIES = 5_000;
const LEASE_EXPIRED = "The previous Brain erasure worker lease expired before completion.";
const FENCE_LOST = "Brain erasure lost its generation-bound write fence.";

function record(job: BrainErasureJob, data: BrainErasureJob["data"]) {
  return Schema.decodeUnknownSync(BrainErasureJobRecord)(withCanonicalRecordKeys({ ...job, data }));
}

function withoutLease(data: BrainErasureJob["data"]) {
  const { leaseExpiresAt: _leaseExpiresAt, leaseOwner: _leaseOwner, ...rest } = data;
  return rest;
}

/** Durable progress ends a failure streak, so the retry ceiling counts consecutive failures only. */
function progressed<Data extends { readonly failedAttempts?: number | undefined }>({
  failedAttempts: _failedAttempts,
  ...data
}: Data) {
  return data;
}

/**
 * Records a failed attempt. The job retries with exponential backoff (5 minutes doubling to a
 * 1-hour cap) until it has failed `MAX_FAILED_ATTEMPTS` consecutive times; it then stays `failed` with its
 * last error, out of the due-work queue, until an operator resumes it.
 */
function failedAttempt(job: BrainErasureJob, cause: unknown, now: Date) {
  const failedAttempts = (job.data.failedAttempts ?? 0) + 1;
  const exhausted = failedAttempts >= MAX_FAILED_ATTEMPTS;
  const delay = Math.min(FAILURE_RETRY_MAX_MS, RETRY_MS * 2 ** (failedAttempts - 1));
  return record(job, {
    ...withoutLease(job.data),
    error: String(cause instanceof Error ? cause.message : cause).slice(0, 2_000),
    failedAttempts,
    nextDueAt: new Date(now.getTime() + (exhausted ? 0 : delay)).toISOString(),
    status: exhausted ? "failed" : "pending",
    updatedAt: now.toISOString(),
    version: job.data.version + 1,
  });
}

async function currentJob(database: DynamoDatabaseService, candidate: BrainErasureJob) {
  const value = await apiPersistence.read(
    database,
    "execution",
    { pk: candidate.pk, sk: candidate.sk },
    true,
  );
  return value?.itemType === "brain-erasure-job" ? value : undefined;
}

function brainFenceCondition(job: BrainErasureJob) {
  return {
    conditionExpression:
      "#itemType = :itemType AND #data.#status = :status AND #data.#version = :version",
    expressionAttributeNames: {
      "#data": "data",
      "#itemType": "itemType",
      "#status": "status",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":itemType": "brain",
      ":status": "erasing",
      ":version": job.data.erasureGeneration,
    },
    key: {
      pk: key("ORG", job.data.organizationId),
      sk: key("BRAIN", job.data.brainId),
    },
    kind: "condition-check" as const,
    table: "control" as const,
  };
}

async function assertFence(
  repository: BrainRepository,
  job: BrainErasureJob,
  allowDeleted: boolean,
) {
  const brain = await repository.get(job.data.organizationId, job.data.brainId);
  if (!brain && allowDeleted) return brain;
  if (!brain || brain.status !== "erasing" || brain.version !== job.data.erasureGeneration) {
    throw new Error(FENCE_LOST);
  }
  return brain;
}

async function claim(input: {
  readonly database: DynamoDatabaseService;
  readonly job: BrainErasureJob;
  readonly now: Date;
  readonly repository: BrainRepository;
  readonly workerId: string;
}): Promise<{ readonly job: BrainErasureJob } | { readonly outcome: "exhausted" | "ignored" }> {
  const now = input.now.toISOString();
  const current = await currentJob(input.database, input.job);
  if (
    !current ||
    current.data.status === "completed" ||
    current.data.status === "failed" ||
    current.data.nextDueAt > now
  ) {
    return { outcome: "ignored" };
  }
  if (
    current.data.status === "running" &&
    current.data.leaseExpiresAt &&
    current.data.leaseExpiresAt > now
  ) {
    return { outcome: "ignored" };
  }
  const attempt =
    current.data.status === "running" ? failedAttempt(current, LEASE_EXPIRED, input.now) : current;
  if (attempt.data.status === "failed") {
    return {
      outcome: (await saveUnlessRaced(input.database, current, attempt)) ? "exhausted" : "ignored",
    };
  }
  try {
    const brain = await assertFence(input.repository, current, current.data.phase === "verifying");
    const claimed = record(current, {
      ...withoutLease(attempt.data),
      leaseExpiresAt: new Date(input.now.getTime() + LEASE_MS).toISOString(),
      leaseOwner: input.workerId,
      startedAt: current.data.startedAt ?? now,
      status: "running",
      updatedAt: now,
      version: current.data.version + 1,
    });
    await apiPersistence.commit(input.database, [
      ...(brain ? [brainFenceCondition(current)] : []),
      { kind: "put", previousRecord: current, record: claimed },
    ]);
    return { job: claimed };
  } catch (cause) {
    if ((await currentJob(input.database, current))?.data.version !== current.data.version) {
      return { outcome: "ignored" };
    }
    // The job is unchanged, so a write conflict came from the Brain fence condition.
    const failure = isDatabaseWriteConflict(cause) ? new Error(FENCE_LOST, { cause }) : cause;
    const recorded = await saveUnlessRaced(
      input.database,
      current,
      failedAttempt(current, failure, input.now),
    );
    if (!recorded) return { outcome: "ignored" };
    throw failure;
  }
}

async function save(
  database: DynamoDatabaseService,
  previous: BrainErasureJob,
  next: BrainErasureJob,
) {
  await apiPersistence.commit(database, [{ kind: "put", previousRecord: previous, record: next }]);
  return next;
}

/** Saves unless another worker changed the job first; that worker owns the outcome. */
async function saveUnlessRaced(
  database: DynamoDatabaseService,
  previous: BrainErasureJob,
  next: BrainErasureJob,
) {
  try {
    await save(database, previous, next);
    return true;
  } catch (cause) {
    if (isDatabaseWriteConflict(cause)) return false;
    throw cause;
  }
}

async function pause(
  database: DynamoDatabaseService,
  job: BrainErasureJob,
  now: Date,
  message?: string,
) {
  return save(
    database,
    job,
    record(job, {
      ...progressed(withoutLease(job.data)),
      ...(message ? { error: message } : {}),
      nextDueAt: new Date(now.getTime() + RETRY_MS).toISOString(),
      status: "pending",
      updatedAt: now.toISOString(),
      version: job.data.version + 1,
    }),
  );
}

function belongsToBrain(item: TenantRecord, job: BrainErasureJob) {
  const record = item.record;
  if (record.itemType === "brain-erasure-job" && record.data.id === job.data.id) return false;
  return governanceBrainIds(record).includes(job.data.brainId);
}

async function scanBrainRecords(
  store: BrainTenantInventory,
  job: BrainErasureJob,
  visit: (records: readonly TenantRecord[]) => Promise<boolean | void>,
) {
  const unseen = distinctTenantRecords();
  let cursor: string | undefined;
  let count = 0;
  do {
    const page = await store.listBrainRecords(job.data.organizationId, job.data.brainId, cursor);
    const scoped = unseen(page.items).filter((item) => belongsToBrain(item, job));
    count += scoped.length;
    if ((await visit(scoped)) === false) return { complete: false as const, count };
    cursor = page.cursor;
  } while (cursor);
  return { complete: true as const, count };
}

function activeDrain(item: TenantRecord, now: string) {
  const record = item.record;
  if (record.itemType === "brain-upload-lease") {
    return record.data.status === "active" && record.data.expiresAt > now;
  }
  if (record.itemType === "brain-index-job" || record.itemType === "brain-sync-job") {
    return (
      record.data.status === "running" &&
      record.data.leaseExpiresAt !== undefined &&
      record.data.leaseExpiresAt > now
    );
  }
  return (
    record.itemType === "brain-provider-mutation-claim" &&
    record.data.status === "active" &&
    record.data.leaseExpiresAt !== undefined &&
    record.data.leaseExpiresAt > now
  );
}

async function prefixVersions(s3: Pick<S3Client, "send">, bucket: string, prefix: string) {
  const objects: ObjectIdentifier[] = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        Prefix: prefix,
        ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
      }),
    );
    for (const candidate of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
      if (candidate.Key?.startsWith(prefix) && candidate.VersionId) {
        objects.push({ Key: candidate.Key, VersionId: candidate.VersionId });
      }
    }
    if (page.IsTruncated && !page.NextKeyMarker) {
      throw new Error("Brain erasure received a truncated S3 listing without a continuation key.");
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker);
  return objects;
}

async function sweepPrefix(input: {
  readonly bucket: string;
  readonly prefix: string;
  readonly s3: Pick<S3Client, "send">;
}) {
  const objects = await prefixVersions(input.s3, input.bucket, input.prefix);
  for (let offset = 0; offset < objects.length; offset += 1_000) {
    const result = await input.s3.send(
      new DeleteObjectsCommand({
        Bucket: input.bucket,
        Delete: { Objects: objects.slice(offset, offset + 1_000), Quiet: true },
      }),
    );
    if (result.Errors?.length) throw new Error("Brain erasure S3 prefix deletion was partial.");
  }
  return objects.length;
}

async function purgeRecordBlobs(input: {
  readonly bucket: string;
  readonly legacyBuckets?: readonly string[];
  readonly objectStore: GovernanceObjectStore;
  readonly organizationId: string;
  readonly records: readonly TenantRecord[];
}) {
  const scope = { allowedObjectBuckets: [input.bucket, ...(input.legacyBuckets ?? [])] };
  for (const item of input.records) {
    for (const reference of blobReferences(scope, input.organizationId, item.record, true, true)) {
      if (reference.deleteAllVersions === false) await input.objectStore.delete(reference);
      else await input.objectStore.deleteAllVersions(reference);
    }
  }
}

function derivedMemories(records: readonly TenantRecord[]) {
  return records.filter(
    (
      item,
    ): item is TenantRecord & {
      readonly record: Extract<PlatformRecord, { readonly itemType: "memory" }>;
    } => item.record.itemType === "memory" && item.record.data.brainProvenance !== undefined,
  );
}

export interface BrainErasureRuntimeDependencies {
  readonly bucket: string;
  readonly database: DynamoDatabaseService;
  readonly governanceStore: Pick<GovernanceStore, "deleteTenantRecords"> & BrainTenantInventory;
  readonly legacyBuckets?: readonly string[];
  readonly now?: () => Date;
  readonly objectStore: GovernanceObjectStore;
  readonly purgeDerivedMemories: (input: {
    readonly brainId: string;
    readonly memories: readonly { readonly pk: string; readonly sk: string }[];
    readonly operationId: string;
    readonly organizationId: string;
  }) => Promise<Readonly<Record<string, unknown>>>;
  readonly purgeSearch: (input: {
    readonly brainId: string;
    readonly erasureGeneration: number;
    readonly operationId: string;
    readonly organizationId: string;
  }) => Promise<BrainSearchErasureResult>;
  readonly repository: BrainRepository;
  readonly s3: Pick<S3Client, "send">;
  readonly workerId: string;
}

export async function processBrainErasure(
  candidate: BrainErasureJob,
  dependencies: BrainErasureRuntimeDependencies,
) {
  const now = (dependencies.now ?? (() => new Date()))();
  const claimed = await claim({
    database: dependencies.database,
    job: candidate,
    now,
    repository: dependencies.repository,
    workerId: dependencies.workerId,
  });
  if (!("job" in claimed)) return claimed;
  let job = claimed.job;
  try {
    if (job.data.phase === "draining") {
      const drain = await scanBrainRecords(dependencies.governanceStore, job, async (records) =>
        records.some((item) => activeDrain(item, now.toISOString())) ? false : undefined,
      );
      if (!drain.complete) {
        await pause(
          dependencies.database,
          job,
          now,
          "Brain erasure is waiting for active uploads and workers to drain.",
        );
        return { outcome: "draining" as const };
      }
      await assertFence(dependencies.repository, job, false);
      let deleted = 0;
      for (const bucket of [dependencies.bucket, ...(dependencies.legacyBuckets ?? [])]) {
        deleted += await sweepPrefix({
          bucket,
          prefix: brainStoragePrefix(job.data),
          s3: dependencies.s3,
        });
      }
      if (deleted > 0) {
        job = await save(
          dependencies.database,
          job,
          record(job, {
            ...progressed(withoutLease(job.data)),
            contentVerificationCount: 0,
            nextDueAt: new Date(now.getTime() + RETRY_MS).toISOString(),
            phase: "draining",
            status: "pending",
            updatedAt: now.toISOString(),
            version: job.data.version + 1,
          }),
        );
        return { deleted, outcome: "content-purged" as const };
      }
      const quiescence = job.data.contentQuiescenceStartedAt
        ? Date.parse(job.data.contentQuiescenceStartedAt)
        : Number.NaN;
      if (
        job.data.contentVerificationCount < 1 ||
        !Number.isFinite(quiescence) ||
        now.getTime() - quiescence < QUIESCENCE_MS
      ) {
        await save(
          dependencies.database,
          job,
          record(job, {
            ...progressed(withoutLease(job.data)),
            contentQuiescenceStartedAt: now.toISOString(),
            contentVerificationCount: 1,
            nextDueAt: new Date(now.getTime() + QUIESCENCE_MS).toISOString(),
            phase: "draining",
            status: "pending",
            updatedAt: now.toISOString(),
            version: job.data.version + 1,
          }),
        );
        return { outcome: "content-quiescence" as const };
      }
      job = await save(
        dependencies.database,
        job,
        record(job, {
          ...progressed(job.data),
          contentVerificationCount: 2,
          phase: "purging",
          updatedAt: now.toISOString(),
          version: job.data.version + 1,
        }),
      );
    }

    if (job.data.phase === "purging") {
      await assertFence(dependencies.repository, job, false);
      const memoryReceiptDigests: string[] = [];
      const memoryKeys: { readonly pk: string; readonly sk: string }[] = [];
      const purgingJob = job;
      const inventory = await scanBrainRecords(
        dependencies.governanceStore,
        purgingJob,
        async (records) => {
          memoryKeys.push(
            ...derivedMemories(records).map(({ record }) => ({ pk: record.pk, sk: record.sk })),
          );
          if (memoryKeys.length > MAX_DERIVED_MEMORIES) {
            throw new Error("Brain erasure derived-memory inventory exceeds its bounded limit.");
          }
        },
      );
      for (let offset = 0; offset < memoryKeys.length; offset += 100) {
        const receipt = await dependencies.purgeDerivedMemories({
          brainId: purgingJob.data.brainId,
          memories: memoryKeys.slice(offset, offset + 100),
          operationId: purgingJob.data.id,
          organizationId: purgingJob.data.organizationId,
        });
        memoryReceiptDigests.push(
          createHash("sha256").update(JSON.stringify(receipt)).digest("hex"),
        );
      }
      const brainSearch = await dependencies.purgeSearch({
        brainId: job.data.brainId,
        erasureGeneration: job.data.erasureGeneration,
        operationId: job.data.id,
        organizationId: job.data.organizationId,
      });
      if (brainSearch.status === "pending") {
        await pause(
          dependencies.database,
          job,
          now,
          "Brain erasure is waiting for Brain search provider mutations to drain.",
        );
        return { outcome: "search-draining" as const };
      }
      job = await save(
        dependencies.database,
        job,
        record(job, {
          ...progressed(job.data),
          phase: "verifying",
          recordsDeleted: job.data.recordsDeleted ?? inventory.count,
          searchReceipt: {
            brainSearch: JSON.parse(JSON.stringify(brainSearch.receipt)),
            derivedMemory: {
              memoryCount: memoryKeys.length,
              receiptDigests: memoryReceiptDigests,
            },
          },
          updatedAt: now.toISOString(),
          version: job.data.version + 1,
        }),
      );
    }

    const verifyingJob = job;
    await scanBrainRecords(dependencies.governanceStore, verifyingJob, async (records) => {
      await purgeRecordBlobs({
        bucket: dependencies.bucket,
        ...(dependencies.legacyBuckets ? { legacyBuckets: dependencies.legacyBuckets } : {}),
        objectStore: dependencies.objectStore,
        organizationId: verifyingJob.data.organizationId,
        records,
      });
      if (records.length > 0) {
        await dependencies.governanceStore.deleteTenantRecords(
          records,
          new Date(now.getTime() + LEASE_MS).toISOString(),
        );
        // A scan that outlasts the Lambda timeout still deletes records on every attempt, so the
        // first deletion after a failure ends the failure streak.
        if (job.data.failedAttempts !== undefined) {
          job = await save(
            dependencies.database,
            job,
            record(job, {
              ...progressed(job.data),
              updatedAt: now.toISOString(),
              version: job.data.version + 1,
            }),
          );
        }
      }
    });
    const remaining = await scanBrainRecords(
      dependencies.governanceStore,
      verifyingJob,
      async (records) => (records.length > 0 ? false : undefined),
    );
    if (!remaining.complete) {
      await pause(
        dependencies.database,
        job,
        now,
        "Brain erasure is reconciling records written before the fence became visible.",
      );
      return { outcome: "reconciling" as const, remaining: remaining.count };
    }
    const completedAt = now.toISOString();
    const { error: _retriedError, ...settled } = progressed(withoutLease(job.data));
    const completed = record(job, {
      ...settled,
      completedAt,
      nextDueAt: completedAt,
      recordsDeleted: job.data.recordsDeleted ?? 0,
      status: "completed",
      updatedAt: completedAt,
      version: job.data.version + 1,
    });
    // No request token: the version-conditioned job put and the create-only event put already
    // make completion idempotent, and every retry rebuilds its timestamps.
    await transactWithSemanticEvents(
      dependencies.database,
      [{ kind: "put", previousRecord: job, record: completed }],
      [
        // The erasure job is its own single-event aggregate: `brain.erased` is the first and
        // only semantic event it ever appends, independent of how many job versions a retried
        // erasure accumulated.
        makeSemanticEventRecord({
          aggregateId: brainUlid(job.data.id),
          aggregateType: "brain-erasure",
          aggregateVersion: 1,
          eventId: brainUlid(job.data.id),
          eventType: "brain.erased",
          occurredAt: completedAt,
          organizationId: brainUlid(job.data.organizationId),
          payload: {
            brainHash: createHash("sha256").update(job.data.brainId).digest("hex"),
            erasureGeneration: job.data.erasureGeneration,
            erasureId: job.data.id,
            recordsDeleted: completed.data.recordsDeleted ?? 0,
          },
        }),
      ],
    );
    return { operation: brainErasureFromRecord(completed), outcome: "completed" as const };
  } catch (cause) {
    const latest = await currentJob(dependencies.database, job);
    // Only the lease holder may release its lease; a worker whose lease was taken over must not
    // overwrite the successor's running job.
    if (latest?.data.status === "running" && latest.data.leaseOwner === dependencies.workerId) {
      await save(dependencies.database, latest, failedAttempt(latest, cause, now));
    }
    throw cause;
  }
}
