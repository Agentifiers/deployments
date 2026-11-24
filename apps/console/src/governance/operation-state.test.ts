import {
  GOVERNANCE_OPERATION_KINDS,
  GovernanceOperationResponse,
  ImmutableAuditExportResponse,
  TenantDataExportResponse,
} from "@deployments-ai/api-contract/governance";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  DOWNLOAD_LINKS,
  isExportKind,
  OPERATION_LABELS,
  operationView,
  presignedPart,
  retryPath,
} from "./operation-state.ts";

const ORG = "01ARZ3NDEKTSV4RRFFQ69G600C";
const OPERATION = "01M4D00000000000000000000A";
const SHA = "a".repeat(64);
const ARCHIVE_SHA = "b".repeat(64);
const URL = "https://bucket.s3.amazonaws.com/tenant-export?X-Amz-Signature=secret";
const ARCHIVE_URL = "https://bucket.s3.amazonaws.com/audit-archive?X-Amz-Signature=secret";
const EXPIRES = "2026-10-07T12:05:00.000Z";

const base = {
  createdAt: "2026-10-07T12:00:00.000Z",
  id: OPERATION,
  organizationId: ORG,
  updatedAt: "2026-10-07T12:01:00.000Z",
  version: 2,
};

const tenantOutput = {
  contentType: "application/x-ndjson",
  downloadUrl: URL,
  downloadUrlExpiresAt: EXPIRES,
  fileName: `tenant-export-${OPERATION}.jsonl`,
  sha256: SHA,
  sizeBytes: 2048,
};

const auditOutput = {
  archiveDownloadUrl: ARCHIVE_URL,
  archiveDownloadUrlExpiresAt: EXPIRES,
  archiveFileName: `audit-export-${OPERATION}-records.jsonl`,
  archiveSha256: ARCHIVE_SHA,
  archiveSizeBytes: 4096,
  contentType: "application/json",
  downloadUrl: URL,
  downloadUrlExpiresAt: EXPIRES,
  fileName: `audit-export-${OPERATION}-manifest.json`,
  immutable: true,
  sha256: SHA,
  sizeBytes: 900,
};

const operation = (fields: Readonly<Record<string, unknown>>) =>
  Schema.decodeUnknownSync(GovernanceOperationResponse)({ ...base, ...fields });

