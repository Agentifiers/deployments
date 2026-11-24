import { describe, expect, test } from "bun:test";
import { sha256 } from "./canonical.ts";
import {
  ORGANIZATION_ID,
  PRINCIPAL_ID,
  OPERATION_ID,
  record,
  harness,
} from "./governance-service-test-harness.ts";

describe("governance service", () => {
  test("fences new governance work while erasure waits for an active export", async () => {
    const exportId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
    const fixture = harness([
      record(
        "governance-operation",
        {
          createdAt: "2026-07-24T23:00:00.000Z",
          id: exportId,
          idempotencyKey: "active-export",
          kind: "tenant-export",
          leaseExpiresAt: "2026-07-25T00:10:00.000Z",
          requestedByPrincipalId: PRINCIPAL_ID,
          startedAt: "2026-07-24T23:59:00.000Z",
          status: "running",
          updatedAt: "2026-07-24T23:59:00.000Z",
          version: 2,
        },
        "control",
      ),
    ]);
    await fixture.service.requestOperation({
      idempotencyKey: "erase-after-export",
      kind: "tenant-erasure",
      operationId: OPERATION_ID,
      organizationId: ORGANIZATION_ID,
      principalId: PRINCIPAL_ID,
    });

    expect(await fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID)).toMatchObject({
      error: { code: "tenant_governance_busy" },
      status: "pending",
    });
    expect(fixture.records.some((item) => item.record.itemType === "erasure-fence")).toBe(true);
    expect(
      fixture.service.requestOperation({
        idempotencyKey: "blocked-export",
        kind: "tenant-export",
        operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        organizationId: ORGANIZATION_ID,
        principalId: PRINCIPAL_ID,
      }),
    ).rejects.toThrow("tenant governance is fenced");

    const activeIndex = fixture.records.findIndex(
      (item) => item.record.itemType === "governance-operation" && item.record.data.id === exportId,
    );
    fixture.records[activeIndex] = record(
      "governance-operation",
      {
        completedAt: "2026-07-25T00:01:00.000Z",
        createdAt: "2026-07-24T23:00:00.000Z",
        id: exportId,
        idempotencyKey: "active-export",
        kind: "tenant-export",
        requestedByPrincipalId: PRINCIPAL_ID,
        startedAt: "2026-07-24T23:59:00.000Z",
        status: "completed",
        updatedAt: "2026-07-25T00:01:00.000Z",
        version: 3,
      },
      "control",
    );

    expect(fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID)).resolves.toMatchObject({
      status: "completed",
    });
    expect(fixture.records.some((item) => item.record.itemType === "erasure-fence")).toBe(false);
  });

  test("preserves erasure evidence when finalization is retried after deletion", async () => {
    const fixture = harness([
      record(
        "organization",
        {
          createdAt: "2026-07-01T00:00:00.000Z",
          id: ORGANIZATION_ID,
          name: "Erased organization",
          updatedAt: "2026-07-01T00:00:00.000Z",
          version: 1,
        },
        "control",
      ),
      record(
        "audit-event",
        {
          action: "tenant.erase",
          actor: { type: "worker" },
          eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
          occurredAt: "2026-07-24T00:00:00.000Z",
        },
        "events",
      ),
      record(
        "thread",
        {
          createdAt: "2026-07-24T00:00:00.000Z",
          id: "erased-thread",
          updatedAt: "2026-07-24T00:00:00.000Z",
          version: 1,
        },
        "execution",
      ),
    ]);
    await fixture.service.requestOperation({
      idempotencyKey: "erasure-evidence",
      kind: "tenant-erasure",
      operationId: OPERATION_ID,
      organizationId: ORGANIZATION_ID,
      principalId: PRINCIPAL_ID,
    });
    fixture.failNextErasureFinalize();

    expect(fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID)).rejects.toThrow(
      "temporary erasure finalization failure",
    );
    const checkpoint = fixture.operations.get(OPERATION_ID);
    expect(checkpoint).toMatchObject({
      erasureProgress: { phase: "final", recordsDeleted: 2 },
      status: "failed",
    });
    expect(checkpoint?.erasureAuditRootHash).not.toBe("0".repeat(64));
    expect(fixture.records.map((item) => item.record.itemType)).toEqual([
      "organization",
      "erasure-fence",
    ]);

    await fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID);

    expect(fixture.receipts[0]).toMatchObject({
      auditRootHash: checkpoint?.erasureAuditRootHash,
      recordsDeleted: 3,
    });
    expect(fixture.records.some((item) => item.record.itemType === "organization")).toBe(false);
  });

  test("blocks erasure while a run is active and records only pseudonymous receipt data", async () => {
    const fixture = harness([
      record(
        "run",
        {
          id: "active-run",
          status: "waiting-for-tool",
          updatedAt: "2026-07-24T00:00:00.000Z",
        },
        "execution",
      ),
    ]);
    await fixture.service.requestOperation({
      idempotencyKey: "erase-1",
      kind: "tenant-erasure",
      operationId: OPERATION_ID,
      organizationId: ORGANIZATION_ID,
      principalId: PRINCIPAL_ID,
    });
    expect(
      await fixture.service
        .runOperation(ORGANIZATION_ID, OPERATION_ID)
        .catch((cause: unknown) => cause),
    ).toMatchObject({ code: "tenant_has_active_runs" });
    expect(fixture.operations.get(OPERATION_ID)).toMatchObject({
      error: { code: "tenant_has_active_runs" },
      status: "failed",
    });
    expect(fixture.deleted).toHaveLength(0);
    expect(fixture.records.some((item) => item.record.itemType === "erasure-fence")).toBe(false);

    const run = fixture.records[0]!.record as unknown as {
      data: Record<string, unknown>;
    };
    run.data.status = "completed";
    const completed = await fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID);
    expect(completed.status).toBe("completed");
    expect(fixture.receipts[0]).toMatchObject({
      auditRootHash: "0".repeat(64),
      organizationHash: sha256(ORGANIZATION_ID),
      requestedByPrincipalHash: sha256(PRINCIPAL_ID),
    });
    expect(JSON.stringify(fixture.receipts[0])).not.toContain(ORGANIZATION_ID);
    expect(JSON.stringify(fixture.receipts[0])).not.toContain(PRINCIPAL_ID);
    expect(fixture.operations.has(OPERATION_ID)).toBe(false);
    expect(fixture.service.getOperation(ORGANIZATION_ID, OPERATION_ID)).resolves.toMatchObject({
      id: OPERATION_ID,
      kind: "tenant-erasure",
      status: "completed",
    });
  });

  test("purges every version of referenced tenant objects during erasure", async () => {
    const cleanupKey = `organizations/${ORGANIZATION_ID}/superseded-message.txt`;
    const fixture = harness([
      record(
        "artifact",
        {
          id: "artifact",
          status: "available",
          storage: {
            bucket: "artifacts",
            key: `organizations/${ORGANIZATION_ID}/tenant.txt`,
            sha256: sha256("tenant"),
            versionId: "current-version",
          },
          updatedAt: "2026-07-24T00:00:00.000Z",
        },
        "execution",
      ),
      record(
        "inbox-content-cleanup",
        {
          createdAt: "2026-07-24T00:00:00.000Z",
          id: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
          references: [
            {
              bucket: "artifacts",
              key: cleanupKey,
              sha256: sha256("superseded"),
              versionId: "superseded-version",
            },
          ],
          resourceId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
          resourceType: "message",
          status: "pending",
          updatedAt: "2026-07-24T00:00:00.000Z",
          version: 0,
        },
        "execution",
      ),
    ]);
    await fixture.service.requestOperation({
      idempotencyKey: "erase-versions",
      kind: "tenant-erasure",
      operationId: OPERATION_ID,
      organizationId: ORGANIZATION_ID,
      principalId: PRINCIPAL_ID,
    });

    await fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID);

    expect(fixture.deletedAllVersions.toSorted()).toEqual([
      `artifacts/${cleanupKey}`,
      `artifacts/organizations/${ORGANIZATION_ID}/tenant.txt`,
    ]);
    expect(fixture.deletedVersions).toEqual([]);
  });
});
