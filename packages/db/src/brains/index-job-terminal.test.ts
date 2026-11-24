import { describe, expect, test } from "bun:test";
import type { Brain } from "@deployments-ai/brains";
import { Schema } from "effect";
import { makeDynamoDatabase } from "../dynamo-database.ts";
import { BrainIndexJobRecord } from "../records/brain-runtime.ts";
import { BrainIndexStateRecord } from "../records/brain-search.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import {
  fakeDynamoDocumentClient,
  transactionCanceledError,
} from "../testing/dynamo-document-client.fixture.ts";
import {
  BRAIN_INDEX_BRAIN_INACTIVE,
  BRAIN_INDEX_MAX_ATTEMPTS,
  BRAIN_INDEX_RETRIES_EXHAUSTED,
  claimBrainIndexJob,
  failBrainIndexJob,
  getBrainIndexJob,
  isTerminalBrainIndexJob,
  recoverExpiredBrainIndexJob,
  requeueBrainIndexJob,
  type BrainIndexJob,
} from "./index-job-lifecycle.ts";
import { getBrainIndexState } from "./index-suppression.ts";
import { brainPlatformRecord } from "./record-mapping.ts";
import { makeBrainDynamoRepository } from "./repository.ts";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G6006";
const brainId = "01M403FMNP7S2YVJ5Y67R3J87H";
const documentId = "01M403FR0Z4VNNQWM841K3XHP7";
const principalId = "01KYK5W3M7Z4KR6VP8BJTA8ACF";
const createdAt = "2026-10-03T05:23:44.287Z";
const now = "2026-10-03T06:00:00.000Z";
const lease = { leaseExpiresAt: "2026-10-03T06:10:00.000Z", now };
const lastError = "Brain extraction exceeded token limit.";

function failedHealth(projectionGeneration: number, error: string) {
  return {
    components: [],
    documentId,
    documentVersionId: "01M403FPZ6T94GBCFS3W9HSAWC",
    lastError: error,
    projectionGeneration,
    status: "failed" as const,
    updatedAt: now,
  };
}

function readyState(projectionGeneration: number) {
  return Schema.decodeUnknownSync(BrainIndexStateRecord)(
    withCanonicalRecordKeys({
      data: {
        attemptId: "01M403FR0Z4VNNQWM841K3XHPB",
        brainId,
        chunkIds: ["published-chunk"],
        components: [
          {
            componentId: "01M12QGESQ6N0M4ZT1H6M5CYZN",
            kind: "dense" as const,
            status: "ready" as const,
            updatedAt: createdAt,
          },
        ],
        contentHash: "sha256:published",
        createdAt,
        documentId,
        documentVersionId: "01M403FPZ6T94GBCFS3W9HSAWB",
        embeddingProfileId: "01ARZ3NDEKTSV4RRFFQ69G6001",
        organizationId,
        placementGeneration: 3,
        projectionGeneration,
        provider: "aws-native" as const,
        schemaGeneration: 1,
        sourceId: "01M403FPPFMKRZF7PJ210Y070N",
        status: "ready" as const,
        synchronizedAt: createdAt,
        targetId: "01M12QGESQ6N0M4ZT1H6M5CYZS",
        updatedAt: createdAt,
        version: 0,
      },
      itemType: "brain-index-state" as const,
    }),
  );
}

function brain(status: Brain["status"], version: number): Brain {
  return {
    createdAt,
    createdByPrincipalId: principalId,
    id: brainId,
    kind: "company",
    maintenancePolicy: {},
    name: "E2E Brain",
    organizationId,
    ownershipGeneration: 0,
    retrievalPolicy: {},
    schemaVersion: 1,
    sensitivity: "internal",
    slug: "e2e-brain",
    status,
    updatedAt: createdAt,
    updatedByPrincipalId: principalId,
    version,
  };
}

function job(data: Partial<BrainIndexJob["data"]> = {}): BrainIndexJob {
  return Schema.decodeUnknownSync(BrainIndexJobRecord)(
    withCanonicalRecordKeys({
      data: {
        attempt: 2,
        brainId,
        components: [],
        createdAt,
        documentId,
        documentVersionId: "01M403FPZ6T94GBCFS3W9HSAWC",
        embeddingProfileId: "01ARZ3NDEKTSV4RRFFQ69G6001",
        expectedProjectionGeneration: 0,
        id: "01M403FR0Z4VNNQWM841K3XHP9",
        idempotencyKey: `${documentId}:0:index`,
        nextDueAt: "2026-10-03T05:39:05.994Z",
        operation: "index" as const,
        organizationId,
        placementGeneration: 3,
        priority: 100,
        provider: "aws-native" as const,
        renditionId: "01M403FR0Z4VNNQWM841K3XHPA",
        schemaGeneration: 1,
        sourceId: "01M403FPPFMKRZF7PJ210Y070N",
        status: "queued" as const,
        targetId: "01M12QGESQ6N0M4ZT1H6M5CYZS",
        updatedAt: "2026-10-03T05:53:46.028Z",
        version: 6,
        ...data,
      },
      itemType: "brain-index-job" as const,
    }),
  );
}

