import { BatchWriteCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  governanceLegacyInventoryPartition,
  governanceTenantDirectoryRecord,
  makeDynamoGovernanceStore,
  makeSemanticEventRecord,
  makeUniqueClaimRecord,
  uniqueClaimRequirements,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { describe, expect, test } from "bun:test";
import { decodeMemorySearchErasureReceipt } from "./governance-memory-search-erasure.ts";
import { createGovernanceService } from "./service.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const OPERATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const START = Date.parse("2026-10-23T00:00:00.000Z");
const AUDIT_ROOT_HASH = "5a0547479fa668700831241345f96547185e121bcd4fc0e06d455d322d66be67";
const TABLES = {
  control: "control",
  events: "events",
  execution: "execution",
  usage: "usage",
} as const;

function organization() {
  return withCanonicalRecordKeys({
    data: {
      createdAt: new Date(START).toISOString(),
      id: ORGANIZATION_ID,
      name: "Eval",
      slug: "eval",
      status: "active" as const,
      updatedAt: new Date(START).toISOString(),
      version: 1,
    },
    itemType: "organization" as const,
  }) as unknown as PlatformRecord;
}

function memoryEvent(index: number) {
  return makeSemanticEventRecord({
    aggregateId: `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}` as never,
    aggregateType: "memory",
    aggregateVersion: 1,
    eventId: `01ARZ3NDEKTSV4RRFFQ69G5E${String(index).padStart(2, "0")}` as never,
    eventType: "memory.updated",
    occurredAt: new Date(START).toISOString(),
    organizationId: ORGANIZATION_ID as never,
    payload: {} as never,
  }) as unknown as PlatformRecord;
}

function project() {
  return withCanonicalRecordKeys({
    data: {
      createdAt: new Date(START).toISOString(),
      id: "01ARZ3NDEKTSV4RRFFQ69G5FD1",
      name: "Project",
      organizationId: ORGANIZATION_ID,
      slug: "project",
      status: "active" as const,
      updatedAt: new Date(START).toISOString(),
      version: 1,
    },
    itemType: "project" as const,
  }) as unknown as PlatformRecord;
}

/**
 * A 20-event organization with a claim-owning project, three locators per page, and a clock that
 * advances a second per DynamoDB call, so one 20-second invocation cannot finish it.
 */
function organizationLargerThanOneInvocation(
  purgeMemorySearch?: (elapsedMilliseconds: number) => void,
  erasureInvocationMilliseconds = 20_000,
) {
  const fake = fakeDynamoDocumentClient();
  let clock = START;
  let writes = 0;
  let invocationStartedAt = START;
  let crashAfterWrite: number | undefined;
  const seed = (
    record: PlatformRecord,
    table: string,
    partitions: readonly ("legacy" | "shard")[],
  ) => {
    fake.put(table, record);
    const locator = governanceTenantDirectoryRecord(record)!;
    for (const partition of partitions) {
      fake.put(
        "control",
        partition === "shard"
          ? locator
          : { ...locator, pk: governanceLegacyInventoryPartition(ORGANIZATION_ID) },
      );
    }
  };
  seed(organization(), "control", ["legacy"]);
  for (let index = 0; index < 20; index += 1) {
    seed(memoryEvent(index), "events", index % 5 === 0 ? ["legacy", "shard"] : ["legacy"]);
  }
  const owner = project();
  seed(owner, "control", ["shard"]);
  seed(
    makeUniqueClaimRecord(
      uniqueClaimRequirements(owner)[0]!,
      new Date(START).toISOString(),
    ) as unknown as PlatformRecord,
    "control",
    ["legacy"],
  );
  const client = {
    send: async (command: unknown) => {
      clock += 1_000;
      if (command instanceof BatchWriteCommand || command instanceof TransactWriteCommand) {
        writes += 1;
        if (crashAfterWrite !== undefined && writes > crashAfterWrite) {
          throw new Error("worker crashed");
        }
      }
      return fake.client.send(command as never);
    },
  } as unknown as typeof fake.client;
  const now = () => new Date(clock);
  const store = makeDynamoGovernanceStore(client, TABLES, {
    batchWriteSleep: async () => {},
    now,
    generateId: () => "01ARZ3NDEKTSV4RRFFQ69G5FB9",
    tenantErasurePageSize: 3,
  });
  const service = createGovernanceService({
    allowedObjectBuckets: ["governance"],
    erasureInvocationMilliseconds,
    generateId: async () => "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    now,
    objectStore: {
      blockWrites: async () => {},
      delete: async () => {},
      deleteAllVersions: async () => {},
      find: async () => undefined,
      put: async () => {
        throw new Error("tenant erasure writes no objects");
      },
      read: async () => new Uint8Array(),
      size: async () => 0,
    },
    signer: { keyId: "key", publicKey: async () => "public", sign: async () => "signature" },
    snapshotByteLimit: 1_024,
    ...(purgeMemorySearch
      ? {
          purgeMemorySearch: async () => {
            purgeMemorySearch(clock - invocationStartedAt);
            return decodeMemorySearchErasureReceipt(
              { operationId: OPERATION_ID, targets: [] },
              OPERATION_ID,
            );
          },
        }
      : {}),
    store,
  });
  return {
    crashAfterWrite(count: number | undefined) {
      crashAfterWrite = count;
      writes = 0;
    },
    async eraseToCompletion() {
      for (let invocation = 1; invocation <= 100; invocation += 1) {
        invocationStartedAt = clock;
        const operation = await service.runOperation(ORGANIZATION_ID, OPERATION_ID);
        if (operation.status === "completed") return { invocations: invocation, operation };
        expect(operation).toMatchObject({ error: { code: "tenant_erasure_continuing" } });
        clock += 5 * 60_000;
      }
      throw new Error("tenant erasure did not finish in 100 invocations");
    },
    fake,
    leaseExpires() {
      clock += 17 * 60_000;
    },
    remaining: () =>
      ["control", "events", "execution", "usage"].flatMap((table) =>
        fake.items(table).map((item) => String(item.itemType)),
      ),
    request: () =>
      service.requestOperation({
        idempotencyKey: "erase-eval",
        kind: "tenant-erasure",
        operationId: OPERATION_ID,
        organizationId: ORGANIZATION_ID,
        principalId: PRINCIPAL_ID,
      }),
    service,
    writes: () => writes,
  };
}

describe("tenant erasure across invocations", () => {
  test("erases an organization larger than one invocation in several", async () => {
    const fixture = organizationLargerThanOneInvocation();
    await fixture.request();

    const { invocations, operation } = await fixture.eraseToCompletion();

    expect(invocations).toBe(10);
    expect(operation).toMatchObject({
      status: "completed",
      summary: { auditRootHash: AUDIT_ROOT_HASH, recordsDeleted: 25 },
    });
    expect(fixture.remaining()).toEqual(["erasure-receipt"]);
    expect(await fixture.service.getOperation(ORGANIZATION_ID, OPERATION_ID)).toMatchObject({
      status: "completed",
      summary: { auditRootHash: AUDIT_ROOT_HASH, recordsDeleted: 25 },
    });
  });

  test("resumes after a crash after any write and deletes every record and locator", async () => {
    const clean = organizationLargerThanOneInvocation();
    await clean.request();
    clean.crashAfterWrite(Number.MAX_SAFE_INTEGER);
    await clean.eraseToCompletion();
    const totalWrites = clean.writes();
    expect(totalWrites).toBeGreaterThan(20);

    for (let crashAfter = 0; crashAfter < totalWrites; crashAfter += 1) {
      const fixture = organizationLargerThanOneInvocation();
      await fixture.request();
      fixture.crashAfterWrite(crashAfter);
      expect(await fixture.eraseToCompletion().catch((cause: unknown) => cause)).toMatchObject({
        message: expect.stringContaining("worker crashed"),
      });
      fixture.crashAfterWrite(undefined);
      fixture.leaseExpires();

      const { operation } = await fixture.eraseToCompletion();

      expect({ crashAfter, remaining: fixture.remaining(), summary: operation.summary }).toEqual({
        crashAfter,
        remaining: ["erasure-receipt"],
        summary: { auditRootHash: AUDIT_ROOT_HASH, recordsDeleted: 25 },
      });
    }
  }, 30_000);

  test("starts the memory search purge only inside the invocation's time budget", async () => {
    const purgeStarts: number[] = [];
    const fixture = organizationLargerThanOneInvocation(
      (elapsed) => purgeStarts.push(elapsed),
      11_500,
    );
    await fixture.request();

    await fixture.eraseToCompletion();

    expect(purgeStarts).toEqual([5_000]);
  });
});
