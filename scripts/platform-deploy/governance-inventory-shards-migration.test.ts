import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  DEFAULT_TABLE_NAMES,
  governanceTenantDirectoryRecord,
  makeDynamoDatabase,
  makeDynamoGovernanceStore,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import {
  fakeDynamoDocumentClient,
  type FakeDynamoDocumentClient,
} from "@deployments-ai/db/dynamo-testing";
import { describe, expect, test } from "bun:test";
import {
  recheckGovernanceInventoryShards,
  switchGovernanceInventoryShardWrites,
} from "./governance-inventory-shards-migration.ts";

const AT = "2026-10-01T00:00:00.000Z";
const ORG_A = "01J9ZQ5Y5V7Q8R3X2K4M6N8P1A";
const ORG_B = "01J9ZQ5Y5V7Q8R3X2K4M6N8P1B";
const CONTROL = DEFAULT_TABLE_NAMES.control;
const USAGE = DEFAULT_TABLE_NAMES.usage;
const tables = (client: DynamoDBDocumentClient) => ({ client, tableNames: DEFAULT_TABLE_NAMES });

function organization(id: string) {
  return withCanonicalRecordKeys({
    data: {
      createdAt: AT,
      id,
      name: id,
      slug: id.toLowerCase(),
      status: "active",
      updatedAt: AT,
      version: 1,
    },
    itemType: "organization" as const,
  }) as unknown as PlatformRecord;
}

function counter(organizationId: string, limitKey: string, expiresAt = "2027-01-01T00:00:00.000Z") {
  return withCanonicalRecordKeys({
    data: {
      count: 1,
      expiresAt,
      limitKey,
      organizationId,
      scopeId: organizationId,
      version: 1,
      window: "2026-10-01T00",
    },
    itemType: "rate-limit-counter" as const,
    ttl: Math.floor(Date.parse(expiresAt) / 1_000),
  }) as unknown as PlatformRecord;
}

function legacyLocator(record: PlatformRecord) {
  const locator = governanceTenantDirectoryRecord(record)!;
  return { ...locator, pk: `ORG#${locator.data.organizationId}#GOVERNANCE-INVENTORY` };
}

function locators(fake: FakeDynamoDocumentClient) {
  return fake.items(CONTROL).filter((item) => item.itemType === "governance-tenant-record");
}

async function listed(fake: FakeDynamoDocumentClient, organizationId: string) {
  const store = makeDynamoGovernanceStore(fake.client, DEFAULT_TABLE_NAMES);
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listTenantRecords(organizationId, cursor);
    keys.push(...page.items.map(({ record }) => `${record.pk} ${record.sk}`));
    cursor = page.cursor;
  } while (cursor);
  return keys.toSorted();
}

function isLegacyPartition(partition: unknown) {
  return /^ORG#[0-9A-Z]{26}#GOVERNANCE-INVENTORY$/.test(String(partition));
}

/** Records every command's kind and every legacy-partition item it touched. */
function recordingClient(fake: FakeDynamoDocumentClient) {
  const commands: string[] = [];
  const legacyTouches: string[] = [];
  const client = {
    send: async (command: GetCommand | QueryCommand | TransactWriteCommand) => {
      commands.push(command.constructor.name);
      if (command instanceof QueryCommand) {
        const partition = command.input.ExpressionAttributeValues?.[":inventory"];
        if (isLegacyPartition(partition)) legacyTouches.push(`query ${String(partition)}`);
      }
      if (command instanceof GetCommand && isLegacyPartition(command.input.Key?.pk)) {
        legacyTouches.push(`get ${String(command.input.Key?.pk)}`);
      }
      if (command instanceof TransactWriteCommand) {
        for (const item of command.input.TransactItems ?? []) {
          const pk = item.Put?.Item?.pk ?? item.Delete?.Key?.pk ?? item.ConditionCheck?.Key?.pk;
          if (isLegacyPartition(pk)) legacyTouches.push(`write ${String(pk)}`);
        }
      }
      return fake.client.send(command as never);
    },
  } as unknown as DynamoDBDocumentClient;
  return { client, commands, legacyTouches };
}

