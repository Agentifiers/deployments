import { isDeepStrictEqual } from "node:util";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type QueryCommandInput,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  governanceTenantDirectoryKey,
  governanceTenantDirectoryRecord,
  governanceTenantOrganizationId,
} from "../governance-tenant-directory.ts";
import {
  governanceInventoryShardPartitions,
  governanceLegacyInventoryPartition,
} from "../record-key-governance.ts";
import {
  batchWriteRetryDelay,
  decodeRecord,
  makeDynamoGovernanceContext,
  type DynamoGovernanceContext,
} from "./dynamo-store.ts";
import type { GovernanceTenantDirectoryRecord } from "./inventory-resolution.ts";

type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
type StoredItem = Readonly<Record<string, unknown>>;
type InventoryContext = Pick<
  DynamoGovernanceContext,
  "batchWriteRandom" | "batchWriteSleep" | "client" | "tableNames"
>;

interface StoredTenantLocator {
  /** The locator item as listed; without it, the first attempt reads it. */
  readonly item?: StoredItem;
  readonly locator: GovernanceTenantDirectoryRecord;
}

const INVENTORY_PAGE_SIZE = 100;
const MAX_RECONCILE_ATTEMPTS = 8;
const RECONCILE_CONCURRENCY = 25;

function isContention(cause: unknown) {
  return (
    cause instanceof Error &&
    (cause.name === "TransactionCanceledException" ||
      cause.name === "TransactionConflictException" ||
      cause.name === "ProvisionedThroughputExceededException" ||
      cause.name === "ThrottlingException")
  );
}

function whileUnchanged(stored: StoredItem | undefined) {
  if (!stored) {
    return { ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" };
  }
  return {
    ConditionExpression: `#itemType = :itemType AND #data = :data AND ${
      stored.ttl === undefined ? "attribute_not_exists(#ttl)" : "#ttl = :ttl"
    }`,
    ExpressionAttributeNames: { "#data": "data", "#itemType": "itemType", "#ttl": "ttl" },
    ExpressionAttributeValues: {
      ":data": stored.data,
      ":itemType": stored.itemType,
      ...(stored.ttl === undefined ? {} : { ":ttl": stored.ttl }),
    },
  };
}

/**
 * Every writer rewrites a record's locator in the transaction that rewrites the record, so the
 * conditions on the locators read before the record already catch a rewrite that changes the
 * locator. The record only has to still exist with the item type and TTL the locator records.
 */
function whileLocatorFieldsUnchanged(record: StoredItem | undefined) {
  if (!record) {
    return { ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" };
  }
  return {
    ConditionExpression: `#itemType = :itemType AND ${
      record.ttl === undefined ? "attribute_not_exists(#ttl)" : "#ttl = :ttl"
    }`,
    ExpressionAttributeNames: { "#itemType": "itemType", "#ttl": "ttl" },
    ExpressionAttributeValues: {
      ":itemType": record.itemType,
      ...(record.ttl === undefined ? {} : { ":ttl": record.ttl }),
    },
  };
}

async function readItem(
  context: InventoryContext,
  tableName: string,
  itemKey: { readonly pk: string; readonly sk: string },
) {
  const result = await context.client.send(
    new GetCommand({ ConsistentRead: true, Key: itemKey, TableName: tableName }),
  );
  return result.Item as StoredItem | undefined;
}

async function reconcileTenantLocator(
  context: InventoryContext,
  { item, locator }: StoredTenantLocator,
): Promise<GovernanceTenantDirectoryRecord | undefined> {
  const { organizationId, recordPk, recordSk, recordTable } = locator.data;
  const recordKey = { pk: recordPk, sk: recordSk };
  const recordTableName = context.tableNames[recordTable] ?? recordTable;
  const shardKey = governanceTenantDirectoryKey(organizationId, recordTable, recordPk, recordSk);
  const itemKey = { pk: locator.pk, sk: locator.sk };
  const legacy = itemKey.pk !== shardKey.pk;
  for (let attempt = 1; ; attempt += 1) {
    const listed =
      attempt === 1 && item ? item : await readItem(context, context.tableNames.control, itemKey);
    const shard = legacy ? await readItem(context, context.tableNames.control, shardKey) : listed;
    const record = await readItem(context, recordTableName, recordKey);
    const decoded = record ? await decodeRecord(record) : undefined;
    const owner = decoded ? governanceTenantOrganizationId(decoded) : undefined;
    const desired =
      decoded && (owner === undefined || owner === organizationId)
        ? governanceTenantDirectoryRecord(decoded, organizationId)
        : undefined;
    const writes: TransactItem[] = [];
    if (desired && !(shard && isDeepStrictEqual(await decodeRecord(shard), desired))) {
      writes.push({
        Put: { Item: desired, TableName: context.tableNames.control, ...whileUnchanged(shard) },
      });
    }
    if (!desired && shard) {
      writes.push({
        Delete: { Key: shardKey, TableName: context.tableNames.control, ...whileUnchanged(shard) },
      });
    }
    if (legacy && listed) {
      writes.push({
        Delete: { Key: itemKey, TableName: context.tableNames.control, ...whileUnchanged(listed) },
      });
    }
    if (writes.length === 0) return desired;
    try {
      await context.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                Key: recordKey,
                TableName: recordTableName,
                ...whileLocatorFieldsUnchanged(record),
              },
            },
            ...writes,
          ],
        }),
      );
      return desired;
    } catch (cause) {
      if (!isContention(cause) || attempt >= MAX_RECONCILE_ATTEMPTS) throw cause;
      await context.batchWriteSleep(batchWriteRetryDelay(attempt, context.batchWriteRandom));
    }
  }
}

