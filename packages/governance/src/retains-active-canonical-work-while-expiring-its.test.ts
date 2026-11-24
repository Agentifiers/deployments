import type { PlatformRecord, TableName } from "@deployments-ai/db";
import { fakeTenantErasure } from "./tenant-erasure-test-support.ts";
import { describe, expect, test } from "bun:test";
import { sha256 } from "./canonical.ts";
import { createGovernanceService } from "./service.ts";
import type {
  ErasureFence,
  ErasureReceipt,
  GovernanceOperation,
  GovernanceStore,
  ImmutableAuditExportManifest,
  StoredRetentionPolicy,
  TenantRecord,
} from "./types.ts";
import { stringId } from "./governance-service-test-harness.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const _OPERATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const _OTHER_ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FZZ";

function record(
  itemType: PlatformRecord["itemType"],
  data: Readonly<Record<string, unknown>>,
  table: TableName,
): TenantRecord {
  return {
    record: {
      data: { organizationId: ORGANIZATION_ID, ...data },
      itemType,
      pk: `${table}#${stringId(data.id, "record")}`,
      sk: `${itemType}#${stringId(data.id, "record")}`,
    } as unknown as PlatformRecord,
    table,
  };
}

function harness(
  seed: readonly TenantRecord[] = [],
  legacyLeaseSeed: readonly TenantRecord[] = [],
  snapshotByteLimit?: number,
) {
  const records = [...seed];
  const legacyRuntimeLeases = [...legacyLeaseSeed];
  const operations = new Map<string, GovernanceOperation>();
  const policies = new Map<string, StoredRetentionPolicy>();
  const manifests: ImmutableAuditExportManifest[] = [];
  const receipts: ErasureReceipt[] = [];
  const deleted: TenantRecord[] = [];
  const deletedAllVersions: string[] = [];
  const deletedVersions: string[] = [];
  const objects = new Map<string, Uint8Array>();
  const puts: {
    contentType: string;
    immutable: boolean;
    key: string;
    retainUntil?: string;
    sha256: string;
  }[] = [];
  let idCursor = 0;
  let currentTime = new Date("2026-07-25T00:00:00.000Z");
  let failNextBlobDelete = false;
  let failNextAuditRecord = false;
  let failNextErasureFinalize = false;
  let failNextManifestWrite = false;
  let failTenantDeleteAfter: number | undefined;
  let erasureFenceOperationId: string | undefined;
  let rejectNextPolicyWrite = false;
  let signatureCount = 0;
  let signerKeyId = "kms-signing-key";
  let signerPublicKey = "base64-der-public-key";
  const staleRetentionIds = new Set<string>();
  const begunFences: ErasureFence[] = [];
  const tenantListFenceOwners: Array<string | undefined> = [];
  const objectReadFenceOwners: Array<string | undefined> = [];
  const objectPutFenceOwners: Array<string | undefined> = [];

  const store: GovernanceStore = {
    appendImmutableAuditExport: async (manifest) => {
      if (failNextAuditRecord) {
        failNextAuditRecord = false;
        throw new Error("temporary audit record failure");
      }
      manifests.push(manifest);
    },
    beginErasure: async (fence) => {
      begunFences.push(fence);
      if (erasureFenceOperationId && erasureFenceOperationId !== fence.operationId) {
        throw new Error("another erasure is active");
      }
      if (erasureFenceOperationId) return;
      erasureFenceOperationId = fence.operationId;
      records.push(
        record(
          "erasure-fence",
          {
            createdAt: fence.createdAt,
            id: fence.organizationId,
            operationId: fence.operationId,
          },
          "control",
        ),
      );
    },
    cancelOperationForErasure: async (operation, _previousVersion, erasureOperationId) => {
      if (erasureFenceOperationId !== erasureOperationId) {
        throw new Error("tenant erasure does not own the fence");
      }
      operations.set(operation.id, operation);
      return operation;
    },
    claimOperation: async (operation) => {
      if (erasureFenceOperationId && erasureFenceOperationId !== operation.id) {
        throw new Error("tenant governance is fenced");
      }
      if (operation.kind !== "tenant-erasure" && !erasureFenceOperationId) {
        erasureFenceOperationId = operation.id;
        records.push(
          record(
            "erasure-fence",
            {
              createdAt: operation.createdAt,
              id: operation.organizationId,
              operationId: operation.id,
            },
            "control",
          ),
        );
      }
      operations.set(operation.id, operation);
      return operation;
    },
    createOperation: async (operation) => {
      if (erasureFenceOperationId) throw new Error("tenant governance is fenced");
      const existing = operations.get(operation.id);
      if (existing) return existing;
      operations.set(operation.id, operation);
      return operation;
    },
    completeRetentionCleanup: async (cleanup) => {
      const index = records.findIndex(
        (item) =>
          item.record.itemType === "retention-cleanup" && item.record.data.id === cleanup.id,
      );
      if (index >= 0) records.splice(index, 1);
    },
    deleteTenantRecords: async (items) => {
      let deletedThisCall = 0;
      for (const item of items) {
        if (failTenantDeleteAfter !== undefined && deletedThisCall >= failTenantDeleteAfter) {
          failTenantDeleteAfter = undefined;
          throw new Error("temporary tenant record deletion failure");
        }
        deleted.push(item);
        const index = records.indexOf(item);
        if (index >= 0) records.splice(index, 1);
        deletedThisCall += 1;
      }
    },
    finalizeErasure: async (operation, receipt) => {
      if (failNextErasureFinalize) {
        failNextErasureFinalize = false;
        throw new Error("temporary erasure finalization failure");
      }
      receipts.push(receipt);
      operations.delete(operation.id);
      erasureFenceOperationId = undefined;
      const organizationIndex = records.findIndex(
        (item) => item.record.itemType === "organization",
      );
      if (organizationIndex >= 0) records.splice(organizationIndex, 1);
      const fenceIndex = records.findIndex((item) => item.record.itemType === "erasure-fence");
      if (fenceIndex >= 0) records.splice(fenceIndex, 1);
    },
    getErasureReceipt: async (operationId) =>
      receipts.find((receipt) => receipt.id === operationId),
    getOperation: async (_organizationId, operationId) => operations.get(operationId),
    organizationExists: async (organizationId) =>
      records.some(
        (item) => item.record.itemType === "organization" && item.record.data.id === organizationId,
      ),
    getRetentionPolicy: async (organizationId) => policies.get(organizationId),
    listLegacyRuntimeLeases: async (resourceIds) => {
      const tenantResourceIds = new Set(resourceIds);
      return legacyRuntimeLeases.filter(
        (item) =>
          item.record.itemType === "runtime-lease" &&
          (tenantResourceIds.has(item.record.data.id) ||
            (item.record.data.runId !== undefined &&
              tenantResourceIds.has(item.record.data.runId))),
      );
    },
    listLegacyPrincipalIdempotency: async () => [],
    ...fakeTenantErasure(records, legacyRuntimeLeases, (items, deadline) =>
      store.deleteTenantRecords(items, deadline),
    ),
    listOperations: async () => ({ items: [] }),
    listTenantRecords: async () => {
      tenantListFenceOwners.push(erasureFenceOperationId);
      return { items: records };
    },
    putRetentionPolicy: async (policy) => {
      if (rejectNextPolicyWrite) {
        rejectNextPolicyWrite = false;
        throw Object.assign(new Error("conflict"), {
          name: "ConditionalCheckFailedException",
        });
      }
      policies.set(policy.organizationId, policy);
    },
    releaseErasureFence: async (fence) => {
      if (erasureFenceOperationId && erasureFenceOperationId !== fence.operationId) {
        throw new Error("another erasure owns the fence");
      }
      erasureFenceOperationId = undefined;
      const fenceIndex = records.findIndex(
        (item) =>
          item.record.itemType === "erasure-fence" &&
          item.record.data.operationId === fence.operationId,
      );
      if (fenceIndex >= 0) records.splice(fenceIndex, 1);
    },
    scopeLegacyRuntimeLeases: async (organizationId, leases, fenceOperationId) => {
      if (erasureFenceOperationId !== fenceOperationId) {
        throw new Error("tenant erasure does not own the fence");
      }
      for (const item of leases) {
        if (item.record.itemType !== "runtime-lease") continue;
        (item.record.data as { organizationId?: string }).organizationId = organizationId;
        const legacyIndex = legacyRuntimeLeases.indexOf(item);
        if (legacyIndex >= 0) legacyRuntimeLeases.splice(legacyIndex, 1);
        if (!records.includes(item)) records.push(item);
      }
    },
    stageRetentionCleanup: async (item, cleanup, fenceOperationId) => {
      if (
        erasureFenceOperationId &&
        (!fenceOperationId || erasureFenceOperationId !== fenceOperationId)
      ) {
        return false;
      }
      if (
        staleRetentionIds.has(
          stringId((item.record.data as Readonly<Record<string, unknown>>).id, ""),
        )
      ) {
        return false;
      }
      const index = records.indexOf(item);
      if (index < 0) return false;
      records.splice(index, 1);
      records.push(
        record(
          "retention-cleanup",
          cleanup as unknown as Readonly<Record<string, unknown>>,
          "control",
        ),
      );
      deleted.push(item);
      return true;
    },
    stageErasureRetentionCleanup: async (item, cleanup, erasureOperationId) => {
      if (erasureFenceOperationId !== erasureOperationId) {
        throw new Error("tenant erasure does not own the fence");
      }
      const index = records.indexOf(item);
      if (index < 0) throw new Error("partial audit export changed concurrently");
      records.splice(index, 1);
      records.push(
        record(
          "retention-cleanup",
          cleanup as unknown as Readonly<Record<string, unknown>>,
          "control",
        ),
      );
      deleted.push(item);
    },
    updateOperation: async (operation) => {
      operations.set(operation.id, operation);
      return operation;
    },
  };
  const service = createGovernanceService({
    allowedObjectBuckets: ["artifacts", "governance"],
    generateId: async () => {
      idCursor += 1;
      return `01ARZ3NDEKTSV4RRFFQ69G${String(500 + idCursor).padStart(3, "0")}`;
    },
    now: () => currentTime,
    objectStore: {
      blockWrites: async (reference) => {
        objects.set(`${reference.bucket}/${reference.key}`, new Uint8Array());
      },
      delete: async (reference) => {
        if (failNextBlobDelete) {
          failNextBlobDelete = false;
          throw new Error("temporary blob deletion failure");
        }
        deletedVersions.push(
          `${reference.bucket}/${reference.key}/${reference.versionId ?? "current"}`,
        );
        objects.delete(`${reference.bucket}/${reference.key}`);
      },
      deleteAllVersions: async (reference) => {
        if (failNextBlobDelete) {
          failNextBlobDelete = false;
          throw new Error("temporary blob deletion failure");
        }
        deletedAllVersions.push(`${reference.bucket}/${reference.key}`);
        objects.delete(`${reference.bucket}/${reference.key}`);
      },
      find: async (key) => {
        const body = objects.get(`governance/${key}`);
        if (!body) return undefined;
        return {
          bucket: "governance",
          key,
          sha256: sha256(body),
          sizeBytes: body.byteLength,
          versionId: "recovered-version",
        };
      },
      put: async (input) => {
        objectPutFenceOwners.push(erasureFenceOperationId);
        if (failNextManifestWrite && input.key.endsWith("/audit-manifest.json")) {
          failNextManifestWrite = false;
          throw new Error("temporary manifest write failure");
        }
        puts.push({
          contentType: input.contentType,
          immutable: input.immutable,
          key: input.key,
          ...(input.retainUntil ? { retainUntil: input.retainUntil } : {}),
          sha256: input.sha256,
        });
        objects.set(`governance/${input.key}`, input.body);
        return {
          bucket: "governance",
          key: input.key,
          sha256: input.sha256,
          sizeBytes: input.body.byteLength,
          versionId: `version-${puts.length}`,
        };
      },
      read: async (reference) => {
        objectReadFenceOwners.push(erasureFenceOperationId);
        const body = objects.get(`${reference.bucket}/${reference.key}`);
        if (!body) throw new Error("missing fixture object");
        return body;
      },
      size: async (reference) => {
        const body = objects.get(`${reference.bucket}/${reference.key}`);
        if (!body) throw new Error("missing fixture object");
        return body.byteLength;
      },
    },
    signer: {
      get keyId() {
        return signerKeyId;
      },
      publicKey: async () => signerPublicKey,
      sign: async (digest) => {
        signatureCount += 1;
        return Buffer.from(digest).toString("base64");
      },
    },
    ...(snapshotByteLimit ? { snapshotByteLimit } : {}),
    store,
  });

  return {
    begunFences,
    deleted,
    deletedAllVersions,
    deletedVersions,
    failNextAuditRecord() {
      failNextAuditRecord = true;
    },
    failNextBlobDelete() {
      failNextBlobDelete = true;
    },
    failNextErasureFinalize() {
      failNextErasureFinalize = true;
    },
    failNextManifestWrite() {
      failNextManifestWrite = true;
    },
    failTenantDeleteAfter(count: number) {
      failTenantDeleteAfter = count;
    },
    manifests,
    markRetentionCandidateStale(id: string) {
      staleRetentionIds.add(id);
    },
    objects,
    objectReadFenceOwners,
    objectPutFenceOwners,
    operations,
    policies,
    puts,
    receipts,
    records,
    rejectNextPolicyWrite() {
      rejectNextPolicyWrite = true;
    },
    setSigner(keyId: string, publicKey: string) {
      signerKeyId = keyId;
      signerPublicKey = publicKey;
    },
    service,
    signatureCount: () => signatureCount,
    tenantListFenceOwners,
    setNow(value: string) {
      currentTime = new Date(value);
    },
  };
}

