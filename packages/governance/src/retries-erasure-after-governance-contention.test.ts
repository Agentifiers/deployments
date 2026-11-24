import { describe, expect, test } from "bun:test";
import {
  ORGANIZATION_ID,
  OPERATION_ID,
  PRINCIPAL_ID,
  harness,
} from "./governance-service-test-harness.ts";
import { GovernanceError } from "./types.ts";

async function requestedErasure() {
  const fixture = harness();
  await fixture.service.requestOperation({
    idempotencyKey: "erase-tenant",
    kind: "tenant-erasure",
    operationId: OPERATION_ID,
    organizationId: ORGANIZATION_ID,
    principalId: PRINCIPAL_ID,
  });
  return fixture;
}

describe("tenant erasure contention", () => {
  test("a lost gate-lane race leaves the erasure pending and the next dispatch completes it", async () => {
    const fixture = await requestedErasure();
    fixture.refuseNextBeginErasure(
      new GovernanceError(
        "tenant_governance_busy",
        "Tenant governance is fenced by another operation.",
      ),
    );

    expect(await fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID)).toMatchObject({
      error: {
        code: "tenant_governance_busy",
        message: "Tenant governance is fenced by another operation.",
      },
      status: "pending",
    });
    expect(fixture.operations.get(OPERATION_ID)?.status).toBe("pending");
    expect(fixture.records.some((item) => item.record.itemType === "erasure-fence")).toBe(false);

    fixture.setNow("2026-07-25T00:05:00.000Z");
    expect(await fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID)).toMatchObject({
      completedAt: "2026-07-25T00:05:00.000Z",
      status: "completed",
    });
    expect(fixture.begunFences.map((fence) => fence.createdAt)).toEqual([
      "2026-07-25T00:00:00.000Z",
      "2026-07-25T00:05:00.000Z",
    ]);
    expect(fixture.receipts.map((receipt) => receipt.id)).toEqual([OPERATION_ID]);
  });

  test("a store failure while taking the erasure fence still fails the erasure", async () => {
    const fixture = await requestedErasure();
    fixture.refuseNextBeginErasure(new Error("control table unavailable"));

    expect(fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID)).rejects.toThrow(
      "control table unavailable",
    );
    expect(fixture.operations.get(OPERATION_ID)).toMatchObject({
      error: {
        code: "governance_operation_failed",
        message: "control table unavailable",
      },
      status: "failed",
    });
  });
});
