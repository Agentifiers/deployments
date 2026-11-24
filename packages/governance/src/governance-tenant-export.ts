import { canonicalJson, ordinalCompare, sha256 } from "./canonical.ts";
import type { GovernanceServiceContext } from "./service.ts";
import {
  blobReferences,
  encoder,
  MAX_EXPORT_BYTES,
  MAX_TENANT_EXPORT_BLOBS,
  MAX_TENANT_EXPORT_TOTAL_BYTES,
  sortTenantRecords,
  TENANT_EXPORT_BLOB_READ_CONCURRENCY,
  TENANT_EXPORT_PART_BYTES,
  tenantExportExcludedBlobReferences,
  type TenantBlobReference as BlobReference,
} from "./service.ts";
import {
  GovernanceError,
  GovernanceObjectNotFoundError,
  type AppTableObject,
  type GovernanceObjectReference,
  type GovernanceOperation,
  type TenantRecord,
} from "./types.ts";

/** Declared blobs deliberately left out of the export body; see `TENANT_EXPORT_EXCLUDED_BLOB_FIELDS`. */
interface ExcludedBlobs {
  readonly excludedBlobBytes: number;
  readonly excludedBlobCount: number;
}

interface ExportBlob {
  readonly optional: boolean;
  readonly reference: BlobReference;
  readonly sizeBytes: number;
}

function referenceIdentity(reference: BlobReference) {
  return `${reference.bucket}\u0000${reference.key}\u0000${reference.versionId ?? ""}`;
}

async function checkpoint(
  context: GovernanceServiceContext,
  current: GovernanceOperation,
  object: GovernanceObjectReference,
  summary: Readonly<Record<string, unknown>>,
) {
  return context.options.store.updateOperation(
    {
      ...current,
      output: object,
      summary,
      updatedAt: context.now().toISOString(),
      version: current.version + 1,
    },
    current.version,
  );
}

function collectReferences(
  context: GovernanceServiceContext,
  organizationId: string,
  records: readonly TenantRecord[],
  appTables: readonly AppTableObject[],
) {
  const references = new Map<
    string,
    { readonly optional: boolean; readonly reference: BlobReference }
  >();
  for (const reference of appTables) {
    if (!context.options.allowedObjectBuckets.includes(reference.bucket)) {
      throw new GovernanceError(
        "tenant_blob_scope_violation",
        `App table ${reference.bucket}/${reference.key} is outside the tenant governance boundary.`,
      );
    }
    references.set(referenceIdentity(reference), { optional: false, reference });
  }
  const excluded = new Map<string, BlobReference>();
  for (const { record } of records) {
    if (record.itemType === "governance-operation" && record.data.kind === "tenant-export") {
      continue;
    }
    const excludedIdentities = new Set(
      tenantExportExcludedBlobReferences(context.options, organizationId, record).map(
        referenceIdentity,
      ),
    );
    for (const reference of blobReferences(context.options, organizationId, record, true, true)) {
      const identity = referenceIdentity(reference);
      if (excludedIdentities.has(identity)) {
        excluded.set(identity, reference);
        continue;
      }
      const previous = references.get(identity);
      const optional =
        record.itemType === "inbox-content-cleanup" && record.data.status === "pending";
      references.set(identity, {
        optional: (previous?.optional ?? true) && optional,
        reference: previous && !previous.optional ? previous.reference : reference,
      });
    }
  }
  // An object also reached through an exported field is exported, not excluded.
  for (const identity of references.keys()) excluded.delete(identity);
  const sorted = [...references.values()].sort((left, right) =>
    ordinalCompare(referenceIdentity(left.reference), referenceIdentity(right.reference)),
  );
  if (sorted.length > MAX_TENANT_EXPORT_BLOBS) {
    throw new GovernanceError(
      "tenant_export_too_many_blobs",
      `Tenant exports support at most ${MAX_TENANT_EXPORT_BLOBS} referenced blobs per operation.`,
    );
  }
  const excludedBlobs: ExcludedBlobs = {
    excludedBlobBytes: [...excluded.values()].reduce(
      (sum, reference) => sum + (reference.sizeBytes ?? 0),
      0,
    ),
    excludedBlobCount: excluded.size,
  };
  return { excludedBlobs, references: sorted };
}