describe("governance service", () => {
  test("retains active canonical work while expiring its completed operational records", async () => {
    const old = "2025-01-01T00:00:00.000Z";
    const fixture = harness([
      record(
        "command",
        { id: "completed-command", status: "completed", updatedAt: old, version: 1 },
        "events",
      ),
      record(
        "command",
        { id: "running-command", status: "running", updatedAt: old, version: 1 },
        "events",
      ),
      record(
        "webhook-delivery",
        { id: "delivered-webhook", status: "delivered", updatedAt: old, version: 1 },
        "events",
      ),
      record(
        "webhook-delivery",
        { id: "retrying-webhook", status: "retrying", updatedAt: old, version: 1 },
        "events",
      ),
      record(
        "memory-index-job",
        { id: "completed-memory-index", status: "succeeded", updatedAt: old, version: 1 },
        "execution",
      ),
      record(
        "memory-index-job",
        { id: "queued-memory-index", status: "queued", updatedAt: old, version: 1 },
        "execution",
      ),
      record(
        "inbound-thread-route",
        { createdAt: old, id: "inactive-route", threadId: "inactive-thread" },
        "execution",
      ),
      record(
        "inbound-thread-route",
        { createdAt: old, id: "active-route", threadId: "active-thread" },
        "execution",
      ),
      record(
        "run",
        {
          id: "active-run",
          status: "running",
          threadId: "active-thread",
          updatedAt: old,
          version: 1,
        },
        "execution",
      ),
    ]);

    const result = await fixture.service.runRetention(ORGANIZATION_ID);

    expect(result.deletedByClass).toMatchObject({ events: 2, runs: 1, threads: 1 });
    expect(
      fixture.records.map((item) => (item.record.data as { id?: string }).id).filter(Boolean),
    ).toEqual([
      "running-command",
      "retrying-webhook",
      "queued-memory-index",
      "active-route",
      "active-run",
    ]);
  });

  test("retains terminal ancestors and their invocations while a trace remains open", async () => {
    const old = "2025-01-01T00:00:00.000Z";
    const fixture = harness([
      record(
        "run",
        {
          completedAt: old,
          id: "terminal-parent",
          status: "completed",
          threadId: "trace-thread",
          updatedAt: old,
          version: 2,
        },
        "execution",
      ),
      record(
        "model-invocation",
        {
          completedAt: old,
          id: "parent-invocation",
          runId: "terminal-parent",
          status: "succeeded",
          updatedAt: old,
          version: 0,
        },
        "execution",
      ),
      record(
        "run",
        {
          id: "active-child",
          status: "running",
          threadId: "trace-thread",
          updatedAt: old,
          version: 1,
        },
        "execution",
      ),
      record(
        "trace",
        {
          id: "open-trace",
          rootRunId: "terminal-parent",
          runIds: ["terminal-parent", "active-child"],
          status: "open",
          traceId: "open-trace",
          updatedAt: old,
          version: 1,
        },
        "execution",
      ),
    ]);

    const result = await fixture.service.runRetention(ORGANIZATION_ID);

    expect(result.recordsDeleted).toBe(0);
    expect(
      fixture.records.map((item) => (item.record.data as { readonly id?: string }).id),
    ).toContain("parent-invocation");
  });

  test("retains a durable cleanup marker until blob deletion succeeds", async () => {
    const key = `organizations/${ORGANIZATION_ID}/retry.txt`;
    const fixture = harness([
      record(
        "artifact",
        {
          id: "retry-artifact",
          retentionExpiresAt: "2026-07-24T23:59:59.999Z",
          status: "available",
          storage: {
            bucket: "artifacts",
            key,
            sha256: sha256("retry"),
          },
          updatedAt: "2026-07-24T00:00:00.000Z",
          version: 1,
        },
        "execution",
      ),
    ]);
    fixture.objects.set(`artifacts/${key}`, new TextEncoder().encode("retry"));
    fixture.failNextBlobDelete();

    expect(fixture.service.runRetention(ORGANIZATION_ID)).rejects.toThrow(
      "temporary blob deletion failure",
    );
    expect(fixture.records.map((item) => item.record.itemType)).toContain("retention-cleanup");
    expect(fixture.objects.has(`artifacts/${key}`)).toBe(true);

    expect(fixture.service.runRetention(ORGANIZATION_ID)).resolves.toMatchObject({
      recordsDeleted: 0,
    });
    expect(fixture.records.map((item) => item.record.itemType)).not.toContain("retention-cleanup");
    expect(fixture.objects.has(`artifacts/${key}`)).toBe(false);
  });

  test("does not delete a cleanup key reused by a recreated source record", async () => {
    const exportId = "recreated-export";
    const exportKey = `governance/${ORGANIZATION_ID}/${exportId}/tenant.jsonl`;
    const recreated = record(
      "governance-operation",
      {
        createdAt: "2026-07-25T00:00:00.000Z",
        dispatchReadyAt: "2026-07-25T00:00:00.500Z",
        id: exportId,
        idempotencyKey: "recreated-export",
        kind: "tenant-export",
        organizationId: ORGANIZATION_ID,
        output: {
          bucket: "governance",
          key: exportKey,
          sha256: sha256("new export"),
          sizeBytes: 10,
          versionId: "new-version",
        },
        requestedByPrincipalId: PRINCIPAL_ID,
        status: "pending",
        updatedAt: "2026-07-25T00:00:00.500Z",
        version: 1,
      },
      "control",
    );
    const fixture = harness([
      record(
        "organization",
        {
          createdAt: "2025-01-01T00:00:00.000Z",
          id: ORGANIZATION_ID,
          name: "Retention tenant",
          updatedAt: "2025-01-01T00:00:00.000Z",
          version: 1,
        },
        "control",
      ),
      record(
        "retention-cleanup",
        {
          createdAt: "2026-07-24T00:00:00.000Z",
          id: "stale-export-cleanup",
          references: [
            {
              bucket: "governance",
              deleteAllVersions: true,
              key: exportKey,
            },
          ],
          sourceItemType: "governance-operation",
          sourcePk: recreated.record.pk,
          sourceSk: recreated.record.sk,
          sourceTable: recreated.table,
        },
        "control",
      ),
      recreated,
    ]);
    fixture.objects.set(`governance/${exportKey}`, new TextEncoder().encode("new export"));

    await fixture.service.runRetention(ORGANIZATION_ID);

    expect(fixture.objects.has(`governance/${exportKey}`)).toBe(true);
    expect(fixture.deletedAllVersions).not.toContain(`governance/${exportKey}`);
    expect(fixture.records).toContain(recreated);
    expect(fixture.records.some((item) => item.record.itemType === "retention-cleanup")).toBe(
      false,
    );
  });

  test("does not delete a blob shared with another live record", async () => {
    const key = `organizations/${ORGANIZATION_ID}/shared.txt`;
    const storage = {
      bucket: "artifacts",
      key,
      sha256: sha256("shared"),
      versionId: "shared-version",
    };
    const fixture = harness([
      record(
        "artifact",
        {
          id: "expired-artifact",
          retentionExpiresAt: "2026-07-24T23:59:59.999Z",
          status: "available",
          storage,
          updatedAt: "2026-07-24T00:00:00.000Z",
          version: 1,
        },
        "execution",
      ),
      record(
        "artifact",
        {
          id: "live-artifact",
          retentionExpiresAt: "2026-07-26T00:00:00.000Z",
          status: "available",
          storage,
          updatedAt: "2026-07-25T00:00:00.000Z",
          version: 1,
        },
        "execution",
      ),
    ]);
    fixture.objects.set(`artifacts/${key}`, new TextEncoder().encode("shared"));

    await fixture.service.runRetention(ORGANIZATION_ID);

    expect(fixture.objects.has(`artifacts/${key}`)).toBe(true);
    expect(fixture.deletedAllVersions).not.toContain(`artifacts/${key}`);
    expect(
      fixture.records.some(
        (item) => item.record.itemType === "artifact" && item.record.data.id === "live-artifact",
      ),
    ).toBe(true);
  });
});
