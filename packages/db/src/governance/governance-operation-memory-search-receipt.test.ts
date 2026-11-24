import { describe, expect, it } from "bun:test";
import {
  erasureReceiptFromRecord,
  erasureReceiptRecord,
  operationFromRecord,
  operationRecord,
} from "./dynamo-store.ts";

describe("Dynamo governance operation conversion", () => {
  it("round-trips the durable search and observability erasure checkpoints", () => {
    const operation = {
      createdAt: "2026-07-29T12:00:00.000Z",
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      idempotencyKey: "erase-tenant",
      kind: "tenant-erasure" as const,
      brainSearchErasureReceipt: {
        operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        targets: [{ providerId: "aws-native", targetDigest: "brain-digest" }],
      },
      canonicalDeletedAt: "2026-07-29T12:00:30.000Z",
      memorySearchErasureReceipt: {
        operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        targets: [{ providerId: "aws-native", targetDigest: "digest" }],
      },
      observabilityErasureProgress: { clickhouseRowsDeleted: 4, phase: "iceberg" },
      observabilityErasureReceipt: {
        clickhouse: { absenceVerifiedAt: "2026-07-29T12:11:00.000Z", rowsDeleted: 4 },
        operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
      organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      requestedByPrincipalId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      status: "running" as const,
      updatedAt: "2026-07-29T12:01:00.000Z",
      version: 2,
    };

    expect(operationFromRecord(operationRecord(operation))).toEqual(operation);
  });

  it("round-trips erasure receipts with and without the memory search backup expiry", () => {
    const receipt = {
      auditRootHash: "a".repeat(64),
      completedAt: "2026-07-29T12:20:00.000Z",
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      organizationHash: "organization-hash",
      recordsDeleted: 4,
      requestedByPrincipalHash: "principal-hash",
    };
    const withMemorySearch = {
      ...receipt,
      memorySearch: { backupsExpireBy: "2026-08-12T13:05:00.000Z" },
    };

    expect(erasureReceiptFromRecord(erasureReceiptRecord(withMemorySearch))).toEqual(
      withMemorySearch,
    );
    expect(erasureReceiptFromRecord(erasureReceiptRecord(receipt))).toEqual(receipt);
    expect(() =>
      erasureReceiptRecord({ ...receipt, memorySearch: { backupsExpireBy: "next month" } }),
    ).toThrow();
  });
});
