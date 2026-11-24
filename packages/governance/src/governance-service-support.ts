import {
  governanceThreadIds,
  inputFileTextKey,
  type PlatformRecord,
  type TenantRecordSelection,
} from "@deployments-ai/db";
import { canonicalJson, ordinalCompare, sha256 } from "./canonical.ts";
import {
  GovernanceError,
  RETENTION_CLASSES,
  type ErasureReceipt,
  type GovernanceObjectReference,
  type GovernanceOperation,
  type GovernanceServiceOptions,
  type RetentionCleanup,
  type RetentionPolicy,
  type TenantRecord,
} from "./types.ts";

export const encoder = new TextEncoder();
export const decoder = new TextDecoder("utf-8", { fatal: true });
export const DAY_MILLISECONDS = 86_400_000;
export const MAX_RETENTION_DAYS = 3_650;
export const MIN_AUDIT_RETENTION_DAYS = 365;
export const MAX_EXPORT_RECORDS = 1_000_000;
export const MAX_TENANT_EXPORT_BLOBS = 10_000;
export const TENANT_EXPORT_BLOB_READ_CONCURRENCY = 16;
// Export assembly temporarily holds UTF-16 lines, their joined string, and encoded bytes.
// Keep the accepted body well below the 2 GiB worker limit until uploads become streaming.
export const MAX_EXPORT_BYTES = 128 * 1_024 * 1_024;
export const MAX_TENANT_SNAPSHOT_BYTES = 512 * 1_024 * 1_024;
export const MAX_TENANT_EXPORT_TOTAL_BYTES = 2 * 1_024 * 1_024 * 1_024;
export const TENANT_EXPORT_PART_BYTES = 8 * 1_024 * 1_024;
export const OPERATION_LEASE_MILLISECONDS = 16 * 60 * 1_000;
export const RETENTION_FENCE_LEASE_MILLISECONDS = 30 * 60 * 1_000;
// Each completed cleanup deletes only its own record and directory pointer, so completions can
// run concurrently. Staging stays sequential: every staging transaction also checks the shared
// organization fence and organization record, and concurrent transactions on a shared item
// cancel each other.
export const RETENTION_CLEANUP_CONCURRENCY = 16;

export interface AuditArchiveState {
  readonly firstEventAt?: string;
  readonly lastEventAt?: string;
  readonly recordCount: number;
  readonly rootHash: string;
}

export function inspectAuditArchive(
  reference: GovernanceObjectReference,
  body: Uint8Array,
  organizationId: string,
): AuditArchiveState {
  const mismatch = (message: string): never => {
    throw new GovernanceError("audit_export_retry_mismatch", message);
  };
  if (body.byteLength !== reference.sizeBytes || sha256(body) !== reference.sha256) {
    return mismatch("The checkpointed audit archive does not match its immutable reference.");
  }
  if (body.byteLength === 0) {
    return { recordCount: 0, rootHash: "0".repeat(64) };
  }

  let text: string;
  try {
    text = decoder.decode(body);
  } catch {
    return mismatch("The checkpointed audit archive is not valid UTF-8.");
  }
  if (!text.endsWith("\n")) {
    return mismatch("The checkpointed audit archive is not canonical JSONL.");
  }

  const lines = text.slice(0, -1).split("\n");
  let previousHash = "0".repeat(64);
  let firstEventAt: string | undefined;
  let lastEventAt: string | undefined;
  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return mismatch("The checkpointed audit archive contains invalid JSON.");
    }
    if (!entry || typeof entry !== "object") {
      return mismatch("The checkpointed audit archive contains an invalid chain entry.");
    }
    const chainEntry = entry as Readonly<Record<string, unknown>>;
    const value = chainEntry.value;
    if (!value || typeof value !== "object") {
      return mismatch("The checkpointed audit archive contains an invalid audit value.");
    }
    const auditRecord = value as Readonly<Record<string, unknown>>;
    const data = auditRecord.data;
    if (
      auditRecord.itemType !== "audit-event" ||
      !data ||
      typeof data !== "object" ||
      (data as Readonly<Record<string, unknown>>).organizationId !== organizationId
    ) {
      return mismatch("The checkpointed audit archive contains an event outside its tenant.");
    }
    const occurredAt = (data as Readonly<Record<string, unknown>>).occurredAt;
    if (typeof occurredAt !== "string") {
      return mismatch("The checkpointed audit archive contains an event without a timestamp.");
    }
    const expectedHash = sha256(`${previousHash}\n${canonicalJson(value)}`);
    if (
      chainEntry.previousHash !== previousHash ||
      chainEntry.entryHash !== expectedHash ||
      canonicalJson(chainEntry) !== line
    ) {
      return mismatch("The checkpointed audit archive hash chain is invalid.");
    }
    firstEventAt ??= occurredAt;
    lastEventAt = occurredAt;
    previousHash = expectedHash;
  }

  return {
    ...(firstEventAt ? { firstEventAt } : {}),
    ...(lastEventAt ? { lastEventAt } : {}),
    recordCount: lines.length,
    rootHash: previousHash,
  };
}

