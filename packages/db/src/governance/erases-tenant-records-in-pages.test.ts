import { BatchWriteCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import {
  governanceLegacyInventoryPartition,
  governanceTenantDirectoryRecord,
  makeDynamoGovernanceStore,
  makeSemanticEventRecord,
  makeUniqueClaimRecord,
  uniqueClaimRequirements,
  withCanonicalRecordKeys,
  type GovernanceStore,
  type PlatformRecord,
} from "../index.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const OPERATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const FENCE = {
  createdAt: "2026-08-21T00:00:00.000Z",
  operationId: OPERATION_ID,
  organizationId: ORGANIZATION_ID,
};
const NOW = new Date("2026-08-21T00:00:00.000Z");
const DEADLINE = "2026-08-21T00:15:00.000Z";
const TABLE_NAMES = {
  control: "control",
  events: "events",
  execution: "execution",
  usage: "usage",
} as const;

function event(version: number) {
  return makeSemanticEventRecord({
    aggregateId: `01ARZ3NDEKTSV4RRFFQ69G5FC${version}` as never,
    aggregateType: "memory",
    aggregateVersion: version,
    eventId: `01ARZ3NDEKTSV4RRFFQ69G5FB${version}` as never,
    eventType: "memory.updated",
    occurredAt: NOW.toISOString(),
    organizationId: ORGANIZATION_ID as never,
    payload: {} as never,
  }) as unknown as PlatformRecord;
}

function project() {
  return withCanonicalRecordKeys({
    data: {
      createdAt: NOW.toISOString(),
      id: "01ARZ3NDEKTSV4RRFFQ69G5FD1",
      name: "Project",
      organizationId: ORGANIZATION_ID,
      slug: "project",
      status: "active" as const,
      updatedAt: NOW.toISOString(),
      version: 1,
    },
    itemType: "project" as const,
  }) as unknown as PlatformRecord;
}

/** The owner's claim value, held by a project of another organization. */
function otherOrganizationClaim(owner: PlatformRecord) {
  const requirement = uniqueClaimRequirements(owner)[0]!;
  return makeUniqueClaimRecord(
    {
      ...requirement,
      ownerId: "01ARZ3NDEKTSV4RRFFQ69G5FD2",
      ownerPk: `ORG#${OTHER_ORGANIZATION_ID}`,
      ownerSk: "PROJECT#01ARZ3NDEKTSV4RRFFQ69G5FD2",
    },
    NOW.toISOString(),
  );
}

function fixture(fenceOperationId = OPERATION_ID) {
  const fake = fakeDynamoDocumentClient();
  fake.put(
    "control",
    withCanonicalRecordKeys({
      data: { ...FENCE, id: ORGANIZATION_ID, operationId: fenceOperationId },
      itemType: "erasure-fence" as const,
    }),
  );
  const batchDeletes: string[] = [];
  const transactions: TransactWriteCommand["input"][] = [];
  let failBatchWrite: number | undefined;
  let crashed = false;
  let afterWrite: ((command: unknown) => void) | undefined;
  const sleeps: number[] = [];
  const client = {
    send: async (command: unknown) => {
      if (command instanceof BatchWriteCommand && failBatchWrite !== undefined) {
        failBatchWrite -= 1;
        crashed ||= failBatchWrite === 0;
      }
      if (crashed) throw new Error("worker crashed");
      if (command instanceof BatchWriteCommand) {
        for (const writes of Object.values(command.input.RequestItems ?? {})) {
          for (const write of writes) batchDeletes.push(String(write.DeleteRequest?.Key?.sk));
        }
      }
      if (command instanceof TransactWriteCommand) transactions.push(command.input);
      const result = await fake.client.send(command as never);
      afterWrite?.(command);
      return result;
    },
  } as unknown as typeof fake.client;
  const store = makeDynamoGovernanceStore(client, TABLE_NAMES, {
    batchWriteRandom: () => 0.5,
    batchWriteSleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    now: () => NOW,
    tenantErasurePageSize: 2,
  });
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
  const locators = () =>
    fake.items("control").filter((item) => item.itemType === "governance-tenant-record").length;
  return {
    afterWrite: (hook: (command: unknown) => void) => {
      afterWrite = hook;
    },
    batchDeletes,
    failBatchWriteCall: (call: number) => {
      failBatchWrite = call;
    },
    restart: () => {
      crashed = false;
      failBatchWrite = undefined;
    },
    fake,
    locators,
    seed,
    sleeps,
    store,
    transactions,
  };
}

async function eraseAll(store: GovernanceStore) {
  const listed: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listTenantErasurePage(ORGANIZATION_ID, cursor ? { cursor } : {});
    listed.push(
      ...page.records.map(
        ({ record, dependents }) => `${record.itemType}+${dependents?.length ?? 0}`,
      ),
    );
    await store.eraseTenantRecords(FENCE, page.records, page.staleLocators, DEADLINE);
    cursor = page.cursor;
  } while (cursor);
  return listed;
}

