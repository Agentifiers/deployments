import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  type ObjectIdentifier,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  brainUploadTicketFromPlatformRecord,
  expireBrainUploadTicket,
  key,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  apiPersistence,
} from "@deployments-ai/db";

const SHARD_COUNT = 16;
const PAGE_LIMIT = 25;
const QUIESCENCE_MS = 5 * 60_000;
const RETRY_MS = 5 * 60_000;
type Cleanup = Extract<PlatformRecord, { readonly itemType: "brain-content-cleanup" }>;
type Ticket = Extract<PlatformRecord, { readonly itemType: "brain-upload-ticket" }>;

async function strongRecord(
  database: DynamoDatabaseService,
  table: "control" | "execution",
  candidate: PlatformRecord,
) {
  return await apiPersistence.read(database, table, { pk: candidate.pk, sk: candidate.sk }, true);
}

async function dueQueueRecords(input: {
  readonly database: DynamoDatabaseService;
  readonly itemType: "brain-content-cleanup" | "brain-upload-ticket";
  readonly now: string;
  readonly statuses: readonly string[];
  readonly table: "control" | "execution";
}) {
  const records: PlatformRecord[] = [];
  for (const status of input.statuses) {
    for (let shard = 0; shard < SHARD_COUNT; shard += 1) {
      const partition = key(
        "QUEUE",
        input.itemType.toUpperCase(),
        status,
        String(shard).padStart(2, "0"),
      );
      const page = await apiPersistence.find(input.database, input.table, {
        ConsistentRead: false,
        ExpressionAttributeValues: {
          ":due": key("00000000", input.now, "ZZZZZZZZZZZZZZZZZZZZZZZZZZ"),
          ":pk": partition,
        },
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk AND gsi1sk <= :due",
        Limit: PAGE_LIMIT,
      });
      records.push(...page.items);
    }
  }
  return records;
}

async function activeLease(database: DynamoDatabaseService, ticket: Ticket) {
  const page = await apiPersistence.find(database, "control", {
    ConsistentRead: true,
    ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
    ExpressionAttributeValues: {
      ":pk": key("ORG", ticket.data.organizationId, "BRAIN", ticket.data.brainId),
      ":prefix": key("BRAIN-UPLOAD-LEASE"),
    },
    KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
    Limit: 100,
  });
  const lease = page.items.find(
    (record) =>
      record.itemType === "brain-upload-lease" &&
      record.data.ticketId === ticket.data.id &&
      record.data.status === "active",
  );
  return lease?.itemType === "brain-upload-lease" ? { ...lease.data } : undefined;
}

async function expireTicket(input: {
  readonly bucket: string;
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Promise<string>;
  readonly legacyBuckets: readonly string[];
  readonly now: string;
  readonly record: PlatformRecord;
  readonly s3: Pick<S3Client, "send">;
}) {
  const current = await strongRecord(input.database, "control", input.record);
  if (
    current?.itemType !== "brain-upload-ticket" ||
    !["completed", "issued", "rejected", "streaming"].includes(current.data.status) ||
    current.data.expiresAt > input.now
  ) {
    return false;
  }
  const ticket = brainUploadTicketFromPlatformRecord(current);
  const lease = await activeLease(input.database, current);
  const allowedBuckets = [input.bucket, ...input.legacyBuckets];
  let cleanupBucket = ticket.bodyRef?.bucket;
  if (cleanupBucket && !allowedBuckets.includes(cleanupBucket)) {
    throw new Error("Brain upload ticket points outside the approved content buckets.");
  }
  if (!cleanupBucket) {
    for (const candidate of allowedBuckets) {
      if ((await exactObjectVersions(input.s3, candidate, ticket.objectKey)).length > 0) {
        cleanupBucket = candidate;
        break;
      }
    }
  }
  const result = await expireBrainUploadTicket({
    bucket: cleanupBucket ?? input.bucket,
    database: input.database,
    eventId: await input.generateId(),
    ...(lease ? { lease } : {}),
    now: input.now,
    ticket,
  });
  return result !== undefined;
}

async function exactObjectVersions(s3: Pick<S3Client, "send">, bucket: string, objectKey: string) {
  const versions: ObjectIdentifier[] = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        MaxKeys: 1_000,
        Prefix: objectKey,
        ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
      }),
    );
    for (const value of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
      if (value.Key === objectKey && value.VersionId) {
        versions.push({ Key: objectKey, VersionId: value.VersionId });
      }
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker);
  return versions;
}

async function putCleanup(
  database: DynamoDatabaseService,
  cleanup: Cleanup,
  data: Cleanup["data"],
) {
  const next = withCanonicalRecordKeys({ ...cleanup, data }) as Cleanup;
  await apiPersistence.commit(database, [{ kind: "put", previousRecord: cleanup, record: next }]);
}