export const BLOB_REFERENCE_FIELDS = {
  "agent-release": ["artifact"],
  artifact: ["storage"],
  "brain-document-rendition": ["bodyRef"],
  "brain-document-version": ["bodyRef"],
  "brain-content-cleanup": ["bodyRef"],
  "brain-upload-ticket": ["bodyRef"],
  "dataset-case": ["material"],
  "governance-operation": ["archive", "output"],
  "immutable-audit-export": ["archive", "object"],
  "inbox-attachment": ["storage"],
  "inbox-draft": ["htmlBodyRef", "textBodyRef"],
  "inbox-message": ["htmlBodyRef", "rawReference", "textBodyRef"],
  "managed-skill": ["content"],
  memory: ["bodyRef"],
  message: ["bodyRef"],
  "model-invocation": ["requestBodyRef", "responseBodyRef"],
  "pdf-job": ["artifact"],
  "release-comparison": ["reportJson", "reportMarkdown"],
  "sandbox-workspace": ["snapshot"],
} as const satisfies Partial<Record<PlatformRecord["itemType"], readonly string[]>>;

/**
 * Blob fields that retention and erasure delete but tenant export omits. The owning record
 * is still exported with its reference; only the object bytes are skipped, because sandbox
 * workspace archives (up to 5 GiB each) are reproducible operational state that would
 * exceed the in-memory tenant export bounds.
 */
export const TENANT_EXPORT_EXCLUDED_BLOB_FIELDS = {
  "sandbox-workspace": ["snapshot"],
} as const satisfies {
  readonly [ItemType in keyof typeof BLOB_REFERENCE_FIELDS]?: readonly (typeof BLOB_REFERENCE_FIELDS)[ItemType][number][];
};

export function validatePolicy(policy: RetentionPolicy) {
  for (const retentionClass of RETENTION_CLASSES) {
    const value = policy[retentionClass];
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RETENTION_DAYS) {
      throw new GovernanceError(
        "invalid_retention_policy",
        `${retentionClass} retention must be an integer from 1 to ${MAX_RETENTION_DAYS} days.`,
      );
    }
  }
  if (policy.audit < MIN_AUDIT_RETENTION_DAYS) {
    throw new GovernanceError(
      "invalid_retention_policy",
      `Audit retention must be at least ${MIN_AUDIT_RETENTION_DAYS} days.`,
    );
  }
}

export function sortTenantRecords(records: readonly TenantRecord[]) {
  return [...records].sort(
    (left, right) =>
      ordinalCompare(left.table, right.table) ||
      ordinalCompare(left.record.pk, right.record.pk) ||
      ordinalCompare(left.record.sk, right.record.sk),
  );
}

/**
 * Filters one inventory listing's pages down to records not already returned earlier in it. While
 * a deploy switches shard writes on, a record can have a locator on both its legacy partition and
 * its shard, so one listing can return it twice, on the same page or on different ones.
 */
