import { describe, expect, test } from "bun:test";
import {
  makeDynamoGovernanceStore,
  withCanonicalRecordKeys,
  type GovernanceOperation,
  type PlatformRecord,
} from "../index.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";
import { operationRecord } from "./dynamo-store.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TABLE_NAMES = {
  control: "control",
  events: "events",
  execution: "execution",
  usage: "usage",
} as const;

function seededStore(operation: GovernanceOperation) {
  const fake = fakeDynamoDocumentClient();
  fake.put(
    "control",
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-10-17T00:00:00.000Z",
        id: ORGANIZATION_ID,
        name: "Deployments.ai",
        slug: "deployments-ai",
        status: "active" as const,
        updatedAt: "2026-10-17T00:00:00.000Z",
        version: 1,
      },
      itemType: "organization" as const,
    }) as unknown as PlatformRecord,
  );
  fake.put("control", operationRecord(operation));
  return makeDynamoGovernanceStore(fake.client, TABLE_NAMES);
}

function claimed(operation: GovernanceOperation, updatedAt: string): GovernanceOperation {
  return {
    ...operation,
    leaseExpiresAt: "2026-10-17T00:20:00.000Z",
    startedAt: updatedAt,
    status: "running",
    updatedAt,
    version: operation.version + 1,
  };
}

describe("governance operation claims", () => {
  test("reports a claim lost to a concurrent worker as an operation that is not runnable", async () => {
    const pending: GovernanceOperation = {
      createdAt: "2026-10-16T21:00:00.000Z",
      id: "78SWDKAVAKXJYKF2RM9CSM9WNX",
      idempotencyKey: "tenant-erasure",
      kind: "tenant-erasure",
      organizationId: ORGANIZATION_ID,
      requestedByPrincipalId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      status: "pending",
      updatedAt: "2026-10-17T00:00:08.000Z",
      version: 7,
    };
    const store = seededStore(pending);

    const winner = await store.claimOperation(
      claimed(pending, "2026-10-17T00:05:07.340Z"),
      pending.version,
    );
    const loser = await store
      .claimOperation(claimed(pending, "2026-10-17T00:05:07.375Z"), pending.version)
      .catch((cause: unknown) => cause);

    expect(loser).toMatchObject({
      code: "operation_not_runnable",
      message: "Governance operation changed while it was being claimed.",
    });
    expect(await store.getOperation(ORGANIZATION_ID, pending.id)).toEqual(winner);
  });

  test("still fails a claim whose stored version matches but whose dispatch is not ready", async () => {
    const pending: GovernanceOperation = {
      createdAt: "2026-10-17T00:00:00.000Z",
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      idempotencyKey: "tenant-export",
      kind: "tenant-export",
      organizationId: ORGANIZATION_ID,
      requestedByPrincipalId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      status: "pending",
      updatedAt: "2026-10-17T00:00:00.000Z",
      version: 1,
    };
    const store = seededStore(pending);

    const refused = await store
      .claimOperation(claimed(pending, "2026-10-17T00:00:01.000Z"), pending.version)
      .catch((cause: unknown) => cause);

    expect(refused).toMatchObject({ name: "TransactionCanceledException" });
    expect(await store.getOperation(ORGANIZATION_ID, pending.id)).toEqual(pending);
  });
});
