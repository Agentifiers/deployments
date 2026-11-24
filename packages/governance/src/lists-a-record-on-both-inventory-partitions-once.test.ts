import { describe, expect, test } from "bun:test";
import {
  governanceTenantDirectoryRecord,
  makeDynamoGovernanceStore,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { allTenantRecords } from "./governance-service-support.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const LEGACY_PARTITION = `ORG#${ORGANIZATION_ID}#GOVERNANCE-INVENTORY`;
const TABLE_NAMES = {
  control: "control",
  events: "events",
  execution: "execution",
  usage: "usage",
} as const;

function counter(limitKey: string) {
  const expiresAt = "2026-08-22T00:00:00.000Z";
  return withCanonicalRecordKeys({
    data: {
      count: 1,
      expiresAt,
      limitKey,
      organizationId: ORGANIZATION_ID,
      scopeId: ORGANIZATION_ID,
      version: 1,
      window: "2026-08-21T00",
    },
    itemType: "rate-limit-counter" as const,
    ttl: Math.floor(Date.parse(expiresAt) / 1_000),
  }) as unknown as PlatformRecord;
}

/** One counter whose locator is on its shard and, left by a writer before the switch, on the legacy partition. */
function switchWindowInventory() {
  const fake = fakeDynamoDocumentClient();
  const record = counter("switch-window");
  const shardLocator = governanceTenantDirectoryRecord(record)!;
  fake.put("usage", record);
  fake.put("control", shardLocator);
  fake.put("control", { ...shardLocator, pk: LEGACY_PARTITION });
  const store = makeDynamoGovernanceStore(fake.client, TABLE_NAMES, {
    now: () => new Date("2026-08-21T00:00:00.000Z"),
  });
  return { fake, record, shardLocator, store };
}

describe("tenant inventory during the shard switch", () => {
  test("store pages list the record from both partitions on different pages", async () => {
    const { record, store } = switchWindowInventory();
    const pagesListingIt: number[] = [];
    let cursor: string | undefined;
    let page = 0;
    do {
      const listed = await store.listTenantRecords(ORGANIZATION_ID, cursor);
      if (listed.items.some((item) => item.record.sk === record.sk)) pagesListingIt.push(page);
      cursor = listed.cursor;
      page += 1;
    } while (cursor);

    expect(pagesListingIt).toHaveLength(2);
    expect(pagesListingIt[0]).toBe(0);
  });

  test("allTenantRecords lists the record once", async () => {
    const { record, store } = switchWindowInventory();

    expect(await allTenantRecords({ store }, ORGANIZATION_ID)).toEqual([
      { record, table: "usage" },
    ]);
  });

  test("erasing the listed record deletes its locator on both partitions", async () => {
    const { fake, shardLocator, store } = switchWindowInventory();

    await store.deleteTenantRecords(
      await allTenantRecords({ store }, ORGANIZATION_ID),
      "2026-08-21T00:15:00.000Z",
    );

    expect(fake.get("control", { pk: LEGACY_PARTITION, sk: shardLocator.sk })).toBeUndefined();
    expect(fake.get("control", shardLocator)).toBeUndefined();
    expect(await allTenantRecords({ store }, ORGANIZATION_ID)).toEqual([]);
  });
});
