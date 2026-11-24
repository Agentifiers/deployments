import { describe, expect, test } from "bun:test";
import { E2E_RETENTION_POLICY, e2eRetentionPolicyPlan } from "./bootstrap-e2e-retention-support.ts";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const principalId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const now = "2026-10-03T00:00:00.000Z";

describe("credentialed E2E retention bootstrap", () => {
  test("creates the bounded policy for an organization on the product default", () => {
    expect(
      e2eRetentionPolicyPlan({ current: undefined, now, organizationId, principalId }),
    ).toEqual({
      policy: {
        ...E2E_RETENTION_POLICY,
        createdAt: now,
        organizationId,
        updatedAt: now,
        updatedByPrincipalId: principalId,
        version: 1,
      },
    });
  });

  test("versions a changed policy and leaves a bounded one untouched", () => {
    const current = {
      ...E2E_RETENTION_POLICY,
      createdAt: "2026-01-01T00:00:00.000Z",
      organizationId,
      runs: 365,
      updatedAt: "2026-01-01T00:00:00.000Z",
      updatedByPrincipalId: principalId,
      version: 4,
    };

    expect(e2eRetentionPolicyPlan({ current, now, organizationId, principalId })).toMatchObject({
      policy: { createdAt: current.createdAt, runs: 7, updatedAt: now, version: 5 },
      previousVersion: 4,
    });
    expect(
      e2eRetentionPolicyPlan({
        current: { ...current, runs: E2E_RETENTION_POLICY.runs },
        now,
        organizationId,
        principalId,
      }),
    ).toBeUndefined();
  });
});