async function writeAppTables(
  context: GovernanceServiceContext,
  operationId: string,
  records: readonly TenantRecord[],
) {
  const apps = records.flatMap((item) => (item.record.itemType === "app" ? [item.record] : []));
  if (apps.length === 0) return [];
  const { exportAppTables } = context.options;
  if (!exportAppTables) {
    throw new GovernanceError(
      "tenant_app_export_unavailable",
      "Tenant export found agent-built apps but cannot export their tables.",
    );
  }
  const tables: AppTableObject[] = [];
  for (const app of apps) tables.push(...(await exportAppTables({ app, operationId })));
  return tables;
}

async function inventoryBlobs(
  context: GovernanceServiceContext,
  values: readonly { readonly optional: boolean; readonly reference: BlobReference }[],
) {
  const inventory: ExportBlob[] = [];
  let totalBytes = 0;
  for (let offset = 0; offset < values.length; offset += TENANT_EXPORT_BLOB_READ_CONCURRENCY) {
    const batch = values.slice(offset, offset + TENANT_EXPORT_BLOB_READ_CONCURRENCY);
    const sized = await Promise.all(
      batch.map(async ({ optional, reference }) => {
        try {
          const sizeBytes =
            reference.sizeBytes === undefined
              ? await context.options.objectStore.size(reference)
              : reference.sizeBytes;
          return { optional, reference, sizeBytes };
        } catch (cause) {
          if (optional && cause instanceof GovernanceObjectNotFoundError) return undefined;
          throw cause;
        }
      }),
    );
    for (const value of sized) {
      if (!value) continue;
      totalBytes += value.sizeBytes;
      if (totalBytes > MAX_TENANT_EXPORT_TOTAL_BYTES) {
        throw new GovernanceError(
          "tenant_export_too_large",
          `Tenant exports cannot exceed ${MAX_TENANT_EXPORT_TOTAL_BYTES} referenced bytes.`,
        );
      }
      inventory.push(value);
    }
  }
  return { inventory, totalBytes };
}

async function readBlob(context: GovernanceServiceContext, value: ExportBlob) {
  let contents: Uint8Array;
  try {
    contents = await context.options.objectStore.read(value.reference);
  } catch (cause) {
    if (value.optional && cause instanceof GovernanceObjectNotFoundError) return undefined;
    throw cause;
  }
  if (contents.byteLength !== value.sizeBytes) {
    throw new GovernanceError(
      "tenant_export_blob_mismatch",
      `Blob ${value.reference.bucket}/${value.reference.key} changed size during export.`,
    );
  }
  const digest = sha256(contents);
  if (
    value.reference.sha256 &&
    value.reference.sha256 !== digest &&
    value.reference.sha256 !== `sha256:${digest}`
  ) {
    throw new GovernanceError(
      "tenant_export_blob_mismatch",
      `Blob ${value.reference.bucket}/${value.reference.key} failed checksum verification.`,
    );
  }
  return { contents, digest, reference: value.reference };
}

async function writeLegacyExport(
  context: GovernanceServiceContext,
  current: GovernanceOperation,
  records: readonly TenantRecord[],
  blobs: readonly ExportBlob[],
  snapshotCaptured: () => Promise<void>,
  singleObjectByteLimit: number,
) {
  const lines = sortTenantRecords(records).map((item) =>
    canonicalJson({ record: item.record, table: item.table }),
  );
  let bodyBytes = lines.reduce((sum, line) => sum + encoder.encode(line).byteLength + 1, 0);
  for (let offset = 0; offset < blobs.length; offset += TENANT_EXPORT_BLOB_READ_CONCURRENCY) {
    const captured = await Promise.all(
      blobs
        .slice(offset, offset + TENANT_EXPORT_BLOB_READ_CONCURRENCY)
        .map((value) => readBlob(context, value)),
    );
    for (const value of captured) {
      if (!value) continue;
      const line = canonicalJson({
        blob: value.reference,
        bodyBase64: Buffer.from(value.contents).toString("base64"),
        sha256: value.digest,
      });
      bodyBytes += encoder.encode(line).byteLength + 1;
      if (bodyBytes > singleObjectByteLimit) {
        throw new GovernanceError(
          "tenant_export_retry_as_multipart",
          "Tenant export crossed the single-object limit and must use multipart output.",
        );
      }
      lines.push(line);
    }
  }
  await snapshotCaptured();
  const body = encoder.encode(`${lines.join("\n")}\n`);
  return context.writeObject(
    current.organizationId,
    current.id,
    "tenant.jsonl",
    body,
    "application/x-ndjson",
    false,
  );
}

