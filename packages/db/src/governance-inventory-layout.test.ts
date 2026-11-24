import { QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  decodePlatformRecord,
  governanceInventoryLayout,
  governanceTenantDirectoryRecord,
  makeDynamoDatabase,
  makeDynamoGovernanceStore,
  moveTenantLegacyLocators,
  reconcileTenantShardLocators,
  withCanonicalRecordKeys,
  type GovernanceStore,
  type PlatformRecord,
} from "./index.ts";
import {
  fakeDynamoDocumentClient,
  type FakeDynamoDocumentClient,
} from "./testing/dynamo-document-client.fixture.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TABLE_NAMES = {
  control: "control",
  events: "events",
  execution: "execution",
  usage: "usage",
} as const;
const NOW = new Date("2026-08-21T00:00:00.000Z");
const LEGACY_PARTITION = `ORG#${ORGANIZATION_ID}#GOVERNANCE-INVENTORY`;
const SHARD_WRITES_MARKER = withCanonicalRecordKeys({
  data: { completedAt: "2026-08-21T00:00:00.000Z", id: "governance-inventory-shard-writes" },
  itemType: "deploy-migration" as const,
});

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
  });
}

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

/** Another process over the same table, with its own cached layout. */
function process(fake: FakeDynamoDocumentClient) {
  const client = {
    send: (command: QueryCommand) => fake.client.send(command),
  } as unknown as DynamoDBDocumentClient;
  return {
    database: makeDynamoDatabase(client, TABLE_NAMES),
    store: makeDynamoGovernanceStore(client, TABLE_NAMES, { now: () => NOW }),
    tables: { client, tableNames: TABLE_NAMES },
  };
}

/** Lists the organization's records the way code released before the shards does. */
async function* replacedCodeListing(fake: FakeDynamoDocumentClient, pageSize: number) {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await fake.client.send(
      new QueryCommand({
        ConsistentRead: true,
        ExclusiveStartKey: exclusiveStartKey,
        ExpressionAttributeNames: { "#inventory": "pk" },
        ExpressionAttributeValues: { ":inventory": LEGACY_PARTITION },
        KeyConditionExpression: "#inventory = :inventory",
        Limit: pageSize,
        TableName: TABLE_NAMES.control,
      }),
    );
    yield (page.Items ?? []).flatMap((item) => {
      const locator = Effect.runSync(decodePlatformRecord(item));
      if (locator.itemType !== "governance-tenant-record") return [];
      const { recordPk, recordSk, recordTable } = locator.data;
      const record = fake.get(recordTable, { pk: recordPk, sk: recordSk });
      return record ? [String(record.sk)] : [];
    });
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
}

async function replacedCodeListAll(fake: FakeDynamoDocumentClient) {
  const listed: string[] = [];
  for await (const page of replacedCodeListing(fake, 100)) listed.push(...page);
  return listed.toSorted();
}

async function listAll(store: GovernanceStore) {
  const listed: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listTenantRecords(ORGANIZATION_ID, cursor);
    listed.push(...page.items.map(({ record }) => record.sk));
    cursor = page.cursor;
  } while (cursor);
  return listed.toSorted();
}

function locatorPartitions(fake: FakeDynamoDocumentClient) {
  return fake
    .items("control")
    .filter((item) => item.itemType === "governance-tenant-record")
    .map((item) => (item.pk === LEGACY_PARTITION ? "legacy" : "shard"))
    .toSorted();
}

function sks(records: readonly PlatformRecord[]) {
  return records.map((record) => record.sk).toSorted();
}

describe("governance inventory layout", () => {
  test("re-reads a legacy layout after the cache window and keeps a sharded one", async () => {
    const fake = fakeDynamoDocumentClient();
    const startedAt = Date.parse("2026-08-21T00:00:00.000Z");

    expect(await governanceInventoryLayout(fake.client, "control", startedAt)).toBe("legacy");
    fake.put("control", SHARD_WRITES_MARKER);
    expect(await governanceInventoryLayout(fake.client, "control", startedAt + 29_999)).toBe(
      "legacy",
    );
    expect(await governanceInventoryLayout(fake.client, "control", startedAt + 30_000)).toBe(
      "sharded",
    );
    fake.delete("control", SHARD_WRITES_MARKER);
    expect(await governanceInventoryLayout(fake.client, "control", startedAt + 3_600_000)).toBe(
      "sharded",
    );
  });

  test("an erasure listing in replaced code misses no record while released code writes before and after the switch", async () => {
    const fake = fakeDynamoDocumentClient();
    fake.put("control", organization());
    const beforeDeploy = ["before.0", "before.1", "before.2", "before.3"].map(counter);
    for (const record of beforeDeploy) {
      fake.put("usage", record);
      fake.put("control", {
        ...governanceTenantDirectoryRecord(record)!,
        pk: LEGACY_PARTITION,
      });
    }
    const early = process(fake);
    const replaced = replacedCodeListing(fake, 2);

    const firstPage = (await replaced.next()).value ?? [];
    const duringRollout = ["rollout.0", "rollout.1"].map(counter);
    for (const record of duringRollout) {
      await early.database.transactWrite([{ kind: "put", record }]);
    }
    expect(await listAll(early.store)).toEqual(sks([...beforeDeploy, ...duringRollout]));
    const laterPages: string[] = [];
    for await (const page of replaced) laterPages.push(...page);

    expect([...firstPage, ...laterPages].filter((sk) => sk.includes("before"))).toEqual(
      expect.arrayContaining(sks(beforeDeploy)),
    );
    expect(await replacedCodeListAll(fake)).toEqual(sks([...beforeDeploy, ...duringRollout]));
    expect(locatorPartitions(fake)).toEqual(Array(6).fill("legacy"));

    fake.put("control", SHARD_WRITES_MARKER);
    const late = process(fake);
    const staleWrite = counter("after.stale");
    const freshWrite = counter("after.fresh");
    await early.database.transactWrite([{ kind: "put", record: staleWrite }]);
    await late.database.transactWrite([{ kind: "put", record: freshWrite }]);
    const everything = sks([...beforeDeploy, ...duringRollout, staleWrite, freshWrite]);

    expect(locatorPartitions(fake)).toEqual([...Array(7).fill("legacy"), "shard"]);
    expect(await listAll(early.store)).toEqual(everything);
    expect(await reconcileTenantShardLocators(late.tables, ORGANIZATION_ID)).toBe(1);
    expect(await listAll(late.store)).toEqual(everything);
    expect(locatorPartitions(fake)).toEqual([...Array(7).fill("legacy"), "shard"]);

    let moved = 0;
    for await (const page of moveTenantLegacyLocators(late.tables, ORGANIZATION_ID)) {
      moved += page.locators;
    }
    expect(moved).toBe(7);
    expect(locatorPartitions(fake)).toEqual(Array(8).fill("shard"));
    expect(await listAll(late.store)).toEqual(everything);
    expect(await listAll(early.store)).toEqual(everything);
  });
});
