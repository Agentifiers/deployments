import { describe, expect, spyOn, test } from "bun:test";
import {
  OPERATION_ID,
  ORGANIZATION_ID,
  PRINCIPAL_ID,
  harness,
} from "./governance-service-test-harness.ts";

const GRANT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAG";

describe("governance service under operator access", () => {
  test("hands the store the grant that audits a policy change and an erasure request", async () => {
    const fixture = harness();
    const policyWrites = spyOn(fixture.store, "putRetentionPolicy");
    const creates = spyOn(fixture.store, "createOperation");

    await fixture.service.updateRetentionPolicy({
      operatorAccessGrantId: GRANT_ID,
      organizationId: ORGANIZATION_ID,
      patch: { messages: 30 },
      principalId: PRINCIPAL_ID,
    });
    await fixture.service.requestOperation({
      idempotencyKey: "erase",
      kind: "tenant-erasure",
      operationId: OPERATION_ID,
      operatorAccessGrantId: GRANT_ID,
      organizationId: ORGANIZATION_ID,
      principalId: PRINCIPAL_ID,
    });

    expect(policyWrites.mock.calls[0]?.[3]).toBe(GRANT_ID);
    expect(creates.mock.calls[0]?.[1]).toBe(GRANT_ID);
  });
});