/**
 * Re-checks each locator against its record: writes the shard locator the record defines now,
 * deletes it with its record gone, and deletes a legacy locator once its shard locator is written.
 * Returns the shard locators that now stand. Each locator moves in one transaction that checks both
 * locators are unchanged and the record still exists with the item type and TTL it was read with.
 */
export async function reconcileTenantLocators(
  context: InventoryContext,
  entries: readonly StoredTenantLocator[],
) {
  const current: GovernanceTenantDirectoryRecord[] = [];
  for (let offset = 0; offset < entries.length; offset += RECONCILE_CONCURRENCY) {
    const settled = await Promise.all(
      entries
        .slice(offset, offset + RECONCILE_CONCURRENCY)
        .map((entry) => reconcileTenantLocator(context, entry)),
    );
    for (const locator of settled) if (locator) current.push(locator);
  }
  return current;
}

async function* inventoryPages(
  context: InventoryContext,
  partition: string,
  read: Pick<QueryCommandInput, "ConsistentRead" | "Limit"> = {
    ConsistentRead: true,
    Limit: INVENTORY_PAGE_SIZE,
  },
) {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await context.client.send(
      new QueryCommand({
        ...read,
        ExclusiveStartKey: exclusiveStartKey,
        ExpressionAttributeNames: { "#inventory": "pk" },
        ExpressionAttributeValues: { ":inventory": partition },
        KeyConditionExpression: "#inventory = :inventory",
        TableName: context.tableNames.control,
      }),
    );
    if (result.Items?.length) yield result.Items as readonly StoredItem[];
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
}

async function tenantLocators(items: readonly StoredItem[]) {
  const entries: StoredTenantLocator[] = [];
  for (const item of items) {
    const locator = await decodeRecord(item);
    if (locator.itemType !== "governance-tenant-record") {
      throw new Error("Governance inventory partition contains an unexpected record.");
    }
    entries.push({ item, locator });
  }
  return entries;
}

type InventoryTables = Pick<InventoryContext, "client" | "tableNames">;

/**
 * Re-checks every shard locator of one organization against its record and returns how many it
 * checked. A process still writing the legacy layout just after the switch can leave a shard locator
 * its record no longer matches (it deleted or rewrote the record through the legacy key), and every
 * listing of the organization fails closed on it until this runs. Safe to repeat and to run beside
 * live writers.
 */
export async function reconcileTenantShardLocators(
  tables: InventoryTables,
  organizationId: string,
): Promise<number> {
  const context = makeDynamoGovernanceContext(tables.client, tables.tableNames);
  let checked = 0;
  for (const partition of governanceInventoryShardPartitions(organizationId)) {
    for await (const items of inventoryPages(context, partition)) {
      await reconcileTenantLocators(context, await tenantLocators(items));
      checked += items.length;
    }
  }
  return checked;
}

/** Estimated on-demand request units of moving legacy locators to their shards. */
export interface LegacyLocatorMoveCost {
  readonly locators: number;
  readonly readUnits: number;
  readonly writeUnits: number;
}

/**
 * Estimates the request units of moving `items` off the legacy partition. Each move strongly reads
 * the shard locator and the record, then writes one transaction: a condition check on the record, a
 * put of the shard locator, and a delete of the legacy locator, 2 write units per KB each. Every
 * index the locator is projected into takes a delete and a put, 1 write unit per KB each. Records
 * are assumed to fit 1 KB for the condition check and 4 KB for the read; larger records cost more.
 */
export function legacyLocatorMoveCost(items: readonly StoredItem[]): LegacyLocatorMoveCost {
  let readUnits = 0;
  let writeUnits = 0;
  for (const item of items) {
    const bytes = Buffer.byteLength(JSON.stringify(item));
    const kilobytes = Math.ceil(bytes / 1_024);
    const indexes = Object.keys(item).filter((name) => /^gsi\d+pk$/.test(name)).length;
    readUnits += 2 + bytes / 4_096;
    writeUnits += 2 + 4 * kilobytes + 2 * kilobytes * indexes;
  }
  return { locators: items.length, readUnits: Math.ceil(readUnits), writeUnits };
}

/** Counts one organization's legacy locators with eventually consistent reads and prices their move. */
export async function estimateTenantLegacyLocatorMoves(
  tables: InventoryTables,
  organizationId: string,
): Promise<LegacyLocatorMoveCost> {
  const context = makeDynamoGovernanceContext(tables.client, tables.tableNames);
  let estimate: LegacyLocatorMoveCost = { locators: 0, readUnits: 0, writeUnits: 0 };
  for await (const items of inventoryPages(
    context,
    governanceLegacyInventoryPartition(organizationId),
    { ConsistentRead: false },
  )) {
    const page = legacyLocatorMoveCost(items);
    estimate = {
      locators: estimate.locators + page.locators,
      readUnits: estimate.readUnits + page.readUnits,
      writeUnits: estimate.writeUnits + page.writeUnits,
    };
  }
  return estimate;
}

/**
 * Moves every locator still on one organization's legacy partition to its shard, or deletes it with
 * its record gone, one page at a time, and yields each moved page's estimated cost. A moved locator
 * leaves the partition, so a rerun reads only the locators not moved yet. Run only once shard
 * writes are on and every process has seen them. Safe to repeat and to run beside live writers.
 */
export async function* moveTenantLegacyLocators(
  tables: InventoryTables,
  organizationId: string,
): AsyncGenerator<LegacyLocatorMoveCost> {
  const context = makeDynamoGovernanceContext(tables.client, tables.tableNames);
  for await (const items of inventoryPages(
    context,
    governanceLegacyInventoryPartition(organizationId),
  )) {
    await reconcileTenantLocators(context, await tenantLocators(items));
    yield legacyLocatorMoveCost(items);
  }
}
