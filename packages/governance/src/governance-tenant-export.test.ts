import { describe, expect, test } from "bun:test";
import { MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES, withCanonicalRecordKeys } from "@deployments-ai/db";
import type { PlatformRecord } from "@deployments-ai/db";
import { canonicalJson, sha256 } from "./canonical.ts";
import { MAX_TENANT_EXPORT_TOTAL_BYTES } from "./governance-service-support.ts";
import { makeGovernanceTenantExport, tenantExportFormat } from "./governance-tenant-export.ts";
import type { GovernanceServiceContext } from "./service.ts";
import type { GovernanceObjectReference, GovernanceOperation, TenantRecord } from "./types.ts";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const operationId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const principalId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const now = "2026-07-31T12:00:00.000Z";

function operation(): GovernanceOperation {
  return {
    createdAt: now,
    id: operationId,
    idempotencyKey: "export",
    kind: "tenant-export",
    organizationId,
    requestedByPrincipalId: principalId,
    status: "running",
    updatedAt: now,
    version: 1,
  };
}

function sourceRecord(body: Uint8Array): TenantRecord {
  const digest = sha256(body);
  return {
    record: {
      data: {
        bodyRef: {
          bucket: "content",
          byteSize: body.byteLength,
          contentType: "text/plain",
          key: `organizations/${organizationId}/brains/brain/document.txt`,
          sha256: `sha256:${digest}`,
          versionId: "source-v1",
        },
        brainId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        contentHash: `sha256:${digest}`,
        createdAt: now,
        documentId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        envelopeHash: `sha256:${digest}`,
        id: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
        kind: "content",
        organizationId,
        sourceId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
        sourceOrder: 1,
      },
      itemType: "brain-document-version",
      pk: `ORG#${organizationId}#DOCUMENT#01ARZ3NDEKTSV4RRFFQ69G5FAZ`,
      sk: "BRAIN-DOCUMENT-VERSION#01ARZ3NDEKTSV4RRFFQ69G5FB0",
    } as PlatformRecord,
    table: "control",
  };
}

const threadId = "01ARZ3NDEKTSV4RRFFQ69G5FB2";

function snapshotKey(executionTargetId: string) {
  return `organizations/${organizationId}/sandbox-workspaces/threads/${threadId}/execution-targets/agent-deployment/${executionTargetId}/snapshot.tar.gz`;
}

function workspaceRecord(
  executionTargetId = "01ARZ3NDEKTSV4RRFFQ69G5FB3",
  byteSize = MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES,
): TenantRecord {
  return {
    record: withCanonicalRecordKeys({
      data: {
        createdAt: now,
        environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FB4",
        executionTargetId,
        executionTargetKind: "agent-deployment",
        id: "01ARZ3NDEKTSV4RRFFQ69G5FB5",
        organizationId,
        projectId: "01ARZ3NDEKTSV4RRFFQ69G5FB6",
        snapshot: {
          bucket: "content",
          byteSize,
          capturedAt: now,
          key: snapshotKey(executionTargetId),
          leaseId: "01ARZ3NDEKTSV4RRFFQ69G5FB7",
          sha256: "c".repeat(64),
          versionId: "snapshot-v1",
        },
        threadId,
        updatedAt: now,
        version: 2,
      },
      itemType: "sandbox-workspace" as const,
    }) as PlatformRecord,
    table: "control",
  };
}

function fixture(body: Uint8Array) {
  const sourceKey = `organizations/${organizationId}/brains/brain/document.txt`;
  const written = new Map<string, { body: Uint8Array; reference: GovernanceObjectReference }>();
  const immutableWrites: string[] = [];
  const touched: string[] = [];
  let failManifest = true;
  let updated: GovernanceOperation | undefined;
  const objectStore = {
    blockWrites: async () => {},
    delete: async () => {},
    deleteAllVersions: async () => {},
    find: async (key: string) => written.get(key)?.reference,
    put: async (input: {
      body: Uint8Array;
      contentType: string;
      immutable: boolean;
      key: string;
      sha256: string;
    }) => {
      if (input.key.endsWith("tenant-manifest.json") && failManifest) {
        failManifest = false;
        throw new Error("simulated manifest checkpoint failure");
      }
      if (input.immutable) immutableWrites.push(input.key);
      const reference: GovernanceObjectReference = {
        bucket: "governance",
        key: input.key,
        sha256: input.sha256,
        sizeBytes: input.body.byteLength,
        versionId: `version-${written.size + 1}`,
      };
      written.set(input.key, { body: input.body, reference });
      return reference;
    },
    read: async (reference: { key: string }) => {
      touched.push(reference.key);
      if (reference.key === sourceKey) return body;
      const value = written.get(reference.key);
      if (!value) throw new Error("missing object");
      return value.body;
    },
    size: async (reference: { key: string }) => {
      touched.push(reference.key);
      if (reference.key === sourceKey) return body.byteLength;
      return written.get(reference.key)?.body.byteLength ?? 0;
    },
  };
  const context = {
    getOperation: async () => operation(),
    getRetentionPolicy: async () => ({}) as never,
    now: () => new Date(now),
    options: {
      allowedObjectBuckets: ["content", "governance"],
      generateId: async () => operationId,
      objectStore,
      signer: {} as never,
      store: {
        updateOperation: async (next: GovernanceOperation) => {
          updated = next;
          return next;
        },
      } as never,
    },
    writeObject: async (
      _organizationId: string,
      _operationId: string,
      name: string,
      contents: Uint8Array,
      contentType: "application/json" | "application/x-ndjson",
      immutable: boolean,
    ) =>
      objectStore.put({
        body: contents,
        contentType,
        immutable,
        key: `governance/${organizationId}/${operationId}/${name}`,
        sha256: sha256(contents),
      }),
  } as GovernanceServiceContext;
  return {
    context,
    get updated() {
      return updated;
    },
    immutableWrites,
    touched,
    written,
  };
}