async function writeMultipartExport(
  context: GovernanceServiceContext,
  current: GovernanceOperation,
  records: readonly TenantRecord[],
  blobs: readonly ExportBlob[],
  totalBlobBytes: number,
  excludedBlobs: ExcludedBlobs,
  snapshotCaptured: () => Promise<void>,
  partByteLimit: number,
) {
  const parts: GovernanceObjectReference[] = [];
  const inventory: Readonly<Record<string, unknown>>[] = [];
  let lines: string[] = [];
  let partBytes = 0;

  const flush = async () => {
    if (lines.length === 0) return;
    const body = encoder.encode(`${lines.join("\n")}\n`);
    const name = `tenant-parts/${String(parts.length).padStart(6, "0")}.ndjson`;
    const key = `governance/${current.organizationId}/${current.id}/${name}`;
    const digest = sha256(body);
    const existing = await context.options.objectStore.find(key);
    let part: GovernanceObjectReference;
    if (existing) {
      if (existing.sha256 !== digest || existing.sizeBytes !== body.byteLength) {
        throw new GovernanceError(
          "tenant_export_part_mismatch",
          `Checkpointed tenant export part ${name} does not match its deterministic content.`,
        );
      }
      part = existing;
    } else {
      part = await context.writeObject(
        current.organizationId,
        current.id,
        name,
        body,
        "application/x-ndjson",
        true,
      );
    }
    parts.push(part);
    lines = [];
    partBytes = 0;
  };

  const append = async (line: string) => {
    const bytes = encoder.encode(line).byteLength + 1;
    if (bytes > partByteLimit) {
      throw new GovernanceError(
        "tenant_export_record_too_large",
        "One tenant export record exceeds the bounded part size.",
      );
    }
    if (partBytes + bytes > partByteLimit) await flush();
    lines.push(line);
    partBytes += bytes;
  };

  for (const item of sortTenantRecords(records)) {
    const line = canonicalJson({ record: item.record, table: item.table });
    await append(line);
    inventory.push({ kind: "record", sha256: sha256(line), table: item.table });
  }

  const metadataAllowance = Math.min(16_384, Math.floor(partByteLimit / 4));
  const rawChunkBytes = Math.max(1, Math.floor((partByteLimit - metadataAllowance) * 0.7));
  for (const blob of blobs) {
    const captured = await readBlob(context, blob);
    if (!captured) continue;
    const chunkCount = Math.max(1, Math.ceil(captured.contents.byteLength / rawChunkBytes));
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const start = chunkIndex * rawChunkBytes;
      const end = Math.min(captured.contents.byteLength, start + rawChunkBytes);
      const chunk = captured.contents.subarray(start, end);
      await append(
        canonicalJson({
          blobChunk: {
            chunkCount,
            chunkIndex,
            end,
            reference: captured.reference,
            sha256: captured.digest,
            start,
          },
          bodyBase64: Buffer.from(chunk).toString("base64"),
          chunkSha256: sha256(chunk),
        }),
      );
    }
    inventory.push({
      kind: "blob",
      reference: captured.reference,
      sha256: captured.digest,
      sizeBytes: captured.contents.byteLength,
    });
  }
  await flush();
  await snapshotCaptured();

  const manifestBody = encoder.encode(
    canonicalJson({
      blobCount: inventory.filter((item) => item.kind === "blob").length,
      createdAt: context.now().toISOString(),
      ...excludedBlobs,
      format: "deployments-ai-tenant-export/v2",
      inventorySha256: sha256(canonicalJson(inventory)),
      organizationId: current.organizationId,
      parts,
      recordCount: records.length,
      totalBlobBytes,
    }),
  );
  return {
    manifest: await context.writeObject(
      current.organizationId,
      current.id,
      "tenant-manifest.json",
      manifestBody,
      "application/json",
      true,
    ),
    parts,
  };
}