async function deployedState() {
  const fake = fakeDynamoDocumentClient();
  fake.put(CONTROL, organization(ORG_A));
  await switchGovernanceInventoryShardWrites(tables(fake.client));
  fake.put(CONTROL, organization(ORG_B));
  const legacy = [0, 1, 2].map((index) => counter(ORG_A, `legacy.${index}`));
  for (const record of legacy) {
    fake.put(USAGE, record);
    fake.put(CONTROL, legacyLocator(record));
  }
  fake.put(CONTROL, legacyLocator(counter(ORG_A, "deleted.by.released.code")));
  fake.put(CONTROL, governanceTenantDirectoryRecord(counter(ORG_A, "deleted.by.replaced.code"))!);
  const rewritten = counter(ORG_A, "rewritten.by.replaced.code", "2027-02-01T00:00:00.000Z");
  fake.put(USAGE, rewritten);
  fake.put(CONTROL, governanceTenantDirectoryRecord(counter(ORG_A, "rewritten.by.replaced.code"))!);
  const current = [0, 1].map((index) => counter(ORG_B, `current.${index}`));
  for (const record of current) {
    await makeDynamoDatabase(fake.client, DEFAULT_TABLE_NAMES).transactWrite([
      { kind: "put", record },
    ]);
  }
  return { current, fake, live: [...legacy, rewritten] };
}

