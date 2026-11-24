import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import {
  estimateTenantLegacyLocatorMoves,
  governanceTenantDirectoryRecord,
  makeDynamoDatabase,
  makeDynamoGovernanceStore,
  moveTenantLegacyLocators,
  withCanonicalRecordKeys,
  type GovernanceStore,
  type LegacyLocatorMoveCost,
  type PlatformRecord,
  type TenantRecord,
} from "../index.ts";
import {
  fakeDynamoDocumentClient,
  transactionCanceledError,
  type FakeDynamoDocumentClient,
} from "../testing/dynamo-document-client.fixture.ts";
import { policyRecord } from "./dynamo-store.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BRAIN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const TABLE_NAMES = {
  control: "control",
  events: "events",
  execution: "execution",
  usage: "usage",
} as const;
const NOW = new Date("2026-08-21T00:00:00.000Z");
const LEGACY_PARTITION = `ORG#${ORGANIZATION_ID}#GOVERNANCE-INVENTORY`;
const SHARD_PARTITIONS = Array.from(
  { length: 16 },
  (_, shard) =>
    `ORG#${ORGANIZATION_ID}#GOVERNANCE-INVENTORY#SHARD#${String(shard).padStart(2, "0")}`,
);

function organization() {
  return withCanonicalRecordKeys({
    data: {
      createdAt: "2026-08-21T00:00:00.000Z",
      id: ORGANIZATION_ID,
      name: "Deployments.ai",
      slug: "deployments-ai",
      status: "active" as const,
      updatedAt: "2026-08-21T00:00:00.000Z",
      version: 1,
    },
    itemType: "organization" as const,
  }) as unknown as PlatformRecord;
}

function counter(scopeId: string, limitKey: string, expiresAt = "2026-08-22T00:00:00.000Z") {
  return withCanonicalRecordKeys({
    data: {
      count: 1,
      expiresAt,
      limitKey,
      organizationId: ORGANIZATION_ID,
      scopeId,
      version: 1,
      window: "2026-08-21T00",
    },
    itemType: "rate-limit-counter" as const,
    ttl: Math.floor(Date.parse(expiresAt) / 1_000),
  }) as unknown as PlatformRecord;
}

function legacyLocator(record: PlatformRecord) {
  return { ...governanceTenantDirectoryRecord(record)!, pk: LEGACY_PARTITION };
}

function seeded() {
  const fake = fakeDynamoDocumentClient();
  fake.put("control", organization());
  fake.put(
    "control",
    withCanonicalRecordKeys({
      data: { completedAt: "2026-08-21T00:00:00.000Z", id: "governance-inventory-shard-writes" },
      itemType: "deploy-migration" as const,
    }),
  );
  return {
    database: makeDynamoDatabase(fake.client, TABLE_NAMES),
    fake,
    store: makeDynamoGovernanceStore(fake.client, TABLE_NAMES, { now: () => NOW }),
  };
}

async function listAll(store: GovernanceStore) {
  const items: TenantRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listTenantRecords(ORGANIZATION_ID, cursor);
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items.map(({ record, table }) => `${table} ${record.pk} ${record.sk}`).toSorted();
}

function locatorPartitions(fake: FakeDynamoDocumentClient) {
  return fake
    .items("control")
    .filter((item) => item.itemType === "governance-tenant-record")
    .map((item) => String(item.pk));
}

async function moveAll(client: DynamoDBDocumentClient) {
  const pages: LegacyLocatorMoveCost[] = [];
  for await (const page of moveTenantLegacyLocators(
    { client, tableNames: TABLE_NAMES },
    ORGANIZATION_ID,
  )) {
    pages.push(page);
  }
  return pages;
}