export function distinctTenantRecords() {
  const seen = new Set<string>();
  return (items: readonly TenantRecord[]) =>
    items.filter(({ record, table }) => {
      const key = `${table}\u0000${record.pk}\u0000${record.sk}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * Pages the organization inventory into one sorted snapshot. With a `selection`, only the chosen
 * records resolve and the global legacy principal-idempotency partition is skipped: those records
 * carry no retention class, activity, or object reference, so only export and erasure need them.
 */
export async function allTenantRecords(
  options: Pick<GovernanceServiceOptions, "snapshotByteLimit" | "store">,
  organizationId: string,
  selection?: TenantRecordSelection,
) {
  const records: TenantRecord[] = [];
  const unseen = distinctTenantRecords();
  let snapshotBytes = 0;
  const snapshotByteLimit = Math.min(
    options.snapshotByteLimit ?? MAX_TENANT_SNAPSHOT_BYTES,
    MAX_TENANT_SNAPSHOT_BYTES,
  );
  if (!Number.isSafeInteger(snapshotByteLimit) || snapshotByteLimit < 1) {
    throw new GovernanceError(
      "invalid_snapshot_byte_limit",
      "The governance snapshot byte limit must be a positive safe integer.",
    );
  }
  const addRecords = (items: readonly TenantRecord[]) => {
    for (const item of unseen(items)) {
      snapshotBytes += encoder.encode(
        canonicalJson({ record: item.record, table: item.table }),
      ).byteLength;
      if (snapshotBytes > snapshotByteLimit) {
        throw new GovernanceError(
          "tenant_export_too_large",
          `Governance tenant snapshots cannot exceed ${snapshotByteLimit} bytes.`,
        );
      }
      records.push(item);
      if (records.length > MAX_EXPORT_RECORDS) {
        throw new GovernanceError(
          "tenant_export_too_large",
          `Governance operations support at most ${MAX_EXPORT_RECORDS} records per tenant snapshot.`,
        );
      }
    }
  };
  let cursor: string | undefined;
  do {
    const page = await options.store.listTenantRecords(organizationId, cursor, selection);
    addRecords(page.items);
    cursor = page.cursor;
  } while (cursor);
  const runtimeLeaseIds = new Set<string>();
  for (const { record } of records) {
    const data = record.data as Readonly<Record<string, unknown>>;
    if (record.itemType === "thread" && typeof data.id === "string") {
      runtimeLeaseIds.add(data.id);
    }
    if (typeof data.threadId === "string") runtimeLeaseIds.add(data.threadId);
  }
  addRecords(await options.store.listLegacyRuntimeLeases([...runtimeLeaseIds]));
  if (!selection) {
    addRecords(await options.store.listLegacyPrincipalIdempotency(organizationId));
  }
  return sortTenantRecords(records);
}

export interface TenantBlobReference {
  bucket: string;
  contentType?: string;
  deleteAllVersions?: boolean;
  key: string;
  sha256?: string;
  sizeBytes?: number;
  versionId?: string | undefined;
}

/** Only the bucket allow-list bounds which blob references are in the tenant's scope. */
type BlobReferenceScope = Pick<GovernanceServiceOptions, "allowedObjectBuckets">;

function tenantBlobReference(
  options: BlobReferenceScope,
  organizationId: string,
  value: unknown,
): TenantBlobReference | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Readonly<Record<string, unknown>>;
  if (typeof candidate.bucket !== "string" || typeof candidate.key !== "string") return undefined;
  const keySegments = candidate.key.split("/");
  const organizationMarker = keySegments.indexOf("organizations");
  const keyOrganizationId =
    organizationMarker >= 0
      ? keySegments[organizationMarker + 1]
      : keySegments[0] === "governance"
        ? keySegments[1]
        : undefined;
  const organizationScoped = keyOrganizationId === organizationId;
  if (!options.allowedObjectBuckets.includes(candidate.bucket) || !organizationScoped) {
    throw new GovernanceError(
      "tenant_blob_scope_violation",
      `Blob reference ${candidate.bucket}/${candidate.key} is outside the tenant governance boundary.`,
    );
  }
  return {
    bucket: candidate.bucket,
    ...(typeof candidate.contentType === "string" ? { contentType: candidate.contentType } : {}),
    key: candidate.key,
    ...(typeof candidate.sha256 === "string" ? { sha256: candidate.sha256 } : {}),
    ...(typeof candidate.byteSize === "number" ? { sizeBytes: candidate.byteSize } : {}),
    ...(typeof candidate.versionId === "string" ? { versionId: candidate.versionId } : {}),
  };
}

export function blobReferences(
  options: BlobReferenceScope,
  organizationId: string,
  record: PlatformRecord,
  includeImmutableAuditExports = false,
  includePendingContentCleanup = false,
) {
  const references: TenantBlobReference[] = [];
  const addReference = (value: unknown) => {
    const reference = tenantBlobReference(options, organizationId, value);
    if (reference) references.push(reference);
  };
  if (record.itemType === "retention-cleanup") {
    for (const reference of record.data.references) {
      references.push(reference);
    }
    return references;
  }
  if (record.itemType === "inbox-content-cleanup") {
    if (includePendingContentCleanup && record.data.status === "pending") {
      for (const reference of record.data.references) {
        addReference(reference);
      }
    }
    return references;
  }
  if (
    !includeImmutableAuditExports &&
    (record.itemType === "immutable-audit-export" ||
      (record.itemType === "governance-operation" && record.data.kind === "audit-export"))
  ) {
    return references;
  }
  const fields = BLOB_REFERENCE_FIELDS[record.itemType as keyof typeof BLOB_REFERENCE_FIELDS] ?? [];
  const data = record.data as Readonly<Record<string, unknown>>;
  for (const field of fields) {
    addReference(data[field]);
  }
  if (record.itemType === "artifact" && record.data.input?.kind === "document") {
    const { id, input, storage } = record.data;
    addReference({
      bucket: storage.bucket,
      byteSize: input.text.byteSize,
      key: inputFileTextKey(record.data, id, storage.sha256),
      sha256: input.text.sha256,
      versionId: input.text.versionId,
    });
  }
  return references;
}

/** The subset of `blobReferences` that tenant export records but does not copy. */
export function tenantExportExcludedBlobReferences(
  options: BlobReferenceScope,
  organizationId: string,
  record: PlatformRecord,
) {
  const fields: readonly string[] =
    TENANT_EXPORT_EXCLUDED_BLOB_FIELDS[
      record.itemType as keyof typeof TENANT_EXPORT_EXCLUDED_BLOB_FIELDS
    ] ?? [];
  const data = record.data as Readonly<Record<string, unknown>>;
  return fields.flatMap((field) => tenantBlobReference(options, organizationId, data[field]) ?? []);
}

export async function deleteTenantBlobs(
  options: GovernanceServiceOptions,
  organizationId: string,
  records: readonly TenantRecord[],
  includeImmutableAuditExports = false,
) {
  for (const item of records) {
    for (const reference of blobReferences(
      options,
      organizationId,
      item.record,
      includeImmutableAuditExports,
      true,
    )) {
      if (
        reference.deleteAllVersions === false ||
        item.record.itemType === "immutable-audit-export" ||
        (item.record.itemType === "governance-operation" &&
          item.record.data.kind === "audit-export")
      ) {
        await options.objectStore.delete(reference);
      } else {
        await options.objectStore.deleteAllVersions(reference);
      }
    }
  }
}

export async function deleteRecordsAndBlobs(
  options: GovernanceServiceOptions,
  organizationId: string,
  records: readonly TenantRecord[],
  retryDeadline: string,
  includeImmutableAuditExports = false,
) {
  await deleteTenantBlobs(options, organizationId, records, includeImmutableAuditExports);
  await options.store.deleteTenantRecords(records, retryDeadline);
}

export async function deleteTenantErasureObjectPrefixes(
  options: GovernanceServiceOptions,
  organizationId: string,
) {
  for (const configured of options.tenantErasureObjectPrefixes ?? []) {
    if (!options.allowedObjectBuckets.includes(configured.bucket)) {
      throw new GovernanceError(
        "tenant_blob_scope_violation",
        `Tenant erasure prefix bucket ${configured.bucket} is outside the governance boundary.`,
      );
    }
    const root = configured.keyPrefixRoot.replace(/^\/+|\/+$/gu, "");
    if (!root || root.includes("..")) {
      throw new GovernanceError(
        "tenant_blob_scope_violation",
        "Tenant erasure object prefix root is invalid.",
      );
    }
    if (!options.objectStore.deleteAllVersionsUnderPrefix) {
      throw new GovernanceError(
        "tenant_blob_delete_unavailable",
        "Tenant erasure object-prefix deletion is unavailable.",
      );
    }
    await options.objectStore.deleteAllVersionsUnderPrefix({
      bucket: configured.bucket,
      keyPrefix: `${root}/${organizationId}/`,
    });
  }
}

export function retentionCleanupId(item: TenantRecord) {
  return sha256(`${item.table}\u0000${item.record.pk}\u0000${item.record.sk}`);
}

export async function stageExpiredRecords(
  options: GovernanceServiceOptions,
  organizationId: string,
  records: readonly TenantRecord[],
  createdAt: string,
  fenceOperationId?: string,
) {
  const staged: { cleanup: RetentionCleanup; item: TenantRecord }[] = [];
  const stage = async (item: TenantRecord) => {
    let discovered: (GovernanceObjectReference | undefined)[] = [];
    if (item.record.itemType === "governance-operation") {
      const operationId = item.record.data.id;
      const names =
        item.record.data.kind === "tenant-export"
          ? ["tenant.jsonl"]
          : item.record.data.kind === "audit-export"
            ? ["audit-records.jsonl", "audit-manifest.json"]
            : [];
      discovered = await Promise.all(
        names.map((name) =>
          options.objectStore.find(`governance/${organizationId}/${operationId}/${name}`),
        ),
      );
    }
    const references = [
      ...blobReferences(options, organizationId, item.record, true),
      ...discovered.filter(
        (reference): reference is GovernanceObjectReference => reference !== undefined,
      ),
    ]
      .filter(
        (reference, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.bucket === reference.bucket &&
              candidate.key === reference.key &&
              candidate.versionId === reference.versionId,
          ) === index,
      )
      .map((reference) => ({
        bucket: reference.bucket,
        deleteAllVersions:
          item.record.itemType !== "immutable-audit-export" &&
          !(
            item.record.itemType === "governance-operation" &&
            item.record.data.kind === "audit-export"
          ),
        key: reference.key,
        ...(reference.versionId ? { versionId: reference.versionId } : {}),
      }));
    const threadIds = governanceThreadIds(item.record);
    const cleanup: RetentionCleanup = {
      createdAt,
      id: retentionCleanupId(item),
      organizationId,
      references,
      sourceItemType: item.record.itemType,
      sourcePk: item.record.pk,
      ...((item.record.itemType === "inbox-message" ||
        item.record.itemType === "inbox-draft" ||
        item.record.itemType === "inbox-thread") &&
      typeof (item.record.data as Readonly<Record<string, unknown>>).id === "string"
        ? {
            sourceResourceId: (item.record.data as { readonly id: string }).id,
          }
        : {}),
      sourceSk: item.record.sk,
      sourceTable: item.table,
      ...(threadIds.length > 0 ? { threadIds } : {}),
    };
    if (await options.store.stageRetentionCleanup(item, cleanup, fenceOperationId)) {
      staged.push({ cleanup, item });
    }
  };
  for (const item of records) await stage(item);
  return staged;
}

export async function completeRetentionCleanups(
  options: GovernanceServiceOptions,
  organizationId: string,
  pendingCleanups: readonly RetentionCleanup[],
  liveRecords: readonly TenantRecord[],
  observedAt: string,
) {
  const liveReferences = liveRecords.flatMap((item) =>
    item.record.itemType === "retention-cleanup"
      ? []
      : blobReferences(options, organizationId, item.record, true, true),
  );
  const complete = async (cleanup: RetentionCleanup) => {
    if (cleanup.notBefore && Date.parse(cleanup.notBefore) > Date.parse(observedAt)) return;
    for (const reference of cleanup.references) {
      const liveAtKey = liveReferences.filter(
        (candidate) => candidate.bucket === reference.bucket && candidate.key === reference.key,
      );
      if (liveAtKey.length > 0) {
        if (
          reference.versionId &&
          liveAtKey.every((candidate) => candidate.versionId !== reference.versionId)
        ) {
          await options.objectStore.delete(reference);
        }
        continue;
      }
      if (reference.deleteAllVersions) {
        await options.objectStore.deleteAllVersions(reference);
      } else {
        await options.objectStore.delete(reference);
      }
    }
    await options.store.completeRetentionCleanup(cleanup);
  };
  for (let offset = 0; offset < pendingCleanups.length; offset += RETENTION_CLEANUP_CONCURRENCY) {
    await Promise.all(
      pendingCleanups.slice(offset, offset + RETENTION_CLEANUP_CONCURRENCY).map(complete),
    );
  }
}

export function completedErasureOperation(
  organizationId: string,
  receipt: Pick<
    ErasureReceipt,
    | "auditRootHash"
    | "completedAt"
    | "id"
    | "memorySearch"
    | "observability"
    | "recordsDeleted"
    | "requestedByPrincipalHash"
  >,
  current?: GovernanceOperation,
): GovernanceOperation {
  return {
    completedAt: receipt.completedAt,
    createdAt: current?.createdAt ?? receipt.completedAt,
    id: receipt.id,
    idempotencyKey: current?.idempotencyKey ?? receipt.id,
    kind: "tenant-erasure",
    organizationId,
    requestedByPrincipalId: current?.requestedByPrincipalId ?? receipt.requestedByPrincipalHash,
    startedAt: current?.startedAt ?? receipt.completedAt,
    status: "completed",
    summary: {
      auditRootHash: receipt.auditRootHash,
      ...(receipt.memorySearch ? { memorySearch: receipt.memorySearch } : {}),
      ...(receipt.observability ? { observability: receipt.observability } : {}),
      recordsDeleted: receipt.recordsDeleted,
    },
    updatedAt: receipt.completedAt,
    version: current ? current.version + 1 : 3,
  };
}