async function store(brainStatus: Brain["status"], initial: BrainIndexJob) {
  const dynamo = fakeDynamoDocumentClient();
  const database = makeDynamoDatabase(dynamo.client);
  // Brain creation's slug claim is outside this lifecycle; seed only the records writes fence on.
  dynamo.put(
    "control",
    withCanonicalRecordKeys({
      data: {
        createdAt,
        id: organizationId,
        name: "Deployments.ai",
        slug: "deployments-ai",
        status: "active",
        updatedAt: createdAt,
        version: 1,
      },
      itemType: "organization" as const,
    }),
  );
  dynamo.put("control", brainPlatformRecord(brain(brainStatus, 1)));
  await database.transactWrite([{ kind: "put", record: initial }]);
  const current = () => getBrainIndexJob(database, initial.data);
  const health = async () =>
    (
      await makeBrainDynamoRepository(database).listIndexHealth(organizationId, brainId, {
        limit: 10,
      })
    ).items;
  return { database, dynamo, current, health };
}

function runningJob(data: Partial<BrainIndexJob["data"]> = {}) {
  return job({
    attempt: 1,
    leaseExpiresAt: "2026-10-03T06:10:00.000Z",
    leaseOwner: "w-1",
    status: "running",
    ...data,
  });
}

describe("Brain index job terminal states", () => {
  test("retires a queued job whose Brain was archived instead of failing its claim forever", async () => {
    const { current, database } = await store("archived", job());

    const claim = await claimBrainIndexJob({
      database,
      job: (await current())!,
      leaseOwner: "worker-1",
      ...lease,
    });

    expect(claim?.outcome).toBe("brain-inactive");
    const retired = await current();
    expect(retired?.data).toMatchObject({
      completedAt: now,
      skipReason: BRAIN_INDEX_BRAIN_INACTIVE,
      status: "succeeded",
      version: 7,
    });
    expect(retired?.data).not.toHaveProperty("leaseOwner");
    expect(retired!.gsi1pk).toMatch(/^QUEUE#BRAIN-INDEX-JOB#succeeded#/u);
    expect(isTerminalBrainIndexJob(retired!)).toBe(true);
  });

  test("yields to a concurrent claim of the same queued job", async () => {
    const { current, database } = await store("active", job());
    const snapshot = (await current())!;

    const first = await claimBrainIndexJob({
      database,
      job: snapshot,
      leaseOwner: "w-1",
      ...lease,
    });
    const second = await claimBrainIndexJob({
      database,
      job: snapshot,
      leaseOwner: "w-2",
      ...lease,
    });

    expect(first?.outcome).toBe("claimed");
    expect(second).toEqual({ outcome: "superseded" });
    expect((await current())?.data).toMatchObject({
      leaseOwner: "w-1",
      status: "running",
      version: 7,
    });
  });

  test("yields when the Brain archive races a concurrent change to the job", async () => {
    const { current, database } = await store("archived", job());
    const stale = (await current())!;
    // Another writer advances the job after this worker read it.
    await database.transactWrite([
      { kind: "put", previousRecord: stale, record: job({ updatedAt: now, version: 7 }) },
    ]);

    expect(await claimBrainIndexJob({ database, job: stale, leaseOwner: "w-2", ...lease })).toEqual(
      { outcome: "superseded" },
    );
    expect((await current())?.data).toMatchObject({ status: "queued", version: 7 });
  });

  test("rethrows a claim conflict from a fence other than the Brain or the job", async () => {
    const { current, database, dynamo } = await store("active", job());
    // The organization erasure fence rejects the claim while the Brain and job are unchanged.
    dynamo.failNextTransaction(
      () => true,
      () => transactionCanceledError(["None", "None", "None", "ConditionalCheckFailed", "None"]),
    );

    expect(
      claimBrainIndexJob({ database, job: (await current())!, leaseOwner: "w-1", ...lease }),
    ).rejects.toMatchObject({ reason: "conflict" });
    expect((await current())?.data).toMatchObject({ status: "queued", version: 6 });
  });

  test("fails terminally after its last attempt and leaves the work queue", async () => {
    const { current, database, health } = await store(
      "active",
      job({ attempt: BRAIN_INDEX_MAX_ATTEMPTS - 1 }),
    );
    const claimed = await claimBrainIndexJob({
      database,
      job: (await current())!,
      leaseOwner: "w-1",
      ...lease,
    });
    if (claimed?.outcome !== "claimed") throw new Error("expected a claim");
    expect(claimed.job.data.attempt).toBe(BRAIN_INDEX_MAX_ATTEMPTS);

    const failed = await failBrainIndexJob({
      cause: new Error("Pinned model route identity is not canonical."),
      database,
      job: claimed.job,
      now,
      permanent: false,
    });

    expect(failed.data).toMatchObject({
      error: "Pinned model route identity is not canonical.",
      skipReason: BRAIN_INDEX_RETRIES_EXHAUSTED,
      status: "failed",
    });
    expect(failed.data).not.toHaveProperty("nextDueAt");
    expect(failed).not.toHaveProperty("gsi1pk");
    expect(isTerminalBrainIndexJob(failed)).toBe(true);
    expect(requeueBrainIndexJob({ database, job: failed, now })).rejects.toThrow(
      "retryable failed",
    );
    expect(await health()).toEqual([
      failedHealth(0, "Pinned model route identity is not canonical."),
    ]);
  });

  test("ends a permanent failure on its first attempt and reports it in index health", async () => {
    const failing = runningJob();
    const { database, health } = await store("active", failing);

    const failed = await failBrainIndexJob({
      cause: new Error(lastError),
      database,
      job: failing,
      now,
      permanent: true,
    });

    expect(failed.data).toMatchObject({
      attempt: 1,
      error: lastError,
      skipReason: "permanent-failure",
      status: "failed",
    });
    expect(failed.data).not.toHaveProperty("nextDueAt");
    expect(isTerminalBrainIndexJob(failed)).toBe(true);
    expect(await health()).toEqual([failedHealth(0, lastError)]);
  });

  test("keeps the chunks an earlier generation published when a later one fails", async () => {
    const failing = runningJob({ expectedProjectionGeneration: 1 });
    const { database, health } = await store("active", failing);
    await database.transactWrite([{ kind: "put", record: readyState(0) }]);

    await failBrainIndexJob({
      cause: new Error(lastError),
      database,
      job: failing,
      now,
      permanent: true,
    });

    expect(await health()).toEqual([failedHealth(1, lastError)]);
    expect((await getBrainIndexState(database, organizationId, documentId))?.data).toMatchObject({
      chunkIds: ["published-chunk"],
      version: 1,
    });
  });

  test("leaves a newer generation's index state to the job that wrote it", async () => {
    const failing = runningJob();
    const { current, database, health } = await store("active", failing);
    await database.transactWrite([{ kind: "put", record: readyState(1) }]);

    await failBrainIndexJob({
      cause: new Error(lastError),
      database,
      job: failing,
      now,
      permanent: true,
    });

    expect((await current())?.data).toMatchObject({
      skipReason: "permanent-failure",
      status: "failed",
    });
    expect(await health()).toEqual([
      {
        components: [{ kind: "dense", status: "ready", updatedAt: createdAt }],
        documentId,
        documentVersionId: "01M403FPZ6T94GBCFS3W9HSAWB",
        projectionGeneration: 1,
        status: "ready",
        synchronizedAt: createdAt,
        updatedAt: createdAt,
      },
    ]);
  });

  test("keeps retrying with a due time before the last attempt", async () => {
    const { current, database, health } = await store("active", job());
    const claimed = await claimBrainIndexJob({
      database,
      job: (await current())!,
      leaseOwner: "w-1",
      ...lease,
    });
    if (claimed?.outcome !== "claimed") throw new Error("expected a claim");

    const failed = await failBrainIndexJob({
      cause: new Error("provider unavailable"),
      database,
      job: claimed.job,
      now,
      permanent: false,
    });

    expect(failed.data.nextDueAt).toBe("2026-10-03T06:00:40.000Z");
    expect(failed.data).not.toHaveProperty("skipReason");
    expect(failed.gsi1pk).toMatch(/^QUEUE#BRAIN-INDEX-JOB#failed#/u);
    expect(isTerminalBrainIndexJob(failed)).toBe(false);
    expect(await health()).toEqual([]);
  });

  test("stops recovering a worker that crashes on every claim", async () => {
    const running = job({
      attempt: BRAIN_INDEX_MAX_ATTEMPTS,
      leaseExpiresAt: "2026-10-03T05:50:00.000Z",
      leaseOwner: "crashed-worker",
      status: "running",
    });
    const { database, health } = await store("active", running);

    const recovered = await recoverExpiredBrainIndexJob({ database, job: running, now });

    expect(recovered?.data).toMatchObject({
      skipReason: BRAIN_INDEX_RETRIES_EXHAUSTED,
      status: "failed",
    });
    expect(recovered?.data).not.toHaveProperty("nextDueAt");
    expect(isTerminalBrainIndexJob(recovered!)).toBe(true);
    expect(await health()).toEqual([
      failedHealth(0, "The previous Brain index worker lease expired before completion."),
    ]);
  });
});