describe("tenant erasure pages", () => {
  test("deletes each ordinary record and only the locators the listing found, without transactions", async () => {
    const { batchDeletes, fake, locators, seed, store, transactions } = fixture();
    seed(event(1), "events", ["legacy"]);
    seed(event(2), "events", ["shard"]);
    seed(event(3), "events", ["legacy", "shard"]);

    expect(await eraseAll(store)).toEqual([
      "semantic-event+0",
      "semantic-event+0",
      "semantic-event+0",
    ]);

    expect(batchDeletes).toHaveLength(7);
    expect(transactions).toHaveLength(0);
    expect(fake.items("events")).toHaveLength(0);
    expect(locators()).toBe(0);
  });

  test("the transactional delete it replaces sends three deletes per ordinary record", async () => {
    const { seed, store, transactions } = fixture();
    const records = [event(1), event(2), event(3)];
    for (const record of records) seed(record, "events", ["legacy"]);

    await store.deleteTenantRecords(
      records.map((record) => ({ record, table: "events" as const })),
      DEADLINE,
    );

    expect(transactions.flatMap((input) => input.TransactItems ?? [])).toHaveLength(9);
  });

  test("a crash after the record deletes leaves locators that the next listing prunes", async () => {
    const { failBatchWriteCall, fake, locators, restart, seed, store } = fixture();
    seed(event(1), "events", ["legacy"]);
    seed(event(2), "events", ["legacy"]);
    failBatchWriteCall(2);

    expect(await eraseAll(store).catch((cause: unknown) => cause)).toMatchObject({
      message: expect.stringContaining("worker crashed"),
    });
    expect(fake.items("events")).toHaveLength(0);
    expect(locators()).toBe(2);
    restart();

    expect(await eraseAll(store)).toEqual([]);
    expect(locators()).toBe(0);
  });

  test("retries unprocessed batch deletes with backoff", async () => {
    const { fake, locators, seed, sleeps, store } = fixture();
    seed(event(1), "events", ["legacy"]);
    fake.deferNextBatchWrites(2);

    await eraseAll(store);

    expect(sleeps).toEqual([25, 50]);
    expect(fake.items("events")).toHaveLength(0);
    expect(locators()).toBe(0);
  });

  test("deletes a claim owner after its claim was deleted on an earlier page", async () => {
    const { fake, locators, seed, store } = fixture();
    const owner = project();
    const claim = makeUniqueClaimRecord(uniqueClaimRequirements(owner)[0]!, NOW.toISOString());
    seed(claim as unknown as PlatformRecord, "control", ["legacy"]);
    seed(owner, "control", ["shard"]);

    expect(await eraseAll(store)).toEqual(["unique-claim+0", "project+0"]);

    expect(fake.get("control", { pk: owner.pk, sk: owner.sk })).toBeUndefined();
    expect(fake.get("control", { pk: claim.pk, sk: claim.sk })).toBeUndefined();
    expect(locators()).toBe(0);
  });

  test("deletes a claim owner with its claim in one transaction", async () => {
    const { fake, locators, seed, store, transactions } = fixture();
    const owner = project();
    const claim = makeUniqueClaimRecord(uniqueClaimRequirements(owner)[0]!, NOW.toISOString());
    seed(owner, "control", ["legacy"]);
    seed(claim as unknown as PlatformRecord, "control", ["shard"]);

    expect(await eraseAll(store)).toEqual(["project+1"]);

    expect(transactions).toHaveLength(1);
    expect(fake.get("control", { pk: claim.pk, sk: claim.sk })).toBeUndefined();
    expect(locators()).toBe(0);
  });

  test("keeps a claim another organization takes after the owner's transaction freed it", async () => {
    const { afterWrite, fake, locators, seed, store } = fixture();
    const owner = project();
    const claim = makeUniqueClaimRecord(uniqueClaimRequirements(owner)[0]!, NOW.toISOString());
    seed(owner, "control", ["legacy"]);
    seed(claim as unknown as PlatformRecord, "control", ["legacy"]);
    const taken = otherOrganizationClaim(owner);
    afterWrite((command) => {
      if (command instanceof TransactWriteCommand) fake.put("control", taken);
    });

    expect((await eraseAll(store)).toSorted()).toEqual(["project+1", "unique-claim+0"]);

    expect(fake.get("control", { pk: claim.pk, sk: claim.sk })).toEqual(
      taken as unknown as Record<string, unknown>,
    );
    expect(fake.get("control", { pk: owner.pk, sk: owner.sk })).toBeUndefined();
    expect(locators()).toBe(0);
  });

  test("prunes a claim locator once another organization took the claim", async () => {
    const { afterWrite, fake, locators, seed, store } = fixture();
    const owner = project();
    const claim = makeUniqueClaimRecord(uniqueClaimRequirements(owner)[0]!, NOW.toISOString());
    seed(claim as unknown as PlatformRecord, "control", ["legacy", "shard"]);
    const taken = otherOrganizationClaim(owner);
    afterWrite(() => {
      if (!fake.get("control", { pk: claim.pk, sk: claim.sk })) fake.put("control", taken);
    });

    expect(await eraseAll(store)).toEqual(["unique-claim+0"]);

    expect(fake.get("control", { pk: claim.pk, sk: claim.sk })).toEqual(
      taken as unknown as Record<string, unknown>,
    );
    expect(locators()).toBe(0);
  });

  test("refuses to delete without the erasure fence", async () => {
    const { fake, seed, store } = fixture("01ARZ3NDEKTSV4RRFFQ69G5FAZ");
    seed(event(1), "events", ["legacy"]);

    expect(await eraseAll(store).catch((cause: unknown) => cause)).toMatchObject({
      code: "tenant_erasure_fence_lost",
    });
    expect(fake.items("events")).toHaveLength(1);
  });
});
