import { describe, expect, test } from "bun:test";
import {
  MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import {
  blobReferences,
  deleteRecordsAndBlobs,
  tenantExportExcludedBlobReferences,
} from "./governance-service-support.ts";
import { retentionClass } from "./governance-record-classification.ts";
import type { GovernanceServiceOptions } from "./types.ts";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const threadId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const executionTargetId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const leaseId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const timestamp = "2026-09-29T12:00:00.000Z";
const snapshotKey = `organizations/${organizationId}/sandbox-workspaces/threads/${threadId}/execution-targets/agent-deployment/${executionTargetId}/snapshot.tar.gz`;
const options = { allowedObjectBuckets: ["artifacts"] } as unknown as GovernanceServiceOptions;

function workspace(snapshot?: Record<string, unknown>) {
  return withCanonicalRecordKeys({
    data: {
      createdAt: timestamp,
      environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      executionTargetId,
      executionTargetKind: "agent-deployment",
      id: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      organizationId,
      projectId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
      threadId,
      updatedAt: timestamp,
      version: 2,
      ...(snapshot ? { snapshot } : {}),
    },
    itemType: "sandbox-workspace" as const,
  }) as PlatformRecord;
}

describe("sandbox workspace governance", () => {
  const snapshot = {
    bucket: "artifacts",
    byteSize: MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES,
    capturedAt: timestamp,
    key: snapshotKey,
    leaseId,
    sha256: "c".repeat(64),
    versionId: "s3-version-7",
  };
  const reference = {
    bucket: "artifacts",
    key: snapshotKey,
    sha256: "c".repeat(64),
    sizeBytes: MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES,
    versionId: "s3-version-7",
  };

  test("retains workspaces with their thread and deletes the pinned snapshot version", () => {
    const record = workspace(snapshot);

    expect(retentionClass(record)).toBe("threads");
    expect(blobReferences(options, organizationId, record)).toEqual([reference]);
    expect(blobReferences(options, organizationId, record, true, true)).toEqual([reference]);
    expect(blobReferences(options, organizationId, workspace())).toEqual([]);
  });

  test("excludes snapshots from tenant export while retention and erasure delete them", async () => {
    const record = workspace(snapshot);
    expect(tenantExportExcludedBlobReferences(options, organizationId, record)).toEqual([
      reference,
    ]);
    expect(tenantExportExcludedBlobReferences(options, organizationId, workspace())).toEqual([]);

    const deleted: unknown[] = [];
    const deletingOptions = {
      ...options,
      objectStore: {
        delete: async () => {
          throw new Error("snapshots must be deleted with all versions");
        },
        deleteAllVersions: async (value: unknown) => {
          deleted.push(value);
        },
      },
      store: { deleteTenantRecords: async () => {} },
    } as unknown as GovernanceServiceOptions;
    await deleteRecordsAndBlobs(
      deletingOptions,
      organizationId,
      [{ record, table: "control" }],
      timestamp,
    );
    expect(deleted).toEqual([reference]);
  });
});