export function tenantExportFormat(
  recordBytes: number,
  blobs: readonly Pick<ExportBlob, "sizeBytes">[],
  singleObjectByteLimit = MAX_EXPORT_BYTES,
) {
  const projectedSingleBytes =
    recordBytes + blobs.reduce((sum, blob) => sum + Math.ceil(blob.sizeBytes / 3) * 4 + 1_024, 0);
  return projectedSingleBytes <= singleObjectByteLimit
    ? ("deployments-ai-tenant-export/v1" as const)
    : ("deployments-ai-tenant-export/v2" as const);
}

export function makeGovernanceTenantExport(
  context: GovernanceServiceContext,
  tuning: {
    readonly partByteLimit?: number;
    readonly singleObjectByteLimit?: number;
  } = {},
) {
  const singleObjectByteLimit = tuning.singleObjectByteLimit ?? MAX_EXPORT_BYTES;
  const partByteLimit = tuning.partByteLimit ?? TENANT_EXPORT_PART_BYTES;
  if (!Number.isSafeInteger(singleObjectByteLimit) || singleObjectByteLimit < 1) {
    throw new TypeError("Tenant export single-object byte limit must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(partByteLimit) || partByteLimit < 1) {
    throw new TypeError("Tenant export part byte limit must be a positive safe integer.");
  }
  return async (
    initial: GovernanceOperation,
    records: readonly TenantRecord[],
    operationUpdated: (operation: GovernanceOperation) => void,
    snapshotCaptured: () => Promise<void>,
  ) => {
    let current = initial;
    if (current.output) {
      await snapshotCaptured();
      return {
        object: current.output,
        summary: (current.summary as Record<string, unknown> | undefined) ?? { recovered: true },
      };
    }
    const base = `governance/${current.organizationId}/${current.id}`;
    const recovered =
      (await context.options.objectStore.find(`${base}/tenant-manifest.json`)) ??
      (await context.options.objectStore.find(`${base}/tenant.jsonl`));
    if (recovered) {
      await snapshotCaptured();
      const summary = { recovered: true };
      current = await checkpoint(context, current, recovered, summary);
      operationUpdated(current);
      return { object: recovered, summary };
    }

    const { excludedBlobs, references } = collectReferences(
      context,
      current.organizationId,
      records,
      await writeAppTables(context, current.id, records),
    );
    const { inventory: blobs, totalBytes } = await inventoryBlobs(context, references);
    const recordBytes = sortTenantRecords(records).reduce(
      (sum, item) =>
        sum +
        encoder.encode(canonicalJson({ record: item.record, table: item.table })).byteLength +
        1,
      0,
    );
    const format = tenantExportFormat(recordBytes, blobs, singleObjectByteLimit);
    let object: GovernanceObjectReference;
    let summary: Readonly<Record<string, unknown>>;
    if (format === "deployments-ai-tenant-export/v1") {
      object = await writeLegacyExport(
        context,
        current,
        records,
        blobs,
        snapshotCaptured,
        singleObjectByteLimit,
      );
      summary = {
        blobCount: blobs.length,
        ...excludedBlobs,
        format: "deployments-ai-tenant-export/v1",
        recordCount: records.length,
        totalBlobBytes: totalBytes,
      };
    } else {
      const multipart = await writeMultipartExport(
        context,
        current,
        records,
        blobs,
        totalBytes,
        excludedBlobs,
        snapshotCaptured,
        partByteLimit,
      );
      object = multipart.manifest;
      summary = {
        blobCount: blobs.length,
        ...excludedBlobs,
        format: "deployments-ai-tenant-export/v2",
        partCount: multipart.parts.length,
        recordCount: records.length,
        totalBlobBytes: totalBytes,
      };
    }
    current = await checkpoint(context, current, object, summary);
    operationUpdated(current);
    return { object, summary };
  };
}