async function finishCleanup(database: DynamoDatabaseService, cleanup: Cleanup) {
  const operations: TransactionOperation[] = [{ kind: "delete", record: cleanup }];
  if (cleanup.data.ticketId) {
    const ticket = await apiPersistence.read(
      database,
      "control",
      {
        pk: key("ORG", cleanup.data.organizationId, "BRAIN", cleanup.data.brainId),
        sk: key("BRAIN-UPLOAD-TICKET", cleanup.data.ticketId),
      },
      true,
    );
    if (
      ticket?.itemType === "brain-upload-ticket" &&
      ticket.data.status === "expired" &&
      ticket.data.objectKey === cleanup.data.objectKey
    ) {
      operations.push({ kind: "delete", record: ticket });
    }
  }
  await apiPersistence.commit(database, operations);
}

async function processCleanup(input: {
  readonly database: DynamoDatabaseService;
  readonly now: Date;
  readonly record: PlatformRecord;
  readonly s3: Pick<S3Client, "send">;
}) {
  const observed = await strongRecord(input.database, "execution", input.record);
  if (
    observed?.itemType !== "brain-content-cleanup" ||
    observed.data.status === "verified" ||
    observed.data.nextDueAt > input.now.toISOString()
  ) {
    return false;
  }
  const cleanup = observed;
  try {
    const versions = await exactObjectVersions(
      input.s3,
      cleanup.data.bucket,
      cleanup.data.objectKey,
    );
    if (versions.length > 0) {
      for (let offset = 0; offset < versions.length; offset += 1_000) {
        const response = await input.s3.send(
          new DeleteObjectsCommand({
            Bucket: cleanup.data.bucket,
            Delete: { Objects: versions.slice(offset, offset + 1_000), Quiet: true },
          }),
        );
        if (response.Errors?.length) throw new Error("Brain content deletion was partial.");
      }
      await putCleanup(input.database, cleanup, {
        ...cleanup.data,
        nextDueAt: new Date(input.now.getTime() + RETRY_MS).toISOString(),
        status: "deleting",
        updatedAt: input.now.toISOString(),
        verificationCount: 0,
        version: cleanup.data.version + 1,
      });
      return true;
    }
    const quiescenceStartedAt = cleanup.data.quiescenceStartedAt
      ? Date.parse(cleanup.data.quiescenceStartedAt)
      : Number.NaN;
    if (
      cleanup.data.verificationCount < 1 ||
      !Number.isFinite(quiescenceStartedAt) ||
      input.now.getTime() - quiescenceStartedAt < QUIESCENCE_MS
    ) {
      await putCleanup(input.database, cleanup, {
        ...cleanup.data,
        nextDueAt: new Date(input.now.getTime() + QUIESCENCE_MS).toISOString(),
        quiescenceStartedAt: input.now.toISOString(),
        status: "deleting",
        updatedAt: input.now.toISOString(),
        verificationCount: 1,
        version: cleanup.data.version + 1,
      });
      return true;
    }
    await finishCleanup(input.database, cleanup);
    return true;
  } catch (cause) {
    await putCleanup(input.database, cleanup, {
      ...cleanup.data,
      error: cause instanceof Error ? cause.message.slice(0, 1_024) : "Cleanup failed.",
      nextDueAt: new Date(input.now.getTime() + RETRY_MS).toISOString(),
      status: "deleting",
      updatedAt: input.now.toISOString(),
      version: cleanup.data.version + 1,
    });
    throw cause;
  }
}

export async function maintainBrainContent(input: {
  readonly bucket: string;
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Promise<string>;
  readonly legacyBuckets?: readonly string[];
  readonly now: Date;
  readonly s3: Pick<S3Client, "send">;
}) {
  const now = input.now.toISOString();
  const [tickets, cleanups] = await Promise.all([
    dueQueueRecords({
      database: input.database,
      itemType: "brain-upload-ticket",
      now,
      statuses: ["completed", "issued", "rejected", "streaming"],
      table: "control",
    }),
    dueQueueRecords({
      database: input.database,
      itemType: "brain-content-cleanup",
      now,
      statuses: ["deleting", "pending"],
      table: "execution",
    }),
  ]);
  let expired = 0;
  for (const record of tickets) {
    if (await expireTicket({ ...input, legacyBuckets: input.legacyBuckets ?? [], now, record })) {
      expired += 1;
    }
  }
  let cleaned = 0;
  for (const record of cleanups) {
    if (await processCleanup({ ...input, record })) cleaned += 1;
  }
  return { cleaned, expired };
}