describe("governance inventory shards", () => {
  test("hashes the locators of many records over all 16 shards", () => {
    const records = Array.from({ length: 1_600 }, (_, index) =>
      counter(ORGANIZATION_ID, `test.limit.${index}`),
    );
    const partitions = records.map((record) => governanceTenantDirectoryRecord(record)!.pk);
    const perShard = SHARD_PARTITIONS.map(
      (partition) => partitions.filter((pk) => pk === partition).length,
    );

    expect(new Set(partitions).size).toBe(16);
    expect(SHARD_PARTITIONS.every((partition) => partitions.includes(partition))).toBe(true);
    expect(Math.min(...perShard)).toBeGreaterThan(70);
    expect(Math.max(...perShard)).toBeLessThan(130);
  });

  test("a stored record's shard never changes", () => {
    expect(governanceTenantDirectoryRecord(counter(ORGANIZATION_ID, "test.limit.0"))!.pk).toBe(
      `ORG#${ORGANIZATION_ID}#GOVERNANCE-INVENTORY#SHARD#15`,
    );
  });

  test("a sharded listing resolves legacy locators in place and moves none", async () => {
    const { database, fake, store } = seeded();
    const written = Array.from({ length: 48 }, (_, index) =>
      counter(ORGANIZATION_ID, `written.${index}`),
    );
    for (const record of written) await database.transactWrite([{ kind: "put", record }]);
    const legacy = Array.from({ length: 250 }, (_, index) =>
      counter(ORGANIZATION_ID, `legacy.${index}`),
    );
    for (const record of legacy) {
      fake.put("usage", record);
      fake.put("control", legacyLocator(record));
    }
    const transactions = fake.transactions.length;

    expect(await listAll(store)).toEqual(
      [...written, ...legacy].map((record) => `usage ${record.pk} ${record.sk}`).toSorted(),
    );
    expect(fake.transactions.length - transactions).toBe(0);
    expect(locatorPartitions(fake).filter((pk) => pk === LEGACY_PARTITION)).toHaveLength(250);
  });

  test("a sharded listing deletes a legacy locator whose record is already gone", async () => {
    const { fake, store } = seeded();
    const erased = counter(ORGANIZATION_ID, "erased.by.new.code");
    fake.put("control", legacyLocator(erased));

    expect(await listAll(store)).toEqual([]);
    expect(locatorPartitions(fake)).toEqual([]);
  });

  test("a sharded listing replaces a stale legacy locator with the one its record defines", async () => {
    const { fake, store } = seeded();
    const before = counter(ORGANIZATION_ID, "updated", "2026-08-22T00:00:00.000Z");
    const after = counter(ORGANIZATION_ID, "updated", "2026-08-23T00:00:00.000Z");
    fake.put("usage", after);
    fake.put("control", legacyLocator(before));

    expect(new Set(await listAll(store))).toEqual(new Set([`usage ${after.pk} ${after.sk}`]));
    expect(fake.get("control", governanceTenantDirectoryRecord(after)!)?.data).toMatchObject({
      recordTtl: Math.floor(Date.parse("2026-08-23T00:00:00.000Z") / 1_000),
    });
    expect(locatorPartitions(fake)).toEqual([governanceTenantDirectoryRecord(after)!.pk]);
  });

  test("a legacy locator whose record another organization now owns is deleted, not moved", async () => {
    const claimedBefore = counter(ORGANIZATION_ID, "claimed");
    const claimedNow = withCanonicalRecordKeys({
      ...claimedBefore,
      data: { ...claimedBefore.data, organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FB0" },
    }) as unknown as PlatformRecord;
    const listing = seeded();
    listing.fake.put("usage", claimedNow);
    listing.fake.put("control", legacyLocator(claimedBefore));
    const moving = seeded();
    moving.fake.put("usage", claimedNow);
    moving.fake.put("control", legacyLocator(claimedBefore));

    expect(await listAll(listing.store)).toEqual([]);
    expect(locatorPartitions(listing.fake)).toEqual([]);
    expect(await listAll(listing.store)).toEqual([]);
    expect(await moveAll(moving.fake.client)).toHaveLength(1);
    expect(locatorPartitions(moving.fake)).toEqual([]);
    expect(await listAll(moving.store)).toEqual([]);
  });

  test("a legacy-layout listing still fails closed on a stale legacy locator", async () => {
    const fake = fakeDynamoDocumentClient();
    fake.put("control", organization());
    fake.put("control", legacyLocator(counter(ORGANIZATION_ID, "erased.by.new.code")));
    const store = makeDynamoGovernanceStore(fake.client, TABLE_NAMES, { now: () => NOW });

    expect(await listAll(store).catch((cause: unknown) => String(cause))).toBe(
      "Error: Governance inventory lost a tenant record before its recorded TTL.",
    );
    expect(locatorPartitions(fake)).toEqual([LEGACY_PARTITION]);
  });

  function rewrittenOnRead(
    fake: FakeDynamoDocumentClient,
    initial: PlatformRecord,
    rewrites: number,
    change: (data: Record<string, unknown>) => Record<string, unknown>,
  ) {
    const writer = makeDynamoDatabase(fake.client, TABLE_NAMES);
    let record = initial;
    let remaining = rewrites;
    return {
      send: async (command: GetCommand) => {
        const result = await fake.client.send(command);
        if (remaining > 0 && command instanceof GetCommand && command.input.Key?.pk === record.pk) {
          remaining -= 1;
          const previousRecord = record;
          const data = previousRecord.data as Record<string, unknown> & { version: number };
          record = withCanonicalRecordKeys({
            ...previousRecord,
            data: { ...change(data), version: data.version + 1 },
          }) as unknown as PlatformRecord;
          await writer.transactWrite([{ kind: "put", previousRecord, record }]);
        }
        return result;
      },
    } as unknown as DynamoDBDocumentClient;
  }

  test("moves the legacy locator of a record rewritten after each of its reads", async () => {
    const { fake } = seeded();
    const record = counter(ORGANIZATION_ID, "hot");
    fake.put("usage", record);
    fake.put("control", legacyLocator(record));

    expect(
      await moveAll(
        rewrittenOnRead(fake, record, Infinity, (data) => ({
          ...data,
          count: Number(data.count) + 1,
        })),
      ),
    ).toHaveLength(1);
    expect(locatorPartitions(fake)).toEqual([`${SHARD_PARTITIONS[15]}`]);
    expect(fake.get("usage", record)?.data).toMatchObject({ count: 3, version: 3 });
  });

  test("keeps the locator a writer rewrote while the move read the record", async () => {
    const { fake } = seeded();
    const policy = policyRecord({
      artifacts: 30,
      audit: 365,
      createdAt: "2026-08-20T00:00:00.000Z",
      events: 30,
      messages: 30,
      organizationId: ORGANIZATION_ID,
      runs: 30,
      threads: 30,
      updatedAt: "2026-08-20T00:00:00.000Z",
      updatedByPrincipalId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
      version: 1,
    }) as PlatformRecord;
    fake.put("control", policy);
    fake.put("control", legacyLocator(policy));

    await moveAll(
      rewrittenOnRead(fake, policy, 1, (data) => ({
        ...data,
        updatedAt: "2026-08-21T12:00:00.000Z",
      })),
    );
    const [locator, ...others] = fake
      .items("control")
      .filter((item) => item.itemType === "governance-tenant-record");
    expect(others).toEqual([]);
    expect(locator?.pk).toBe(`ORG#${ORGANIZATION_ID}#GOVERNANCE-INVENTORY#SHARD#01`);
    expect(locator?.data).toMatchObject({ recordTimestamp: "2026-08-21T12:00:00.000Z" });
  });

  test("a move cancelled by a concurrent write re-reads and retries", async () => {
    const { fake } = seeded();
    const record = counter(ORGANIZATION_ID, "contended");
    fake.put("usage", record);
    fake.put("control", legacyLocator(record));
    fake.failNextTransaction(
      (input) =>
        input.TransactItems?.some((item) => item.Delete?.Key?.pk === LEGACY_PARTITION) ?? false,
      () => transactionCanceledError(["None", "TransactionConflict", "None"]),
    );

    await moveAll(fake.client);
    expect(fake.transactions.map(({ outcome }) => outcome)).toEqual(["failed", "applied"]);
    expect(locatorPartitions(fake)).toEqual([governanceTenantDirectoryRecord(record)!.pk]);
  });

  test("moves legacy locators a page at a time and prices each page", async () => {
    const { fake } = seeded();
    const legacy = Array.from({ length: 150 }, (_, index) =>
      counter(ORGANIZATION_ID, `legacy.${index}`),
    );
    for (const record of legacy) {
      fake.put("usage", record);
      fake.put("control", legacyLocator(record));
    }
    const tables = { client: fake.client, tableNames: TABLE_NAMES };

    expect(await estimateTenantLegacyLocatorMoves(tables, ORGANIZATION_ID)).toEqual({
      locators: 150,
      readUnits: 319,
      writeUnits: 900,
    });
    expect(await moveAll(fake.client)).toEqual([
      { locators: 100, readUnits: 213, writeUnits: 600 },
      { locators: 50, readUnits: 107, writeUnits: 300 },
    ]);
    expect(locatorPartitions(fake).filter((pk) => pk === LEGACY_PARTITION)).toEqual([]);
    expect(await estimateTenantLegacyLocatorMoves(tables, ORGANIZATION_ID)).toEqual({
      locators: 0,
      readUnits: 0,
      writeUnits: 0,
    });
  });

  test("Brain erasure lists a record whose locator is still on the legacy partition", async () => {
    const { fake, store } = seeded();
    const brainCounter = counter(BRAIN_ID, "brain-upload.issuance.brain");
    fake.put("usage", brainCounter);
    fake.put("control", legacyLocator(brainCounter));

    const listed: TenantRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listBrainRecords(ORGANIZATION_ID, BRAIN_ID, cursor);
      listed.push(...page.items);
      cursor = page.cursor;
    } while (cursor);

    expect(listed.map(({ record }) => record.sk)).toEqual([brainCounter.sk]);
    expect(locatorPartitions(fake)).toEqual([LEGACY_PARTITION]);
  });
});
