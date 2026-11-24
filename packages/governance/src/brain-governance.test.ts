import { describe, expect, test } from "bun:test";
import { withCanonicalRecordKeys, type PlatformRecord } from "@deployments-ai/db";
import { blobReferences } from "./governance-service-support.ts";
import { isActiveBrainUploadLease } from "./governance-operation-runner.ts";
import type { GovernanceServiceOptions } from "./types.ts";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const brainId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const sourceId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const documentId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const versionId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const ticketId = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const timestamp = "2026-07-30T12:00:00.000Z";

describe("Brain governance integration", () => {
  test("includes immutable Brain bodies in export, retention, and erasure inventories", () => {
    const record = withCanonicalRecordKeys({
      data: {
        bodyRef: {
          bucket: "artifacts",
          byteSize: 3,
          contentType: "text/plain",
          key: `organizations/${organizationId}/brains/${brainId}/documents/${documentId}`,
          sha256: "sha256:content",
          versionId: "s3-version-1",
        },
        brainId,
        byteSize: 3,
        contentHash: "sha256:content",
        createdAt: timestamp,
        documentId,
        envelopeHash: "sha256:envelope",
        id: versionId,
        kind: "content" as const,
        mediaType: "text/plain",
        organizationId,
        sourceId,
        sourceOrder: 1,
      },
      itemType: "brain-document-version" as const,
    }) as PlatformRecord;

    expect(
      blobReferences(
        {
          allowedObjectBuckets: ["artifacts"],
        } as unknown as GovernanceServiceOptions,
        organizationId,
        record,
      ),
    ).toEqual([
      {
        bucket: "artifacts",
        contentType: "text/plain",
        key: `organizations/${organizationId}/brains/${brainId}/documents/${documentId}`,
        sha256: "sha256:content",
        sizeBytes: 3,
        versionId: "s3-version-1",
      },
    ]);
  });

  test("keeps erasure fenced while a canonical Brain upload lease can still write", () => {
    const lease = withCanonicalRecordKeys({
      data: {
        brainId,
        createdAt: timestamp,
        expiresAt: "2026-07-30T12:05:00.000Z",
        id: versionId,
        organizationId,
        owner: "upload-worker",
        status: "active" as const,
        ticketId,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "brain-upload-lease" as const,
      ttl: Date.parse("2026-07-30T12:05:00.000Z") / 1_000,
    }) as PlatformRecord;

    expect(isActiveBrainUploadLease(lease, new Date("2026-07-30T12:01:00.000Z"))).toBe(true);
    expect(isActiveBrainUploadLease(lease, new Date("2026-07-30T12:06:00.000Z"))).toBe(false);
  });
});