describe("multipart tenant governance export", () => {
  test("selects multipart for more than 128 MiB and supports more than 1,000 blobs", () => {
    expect(tenantExportFormat(1, [{ sizeBytes: 129 * 1_024 * 1_024 }])).toBe(
      "deployments-ai-tenant-export/v2",
    );
    expect(
      tenantExportFormat(
        1,
        Array.from({ length: 1_001 }, () => ({ sizeBytes: 1 })),
      ),
    ).toBe("deployments-ai-tenant-export/v1");
  });

  test("reuses immutable deterministic parts after a manifest checkpoint failure", async () => {
    const body = new TextEncoder().encode("evidence ".repeat(8_000));
    const state = fixture(body);
    const exporter = makeGovernanceTenantExport(state.context, {
      partByteLimit: 16 * 1_024,
      singleObjectByteLimit: 1_024,
    });
    let released = 0;
    expect(
      exporter(
        operation(),
        [sourceRecord(body)],
        () => {},
        async () => {
          released += 1;
        },
      ),
    ).rejects.toThrow("manifest checkpoint failure");
    const firstPartWrites = state.immutableWrites.filter((key) => key.includes("tenant-parts/"));
    expect(firstPartWrites.length).toBeGreaterThan(1);

    const result = await exporter(
      operation(),
      [sourceRecord(body)],
      () => {},
      async () => {
        released += 1;
      },
    );
    const secondPartWrites = state.immutableWrites.filter((key) => key.includes("tenant-parts/"));
    expect(secondPartWrites).toEqual(firstPartWrites);
    expect(result.object.key).toEndWith("tenant-manifest.json");
    expect(state.updated?.summary).toMatchObject({
      format: "deployments-ai-tenant-export/v2",
      partCount: firstPartWrites.length,
    });
    expect(released).toBe(2);
  });

  test("records sandbox workspace snapshots without copying or counting their bytes", async () => {
    expect(MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES).toBeGreaterThan(MAX_TENANT_EXPORT_TOTAL_BYTES);
    const body = new TextEncoder().encode("evidence");
    const secondDeploymentId = "01ARZ3NDEKTSV4RRFFQ69G5FB8";
    const workspaces = [workspaceRecord(), workspaceRecord(secondDeploymentId, 3 * 1_024 ** 3)];
    const state = fixture(body);
    const exporter = makeGovernanceTenantExport(state.context);
    const result = await exporter(
      operation(),
      [sourceRecord(body), ...workspaces],
      () => {},
      async () => {},
    );

    expect(state.touched.filter((key) => key.includes("/sandbox-workspaces/"))).toEqual([]);
    expect(result.summary).toEqual({
      blobCount: 1,
      excludedBlobBytes: MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES + 3 * 1_024 ** 3,
      excludedBlobCount: 2,
      format: "deployments-ai-tenant-export/v1",
      recordCount: 3,
      totalBlobBytes: body.byteLength,
    });
    const exported = new TextDecoder()
      .decode(state.written.get(result.object.key)?.body)
      .trimEnd()
      .split("\n");
    for (const workspace of workspaces) {
      expect(exported).toContain(
        canonicalJson({ record: workspace.record, table: workspace.table }),
      );
    }
    expect(exported.filter((line) => line.includes('"bodyBase64"'))).toHaveLength(1);
    expect(exported.filter((line) => line.includes(snapshotKey(secondDeploymentId)))).toHaveLength(
      1,
    );
  });

  test("reports excluded snapshots in the multipart manifest", async () => {
    const body = new TextEncoder().encode("evidence ".repeat(8_000));
    const state = fixture(body);
    const exporter = makeGovernanceTenantExport(state.context, {
      partByteLimit: 16 * 1_024,
      singleObjectByteLimit: 1_024,
    });
    const records = [sourceRecord(body), workspaceRecord()];
    expect(
      exporter(
        operation(),
        records,
        () => {},
        async () => {},
      ),
    ).rejects.toThrow("manifest checkpoint failure");
    const result = await exporter(
      operation(),
      records,
      () => {},
      async () => {},
    );

    expect(state.touched.filter((key) => key.includes("/sandbox-workspaces/"))).toEqual([]);
    expect(result.summary).toMatchObject({
      blobCount: 1,
      excludedBlobBytes: MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES,
      excludedBlobCount: 1,
      format: "deployments-ai-tenant-export/v2",
      totalBlobBytes: body.byteLength,
    });
    const manifest: unknown = JSON.parse(
      new TextDecoder().decode(state.written.get(result.object.key)?.body),
    );
    expect(manifest).toMatchObject({
      blobCount: 1,
      excludedBlobBytes: MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES,
      excludedBlobCount: 1,
      recordCount: 2,
      totalBlobBytes: body.byteLength,
    });
  });
});