describe("operationView", () => {
  test("pending and running exports carry no artifact", () => {
    expect(operationView(operation({ kind: "tenant-export", status: "pending" }))).toEqual({
      createdAt: base.createdAt,
      id: OPERATION,
      kind: "tenant-export",
      phase: { status: "pending" },
    });
    expect(
      operationView(
        operation({
          kind: "audit-export",
          startedAt: "2026-10-07T12:00:30.000Z",
          status: "running",
        }),
      ).phase,
    ).toEqual({ startedAt: "2026-10-07T12:00:30.000Z", status: "running" });
  });

  test("a completed v1 tenant export is a single file with its record count", () => {
    const view = operationView(
      operation({
        completedAt: "2026-10-07T12:02:00.000Z",
        kind: "tenant-export",
        output: tenantOutput,
        status: "completed",
        summary: { format: "deployments-ai-tenant-export/v1", recordCount: 812 },
      }),
    );
    expect(view.phase).toEqual({ completedAt: "2026-10-07T12:02:00.000Z", status: "completed" });
    expect(view.artifact).toEqual({
      file: { fileName: `tenant-export-${OPERATION}.jsonl`, sha256: SHA, sizeBytes: 2048 },
      kind: "single_file",
      recordCount: 812,
    });
  });

  test("a v2 tenant export is a manifest of parts the API does not presign", () => {
    const view = operationView(
      operation({
        kind: "tenant-export",
        output: tenantOutput,
        status: "completed",
        summary: { format: "deployments-ai-tenant-export/v2", recordCount: 3 },
      }),
    );
    expect(view.artifact?.kind).toBe("multipart_manifest");
    expect(view.phase).toEqual({ completedAt: base.updatedAt, status: "completed" });
  });

  test("a completed audit export is a manifest and an archive with chain facts", () => {
    const view = operationView(
      operation({
        kind: "audit-export",
        output: auditOutput,
        status: "completed",
        summary: {
          archiveSha256: ARCHIVE_SHA,
          manifestSha256: SHA,
          recordCount: 41,
          retainedUntil: "2033-10-05T12:00:00.000Z",
          rootHash: "c".repeat(64),
        },
      }),
    );
    expect(view.artifact).toEqual({
      archive: {
        fileName: `audit-export-${OPERATION}-records.jsonl`,
        sha256: ARCHIVE_SHA,
        sizeBytes: 4096,
      },
      kind: "audit_bundle",
      manifest: {
        fileName: `audit-export-${OPERATION}-manifest.json`,
        sha256: SHA,
        sizeBytes: 900,
      },
      recordCount: 41,
      retainedUntil: "2033-10-05T12:00:00.000Z",
      rootHash: "c".repeat(64),
    });
  });

  test("no presigned URL survives into a view", () => {
    const serialized = JSON.stringify([
      operationView(
        operation({ kind: "tenant-export", output: tenantOutput, status: "completed" }),
      ),
      operationView(operation({ kind: "audit-export", output: auditOutput, status: "completed" })),
    ]);
    expect(serialized).not.toContain("X-Amz-Signature");
    expect(serialized).not.toContain("https://");
  });

  test("failures keep the recorded code and message, or say none was recorded", () => {
    expect(
      operationView(
        operation({
          error: { code: "tenant_has_active_runs", message: "Runs are active." },
          kind: "tenant-erasure",
          status: "failed",
        }),
      ).phase,
    ).toEqual({
      error: { code: "tenant_has_active_runs", message: "Runs are active." },
      status: "failed",
    });
    expect(
      operationView(operation({ error: {}, kind: "tenant-export", status: "failed" })).phase,
    ).toEqual({
      error: { code: "unknown", message: "The platform recorded no reason." },
      status: "failed",
    });
  });

  test("an export canceled by an erasure keeps its reason", () => {
    expect(
      operationView(
        operation({
          error: { code: "operation_canceled_by_erasure", message: "Canceled by erasure." },
          kind: "audit-export",
          status: "canceled",
        }),
      ).phase,
    ).toEqual({
      error: { code: "operation_canceled_by_erasure", message: "Canceled by erasure." },
      status: "canceled",
    });
    expect(operationView(operation({ kind: "audit-export", status: "canceled" })).phase).toEqual({
      status: "canceled",
    });
  });
});

describe("conversation erasures in the history", () => {
  const counts = {
    automationsArchived: 0,
    emailMessagesErased: 2,
    emailThreadsErased: 1,
    ingressRecordsDeleted: 0,
    memoriesErased: 0,
    objectsStaged: 3,
    recordsDeleted: 14,
    runsCanceled: 0,
    streamsDeleted: 1,
    threadsErased: 1,
    threadsPlanned: 1,
  };
  const erasure = (fields: Readonly<Record<string, unknown>>) =>
    operation({
      counts,
      environmentId: "01M4CGZA4N2G1B23FA73Y8FSZ4",
      phase: "finalizing",
      ...fields,
    });

  test("a completed thread erasure is a labeled row with its times and no files", () => {
    const view = operationView(
      erasure({
        completedAt: "2026-10-07T12:03:00.000Z",
        kind: "thread-erasure",
        status: "completed",
        threadId: "01M4D00000000000000000000T",
      }),
    );
    expect(view).toEqual({
      createdAt: base.createdAt,
      id: OPERATION,
      kind: "thread-erasure",
      phase: { completedAt: "2026-10-07T12:03:00.000Z", status: "completed" },
    });
    expect(OPERATION_LABELS[view.kind]).toBe("Thread erasure");
    expect(isExportKind(view.kind)).toBe(false);
  });

  test("a failed end-user erasure keeps its reason and offers no retry", () => {
    const view = operationView(
      erasure({
        error: { code: "erasure_failed", message: "The mail phase failed." },
        kind: "end-user-erasure",
        status: "failed",
      }),
    );
    expect(view.phase).toEqual({
      error: { code: "erasure_failed", message: "The mail phase failed." },
      status: "failed",
    });
    expect(OPERATION_LABELS[view.kind]).toBe("End-user erasure");
    expect(isExportKind(view.kind)).toBe(false);
    expect(retryPath(view)).toBe("none");
  });

  test("a running conversation erasure has no start time", () => {
    expect(
      operationView(erasure({ kind: "thread-erasure", status: "running", threadId: OPERATION }))
        .phase,
    ).toEqual({
      status: "running",
    });
  });

  test("only tenant and audit exports are export kinds", () => {
    expect(GOVERNANCE_OPERATION_KINDS.filter(isExportKind)).toEqual([
      "audit-export",
      "tenant-export",
    ]);
  });
});