describe("governance inventory shard re-check", () => {
  test("repairs shard locators replaced code invalidated, leaves legacy locators, then marks itself done", async () => {
    const { current, fake, live } = await deployedState();
    const legacyBefore = locators(fake).filter((item) => isLegacyPartition(item.pk));

    expect(await recheckGovernanceInventoryShards(tables(fake.client))).toEqual({
      checked: 4,
      kind: "rechecked",
      organizations: 2,
    });

    expect(locators(fake).filter((item) => isLegacyPartition(item.pk))).toEqual(legacyBefore);
    expect(
      locators(fake)
        .filter((item) => !isLegacyPartition(item.pk))
        .map((item) => `${String(item.pk)} ${String(item.sk)}`)
        .toSorted(),
    ).toEqual(
      [live[3]!, ...current]
        .map((record) => governanceTenantDirectoryRecord(record)!)
        .map((locator) => `${locator.pk} ${locator.sk}`)
        .toSorted(),
    );
    expect(await listed(fake, ORG_A)).toEqual(
      live.map((record) => `${record.pk} ${record.sk}`).toSorted(),
    );
    expect(await listed(fake, ORG_B)).toEqual(
      current.map((record) => `${record.pk} ${record.sk}`).toSorted(),
    );

    const { client, commands } = recordingClient(fake);
    expect(await recheckGovernanceInventoryShards(tables(client))).toEqual({
      kind: "already-rechecked",
    });
    expect(commands).toEqual(["GetCommand"]);
  });

  test("skips an installation whose earlier in-deploy migration already finished", async () => {
    const { fake } = await deployedState();
    fake.put(
      CONTROL,
      withCanonicalRecordKeys({
        data: { completedAt: AT, id: "governance-inventory-shards" },
        itemType: "deploy-migration" as const,
      }),
    );
    const { client, commands } = recordingClient(fake);

    expect(await recheckGovernanceInventoryShards(tables(client))).toEqual({
      kind: "already-rechecked",
    });
    expect(commands).toEqual(["GetCommand", "GetCommand"]);
  });

  test("reads no legacy locator however many there are", async () => {
    const fake = fakeDynamoDocumentClient();
    fake.put(CONTROL, organization(ORG_A));
    fake.put(CONTROL, organization(ORG_B));
    for (const organizationId of [ORG_A, ORG_B]) {
      for (let index = 0; index < 2_500; index += 1) {
        const record = counter(organizationId, `legacy.${index}`);
        fake.put(USAGE, record);
        fake.put(CONTROL, legacyLocator(record));
      }
    }
    await switchGovernanceInventoryShardWrites(tables(fake.client));
    for (const record of [counter(ORG_A, "after.0"), counter(ORG_B, "after.1")]) {
      await makeDynamoDatabase(fake.client, DEFAULT_TABLE_NAMES).transactWrite([
        { kind: "put", record },
      ]);
    }
    const { client, commands, legacyTouches } = recordingClient(fake);

    expect(await recheckGovernanceInventoryShards(tables(client))).toEqual({
      checked: 2,
      kind: "rechecked",
      organizations: 2,
    });
    expect(legacyTouches).toEqual([]);
    expect(commands.filter((name) => name === "QueryCommand")).toHaveLength(3 + 2 * 16);
    expect(commands).toHaveLength(2 + 3 + 2 * 16 + 2 + 1);
    expect(locators(fake).filter((item) => isLegacyPartition(item.pk))).toHaveLength(5_000);
  });

  test("a run that fails part way leaves no marker and the next run re-checks again", async () => {
    const { fake, live } = await deployedState();
    fake.failNextTransaction(
      (input) =>
        input.TransactItems?.some((item) =>
          String(item.Delete?.Key?.pk ?? item.Put?.Item?.pk).includes("#SHARD#"),
        ) ?? false,
      () =>
        Object.assign(new Error("We encountered an internal error."), {
          name: "InternalServerError",
        }),
    );

    const failed = await recheckGovernanceInventoryShards(tables(fake.client)).then(
      () => "completed",
      (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    );
    expect(failed).toBe("We encountered an internal error.");
    expect(
      fake
        .items(CONTROL)
        .filter((item) => item.itemType === "deploy-migration")
        .map((item) => item.sk),
    ).toEqual(["DEPLOY-MIGRATION#governance-inventory-shard-writes"]);

    expect(await recheckGovernanceInventoryShards(tables(fake.client))).toMatchObject({
      kind: "rechecked",
    });
    expect(
      fake
        .items(CONTROL)
        .filter((item) => item.itemType === "deploy-migration")
        .map((item) => String(item.sk))
        .toSorted(),
    ).toEqual([
      "DEPLOY-MIGRATION#governance-inventory-shard-recheck",
      "DEPLOY-MIGRATION#governance-inventory-shard-writes",
    ]);
    expect(await listed(fake, ORG_A)).toEqual(
      live.map((record) => `${record.pk} ${record.sk}`).toSorted(),
    );
  });

  test("re-checking shard locators that match their records writes no locator", async () => {
    const fake = fakeDynamoDocumentClient();
    fake.put(CONTROL, organization(ORG_B));
    await switchGovernanceInventoryShardWrites(tables(fake.client));
    const records = Array.from({ length: 40 }, (_, index) => counter(ORG_B, `current.${index}`));
    for (const record of records) {
      await makeDynamoDatabase(fake.client, DEFAULT_TABLE_NAMES).transactWrite([
        { kind: "put", record },
      ]);
    }
    const before = fake.transactions.length;

    expect(await recheckGovernanceInventoryShards(tables(fake.client))).toEqual({
      checked: 40,
      kind: "rechecked",
      organizations: 1,
    });
    expect(
      fake.transactions
        .slice(before)
        .filter(({ input }) =>
          input.TransactItems?.some(
            (item) =>
              item.Put?.Item?.itemType === "governance-tenant-record" ||
              String(item.Delete?.Key?.pk).includes("#GOVERNANCE-INVENTORY"),
          ),
        ),
    ).toEqual([]);
  });

  test("a stale shard locator stops failing listings once re-checked", async () => {
    const fake = fakeDynamoDocumentClient();
    fake.put(CONTROL, organization(ORG_B));
    await switchGovernanceInventoryShardWrites(tables(fake.client));
    fake.put(CONTROL, governanceTenantDirectoryRecord(counter(ORG_B, "deleted.by.stale.process"))!);

    expect(await listed(fake, ORG_B).catch((cause: unknown) => String(cause))).toBe(
      "Error: Governance inventory lost a tenant record before its recorded TTL.",
    );
    expect(await recheckGovernanceInventoryShards(tables(fake.client))).toEqual({
      checked: 1,
      kind: "rechecked",
      organizations: 1,
    });
    expect(await listed(fake, ORG_B)).toEqual([]);
  });

  test("turns shard writes on once and keeps the first switch time", async () => {
    const fake = fakeDynamoDocumentClient();
    const record = counter(ORG_B, "written.after.switch");
    fake.put(CONTROL, organization(ORG_B));

    const before = Date.now();
    const switchedAt = await switchGovernanceInventoryShardWrites(tables(fake.client));
    await makeDynamoDatabase(fake.client, DEFAULT_TABLE_NAMES).transactWrite([
      { kind: "put", record },
    ]);

    expect(switchedAt).toBeGreaterThanOrEqual(before);
    expect(await switchGovernanceInventoryShardWrites(tables(fake.client))).toBe(switchedAt);
    expect(
      fake.get(CONTROL, {
        pk: "GLOBAL#deploy-migration",
        sk: "DEPLOY-MIGRATION#governance-inventory-shard-writes",
      })?.data,
    ).toEqual({
      completedAt: new Date(switchedAt).toISOString(),
      id: "governance-inventory-shard-writes",
    });
    expect(locators(fake).map((item) => item.pk)).toEqual([
      governanceTenantDirectoryRecord(record)!.pk,
    ]);
  });
});
