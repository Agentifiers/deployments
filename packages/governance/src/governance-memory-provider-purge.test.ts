import { describe, expect, test } from "bun:test";
import { decodeMemorySearchErasureReceipt } from "./governance-memory-search-erasure.ts";
import { GovernanceError } from "./types.ts";
import {
  ORGANIZATION_ID,
  PRINCIPAL_ID,
  OPERATION_ID,
  harness,
} from "./governance-service-test-harness.ts";

const LATEST_EXPIRY = "2026-08-08T01:10:00.000Z";

function memorySearchReceipt(boundaries: readonly (string | undefined)[]) {
  return decodeMemorySearchErasureReceipt(
    {
      operationId: OPERATION_ID,
      targets: boundaries.map((boundary, index) => ({
        ...(boundary ? { backupErasureEligibleAt: boundary } : {}),
        componentReceipts: [
          {
            componentId: `01ARZ3NDEKTSV4RRFFQ69G5FB${index}`,
            generationId: "01ARZ3NDEKTSV4RRFFQ69G5FC0",
            providerReceipt: { absenceVerified: true, receiptDigest: `proof-${index}` },
          },
        ],
        providerId: "aws-native",
        targetDigest: `target-${index}`,
      })),
    },
    OPERATION_ID,
  );
}

describe("governance service", () => {
  test("keeps expected memory-provider draining retryable", async () => {
    const fixture = harness([], [], undefined, async () => {
      throw new GovernanceError(
        "memory_search_drain_pending",
        "Memory provider mutations are draining.",
      );
    });
    await fixture.service.requestOperation({
      idempotencyKey: "erase-with-drain",
      kind: "tenant-erasure",
      operationId: OPERATION_ID,
      organizationId: ORGANIZATION_ID,
      principalId: PRINCIPAL_ID,
    });

    expect(fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID)).resolves.toMatchObject({
      error: { code: "memory_search_drain_pending" },
      status: "pending",
    });
    expect(fixture.operations.get(OPERATION_ID)?.status).toBe("pending");
  });

  test("keeps a running memory-provider live purge pending without failing the delivery", async () => {
    const fixture = harness([], [], undefined, async () => {
      throw new GovernanceError(
        "memory_search_purge_pending",
        "Memory provider live purge remains pending.",
      );
    });
    await fixture.service.requestOperation({
      idempotencyKey: "erase-during-live-purge",
      kind: "tenant-erasure",
      operationId: OPERATION_ID,
      organizationId: ORGANIZATION_ID,
      principalId: PRINCIPAL_ID,
    });

    expect(fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID)).resolves.toMatchObject({
      error: { code: "memory_search_purge_pending" },
      status: "pending",
    });
    expect(fixture.operations.get(OPERATION_ID)).toMatchObject({
      error: { code: "memory_search_purge_pending" },
      status: "pending",
    });
  });

  test("keeps transient memory-provider purge failures retryable", async () => {
    let attempts = 0;
    const fixture = harness([], [], undefined, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient OpenSearch failure");
      return memorySearchReceipt([]);
    });
    await fixture.service.requestOperation({
      idempotencyKey: "erase-with-transient-provider-failure",
      kind: "tenant-erasure",
      operationId: OPERATION_ID,
      organizationId: ORGANIZATION_ID,
      principalId: PRINCIPAL_ID,
    });

    expect(fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID)).rejects.toThrow(
      "transient OpenSearch failure",
    );
    expect(fixture.operations.get(OPERATION_ID)).toMatchObject({ status: "pending" });
    expect(fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID)).resolves.toMatchObject({
      status: "completed",
    });
    expect(attempts).toBe(2);
  });

  test("reports the latest memory search backup expiry when the erasure completes", async () => {
    const fixture = harness([], [], undefined, async () =>
      memorySearchReceipt([LATEST_EXPIRY, "2026-08-08T01:00:00.000Z", undefined]),
    );
    await fixture.service.requestOperation({
      idempotencyKey: "erase-after-verified-live-purge",
      kind: "tenant-erasure",
      operationId: OPERATION_ID,
      organizationId: ORGANIZATION_ID,
      principalId: PRINCIPAL_ID,
    });

    const completed = await fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID);

    expect(completed).toMatchObject({
      status: "completed",
      summary: { memorySearch: { backupsExpireBy: LATEST_EXPIRY } },
    });
    expect(fixture.receipts[0]?.memorySearch).toEqual({ backupsExpireBy: LATEST_EXPIRY });
    expect(fixture.service.getOperation(ORGANIZATION_ID, OPERATION_ID)).resolves.toMatchObject({
      status: "completed",
      summary: { memorySearch: { backupsExpireBy: LATEST_EXPIRY } },
    });
  });

  test("omits the memory search expiry when the stored receipt predates backup boundaries", async () => {
    let memoryPurges = 0;
    const fixture = harness([], [], undefined, async () => {
      memoryPurges += 1;
      return memorySearchReceipt([LATEST_EXPIRY]);
    });
    await fixture.service.requestOperation({
      idempotencyKey: "erase-with-legacy-memory-receipt",
      kind: "tenant-erasure",
      operationId: OPERATION_ID,
      organizationId: ORGANIZATION_ID,
      principalId: PRINCIPAL_ID,
    });
    const requested = fixture.operations.get(OPERATION_ID)!;
    fixture.operations.set(OPERATION_ID, {
      ...requested,
      memorySearchErasureReceipt: memorySearchReceipt([undefined]),
    });

    const completed = await fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID);

    expect(memoryPurges).toBe(0);
    expect(completed.summary).toEqual({ auditRootHash: "0".repeat(64), recordsDeleted: 1 });
    expect(fixture.receipts[0]).not.toHaveProperty("memorySearch");
  });
});
