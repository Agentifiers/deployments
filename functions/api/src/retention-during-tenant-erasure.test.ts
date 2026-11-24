import { describe, expect, spyOn, test } from "bun:test";
import {
  DEFAULT_TABLE_NAMES,
  ErasureFenceRecord,
  makeDynamoGovernanceStore,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import {
  createGovernanceService,
  type GovernanceObjectStore,
  type GovernanceService,
  type GovernanceSigner,
} from "@deployments-ai/governance";
import { standingInstallation } from "@deployments-ai/organization-admission/testing";
import { Schema } from "effect";
import { processGovernanceQueueRecords } from "./governance-worker-main.ts";

const noRestamp = async () => ({ outcome: "none" as const, restamped: 0 });

const ORGANIZATION_ID = "01M54ZKDV97D2WYEWHY4HWFKDR";
const FENCE_HOLDER_ID = "6MQSBWNNHM7R4FWDDZD86KW3Y6";
const RETENTION_FENCE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FD0";
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FD1";
const AT = "2026-10-17T13:40:00.000Z";

const unexpectedPort = new Proxy(
  {},
  {
    get: () => async () => {
      throw new Error("Retention of a fenced tenant must not reach this port.");
    },
  },
);

function tenantFencedBy(kind: "tenant-erasure" | "tenant-export") {
  const fake = fakeDynamoDocumentClient();
  const { control } = DEFAULT_TABLE_NAMES;
  fake.put(
    control,
    withCanonicalRecordKeys({
      data: {
        createdAt: AT,
        id: ORGANIZATION_ID,
        name: "Erasing tenant",
        slug: "erasing-tenant",
        status: "active" as const,
        updatedAt: AT,
        version: 1,
      },
      itemType: "organization" as const,
    }),
  );
  fake.put(
    control,
    withCanonicalRecordKeys({
      data: {
        createdAt: AT,
        ...(kind === "tenant-export" ? { dispatchReadyAt: AT } : {}),
        id: FENCE_HOLDER_ID,
        idempotencyKey: kind,
        kind,
        leaseExpiresAt: "2026-10-17T14:00:00.000Z",
        organizationId: ORGANIZATION_ID,
        requestedByPrincipalId: PRINCIPAL_ID,
        startedAt: AT,
        status: "running" as const,
        updatedAt: AT,
        version: 2,
      },
      itemType: "governance-operation" as const,
    }),
  );
  fake.put(
    control,
    Schema.decodeUnknownSync(ErasureFenceRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: AT,
          id: ORGANIZATION_ID,
          operationId: FENCE_HOLDER_ID,
          organizationId: ORGANIZATION_ID,
        },
        itemType: "erasure-fence" as const,
      }),
    ),
  );
  return createGovernanceService({
    allowedObjectBuckets: [],
    generateId: async () => RETENTION_FENCE_ID,
    now: () => new Date("2026-10-17T13:45:28.000Z"),
    objectStore: unexpectedPort as GovernanceObjectStore,
    signer: unexpectedPort as GovernanceSigner,
    store: makeDynamoGovernanceStore(fake.client, DEFAULT_TABLE_NAMES),
  });
}

async function deliverRetention(service: GovernanceService) {
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const result = await processGovernanceQueueRecords(
      service,
      [
        {
          body: JSON.stringify({ kind: "retention", organizationId: ORGANIZATION_ID }),
          messageId: "retention-1",
        },
      ],
      standingInstallation().repository,
      noRestamp,
    );
    return { failureLogs: consoleError.mock.calls, result };
  } finally {
    consoleError.mockRestore();
    stderr.mockRestore();
  }
}

describe("daily retention of a fenced tenant", () => {
  test("acknowledges retention for a tenant whose erasure holds the fence", async () => {
    expect(await deliverRetention(tenantFencedBy("tenant-erasure"))).toEqual({
      failureLogs: [],
      result: { batchItemFailures: [] },
    });
  });

  test("retries retention for a tenant whose export holds the fence", async () => {
    expect(await deliverRetention(tenantFencedBy("tenant-export"))).toEqual({
      failureLogs: [
        [
          "Governance queue message failed.",
          {
            error: "Tenant governance is fenced by another operation.",
            errorType: "GovernanceError",
            kind: "retention",
            messageId: "retention-1",
            organizationId: ORGANIZATION_ID,
          },
        ],
      ],
      result: { batchItemFailures: [{ itemIdentifier: "retention-1" }] },
    });
  });
});
