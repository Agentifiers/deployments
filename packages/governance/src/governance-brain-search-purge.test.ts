import { describe, expect, test } from "bun:test";
import { GovernanceError } from "./types.ts";
import {
  ORGANIZATION_ID,
  PRINCIPAL_ID,
  OPERATION_ID,
  harness,
} from "./governance-service-test-harness.ts";

describe("governance service", () => {
  test("keeps a draining Brain provider pending without failing the delivery", async () => {
    let purges = 0;
    const fixture = harness([], [], undefined, undefined, async () => {
      purges += 1;
      if (purges === 1) {
        throw new GovernanceError(
          "brain_search_drain_pending",
          "Brain provider mutations are draining before erasure.",
        );
      }
      return { operationId: OPERATION_ID, targets: [] };
    });
    await fixture.service.requestOperation({
      idempotencyKey: "erase-during-brain-drain",
      kind: "tenant-erasure",
      operationId: OPERATION_ID,
      organizationId: ORGANIZATION_ID,
      principalId: PRINCIPAL_ID,
    });

    expect(fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID)).resolves.toMatchObject({
      error: { code: "brain_search_drain_pending" },
      status: "pending",
    });
    expect(fixture.operations.get(OPERATION_ID)).toMatchObject({
      error: { code: "brain_search_drain_pending" },
      status: "pending",
    });
    expect(fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID)).resolves.toMatchObject({
      status: "completed",
    });
    expect(purges).toBe(2);
  });
});