describe("presignedPart", () => {
  test("picks the minted URL for each part", () => {
    const audit = Schema.decodeUnknownSync(ImmutableAuditExportResponse)({
      ...base,
      kind: "audit-export",
      output: auditOutput,
      status: "completed",
    });
    expect(presignedPart(audit, "output")).toEqual({ expiresAt: EXPIRES, url: URL });
    expect(presignedPart(audit, "archive")).toEqual({ expiresAt: EXPIRES, url: ARCHIVE_URL });
  });

  test("returns nothing when the platform minted no URL", () => {
    const { downloadUrl: _url, downloadUrlExpiresAt: _expires, ...unsigned } = tenantOutput;
    const tenant = Schema.decodeUnknownSync(TenantDataExportResponse)({
      ...base,
      kind: "tenant-export",
      output: unsigned,
      status: "completed",
    });
    expect(presignedPart(tenant, "output")).toBeUndefined();
    expect(presignedPart(tenant, "archive")).toBeUndefined();
    const pending = Schema.decodeUnknownSync(TenantDataExportResponse)({
      ...base,
      kind: "tenant-export",
      status: "pending",
    });
    expect(presignedPart(pending, "output")).toBeUndefined();
  });
});

describe("DOWNLOAD_LINKS", () => {
  const linksOf = (fields: Readonly<Record<string, unknown>>) => {
    const { artifact } = operationView(operation({ status: "completed", ...fields }));
    return artifact && DOWNLOAD_LINKS[artifact.kind];
  };
  const manifestOutput = {
    ...tenantOutput,
    downloadUrl: `https://bucket.s3.amazonaws.com/governance/${ORG}/${OPERATION}/tenant-manifest.json?X-Amz-Signature=secret`,
  };

  test("a data export file downloads in place", () => {
    expect(linksOf({ kind: "tenant-export", output: tenantOutput })).toEqual([
      { disposition: "download", label: "Download", part: "output" },
    ]);
  });

  test("a large data export's JSON manifest opens in a tab, even when recovered without a format", () => {
    const view = [{ disposition: "view", label: "View manifest", part: "output" }] as const;
    expect(
      linksOf({
        kind: "tenant-export",
        output: tenantOutput,
        summary: { format: "deployments-ai-tenant-export/v2" },
      }),
    ).toEqual(view);
    expect(
      linksOf({ kind: "tenant-export", output: manifestOutput, summary: { recovered: true } }),
    ).toEqual(view);
  });

  test("an audit export views its JSON manifest and downloads its records", () => {
    expect(linksOf({ kind: "audit-export", output: auditOutput })).toEqual([
      { disposition: "view", label: "View manifest", part: "output" },
      { disposition: "download", label: "Download records", part: "archive" },
    ]);
  });
});

describe("retryPath", () => {
  test("ended exports retry as a new request and an ended erasure resumes", () => {
    const failed = { error: { code: "x", message: "y" }, status: "failed" } as const;
    expect(retryPath({ kind: "tenant-export", phase: failed })).toBe("new_request");
    expect(retryPath({ kind: "audit-export", phase: { status: "canceled" } })).toBe("new_request");
    expect(retryPath({ kind: "tenant-erasure", phase: failed })).toBe("resume_same");
  });

  test("operations still running or done offer no retry", () => {
    expect(retryPath({ kind: "tenant-export", phase: { status: "running" } })).toBe("none");
    expect(retryPath({ kind: "tenant-erasure", phase: { status: "pending" } })).toBe("none");
    expect(
      retryPath({
        kind: "audit-export",
        phase: { completedAt: base.createdAt, status: "completed" },
      }),
    ).toBe("none");
  });
});
