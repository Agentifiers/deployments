import { describe, expect, test } from "bun:test";
import {
  governanceLegacyDirectoryRecord,
  governanceTenantDirectoryRecord,
} from "../governance-tenant-directory.ts";
import { key } from "../keys.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RESOURCE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";

describe("governance access keys", () => {
  test("derives authoritative directory records for ordinary and special ownership records", () => {
    const organization = withCanonicalRecordKeys({
      data: { id: ORGANIZATION_ID },
      itemType: "organization" as const,
    });
    const uniqueClaim = withCanonicalRecordKeys({
      data: {
        namespace: "organization-slug",
        ownerPk: key("ORG", ORGANIZATION_ID),
        value: "example",
      },
      itemType: "unique-claim" as const,
    });
    const rateLimit = withCanonicalRecordKeys({
      data: {
        id: RESOURCE_ID,
        limitKey: "brain-upload",
        organizationId: ORGANIZATION_ID,
        scopeId: ORGANIZATION_ID,
        window: "2026-08-21",
      },
      itemType: "rate-limit-counter" as const,
    });

    for (const record of [organization, uniqueClaim, rateLimit]) {
      const directory = governanceTenantDirectoryRecord(record as unknown as PlatformRecord);
      expect(directory?.pk).toMatch(
        new RegExp(`^ORG#${ORGANIZATION_ID}#GOVERNANCE-INVENTORY#SHARD#(0\\d|1[0-5])$`, "u"),
      );
      expect(directory?.sk).toMatch(/^RECORD#[0-9a-f]{64}$/u);
      expect(String(directory?.data.organizationId)).toBe(ORGANIZATION_ID);
      expect(directory?.data.recordPk).toBe(record.pk);
      expect(directory?.data.recordSk).toBe(record.sk);
    }
  });

  test("projects dispatchable operations into status-sharded due queues", () => {
    const pending = withCanonicalRecordKeys({
      data: {
        dispatchReadyAt: "2026-08-21T12:00:00.000Z",
        id: RESOURCE_ID,
        kind: "tenant-export",
        organizationId: ORGANIZATION_ID,
        status: "pending",
        updatedAt: "2026-08-21T12:00:00.000Z",
      },
      itemType: "governance-operation" as const,
    });
    const completed = withCanonicalRecordKeys({
      data: {
        id: PRINCIPAL_ID,
        kind: "tenant-export",
        organizationId: ORGANIZATION_ID,
        status: "completed",
        updatedAt: "2026-08-21T12:00:00.000Z",
      },
      itemType: "governance-operation" as const,
    });

    expect(pending.gsi2pk).toMatch(/^GOVERNANCE-DISPATCH#pending#(?:0[0-9]|1[0-5])$/u);
    expect(pending.gsi2sk).toBe(`2026-08-21T12%3A00%3A00.000Z#${RESOURCE_ID}`);
    expect(completed.gsi2pk).toBeUndefined();
  });

  test("keeps legacy correlation addressable without a table scan", () => {
    const idempotency = withCanonicalRecordKeys({
      data: {
        idempotencyKey: "legacy-request",
        principalId: PRINCIPAL_ID,
      },
      itemType: "idempotency" as const,
    });
    const lease = withCanonicalRecordKeys({
      data: { id: RESOURCE_ID, leaseKey: `agent-run-thread/${RESOURCE_ID}`, runId: PRINCIPAL_ID },
      itemType: "runtime-lease" as const,
    });

    const directory = governanceLegacyDirectoryRecord(idempotency as unknown as PlatformRecord);
    expect(directory?.pk).toBe(key("GLOBAL", "GOVERNANCE-LEGACY", "principal-idempotency"));
    expect(directory?.sk).toMatch(/^RECORD#[0-9a-f]{64}$/u);
    expect(directory?.data.recordPk).toBe(idempotency.pk);
    expect(directory?.data.recordSk).toBe(idempotency.sk);
    expect(lease.pk).toBe(key("RUNTIME-LEASE", RESOURCE_ID));
    expect(lease.sk).toBe(key("RUNTIME-LEASE", `agent-run-thread/${RESOURCE_ID}`));
  });
});
