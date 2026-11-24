import { BatchGetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { isDeepStrictEqual } from "node:util";
import type { GovernanceInventoryLayout } from "../governance-inventory-layout.ts";
import { governanceTenantOrganizationId } from "../governance-tenant-directory.ts";
import { recordTtlPassed } from "../retention-ttl.ts";
import { governanceLegacyInventoryPartition } from "../record-key-governance.ts";
import { tableForItemType, type PlatformRecord } from "../records/index.ts";
import type { TenantRecord, TenantRecordSelection } from "./contracts.ts";
import {
  batchWriteRetryDelay,
  decodeRecord,
  type DynamoGovernanceContext,
} from "./dynamo-store.ts";
import { reconcileTenantLocators } from "./inventory-shards.ts";

const MAX_BATCH_GET_ATTEMPTS = 8;
const MAX_BATCH_GET_KEYS = 100;
const MAX_EXPIRED_LOCATORS_PER_TRANSACTION = 50;

export type GovernanceDirectoryRecord = Extract<
  PlatformRecord,
  { readonly itemType: "governance-legacy-record" | "governance-tenant-record" }
>;
export type GovernanceTenantDirectoryRecord = Extract<
  PlatformRecord,
  { readonly itemType: "governance-tenant-record" }
>;

type BatchGetRequests = Record<
  string,
  { ConsistentRead: boolean; Keys: { pk: string; sk: string }[] }
>;

export async function batchGetAll(
  context: Pick<DynamoGovernanceContext, "batchWriteRandom" | "batchWriteSleep" | "client">,
  requestItems: BatchGetRequests,
) {
  const items: Record<string, unknown>[] = [];
  let pending = Object.fromEntries(
    Object.entries(requestItems).filter(([, request]) => request.Keys.length > 0),
  ) as BatchGetRequests;
  for (let attempt = 0; Object.keys(pending).length > 0; attempt += 1) {
    if (attempt >= MAX_BATCH_GET_ATTEMPTS) {
      throw new Error(
        "Governance inventory batch reads remained throttled past their retry budget.",
      );
    }
    const result = await context.client.send(new BatchGetCommand({ RequestItems: pending }));
    for (const response of Object.values(result.Responses ?? {})) items.push(...response);
    pending = (result.UnprocessedKeys ?? {}) as BatchGetRequests;
    if (Object.keys(pending).length > 0 && attempt < MAX_BATCH_GET_ATTEMPTS - 1) {
      await context.batchWriteSleep(batchWriteRetryDelay(attempt + 1, context.batchWriteRandom));
    }
  }
  return items;
}

export async function pruneExpiredLocators(
  context: Pick<DynamoGovernanceContext, "client" | "tableNames">,
  entries: readonly GovernanceDirectoryRecord[],
) {
  for (let offset = 0; offset < entries.length; offset += MAX_EXPIRED_LOCATORS_PER_TRANSACTION) {
    const page = entries.slice(offset, offset + MAX_EXPIRED_LOCATORS_PER_TRANSACTION);
    await context.client.send(
      new TransactWriteCommand({
        TransactItems: page.flatMap((entry) => [
          {
            ConditionCheck: {
              ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              Key: { pk: entry.data.recordPk, sk: entry.data.recordSk },
              TableName: context.tableNames[entry.data.recordTable] ?? entry.data.recordTable,
            },
          },
          {
            Delete: {
              ConditionExpression: "#itemType = :itemType AND #data = :data",
              ExpressionAttributeNames: { "#data": "data", "#itemType": "itemType" },
              ExpressionAttributeValues: {
                ":data": entry.data,
                ":itemType": entry.itemType,
              },
              Key: { pk: entry.pk, sk: entry.sk },
              TableName: context.tableNames.control,
            },
          },
        ]),
      }),
    );
  }
}

function recordKey(table: string, pk: string, sk: string) {
  return `${table}\0${pk}\0${sk}`;
}

function entryRecordKey(entry: GovernanceTenantDirectoryRecord) {
  return recordKey(entry.data.recordTable, entry.data.recordPk, entry.data.recordSk);
}

async function readCanonicalRecords(
  context: DynamoGovernanceContext,
  entries: readonly GovernanceTenantDirectoryRecord[],
  consistentRead = true,
) {
  const byKey = new Map<string, TenantRecord>();
  for (let offset = 0; offset < entries.length; offset += MAX_BATCH_GET_KEYS) {
    const requests: BatchGetRequests = {};
    for (const entry of entries.slice(offset, offset + MAX_BATCH_GET_KEYS)) {
      const tableName = context.tableNames[entry.data.recordTable] ?? entry.data.recordTable;
      const request = (requests[tableName] ??= { ConsistentRead: consistentRead, Keys: [] });
      request.Keys.push({ pk: entry.data.recordPk, sk: entry.data.recordSk });
    }
    for (const item of await batchGetAll(context, requests)) {
      const record = await decodeRecord(item);
      const table = tableForItemType(record.itemType);
      byKey.set(recordKey(table, record.pk, record.sk), { record, table });
    }
  }
  return byKey;
}

/** Strongly reads the current locators at the given locator keys. */
async function readTenantLocators(
  context: DynamoGovernanceContext,
  keys: readonly { readonly pk: string; readonly sk: string }[],
) {
  const byKey = new Map<string, GovernanceTenantDirectoryRecord>();
  for (let offset = 0; offset < keys.length; offset += MAX_BATCH_GET_KEYS) {
    const items = await batchGetAll(context, {
      [context.tableNames.control]: {
        ConsistentRead: true,
        Keys: keys.slice(offset, offset + MAX_BATCH_GET_KEYS).map(({ pk, sk }) => ({ pk, sk })),
      },
    });
    for (const item of items) {
      const record = await decodeRecord(item);
      if (record.itemType !== "governance-tenant-record") {
        throw new Error("Governance inventory partition contains an unexpected record.");
      }
      byKey.set(`${record.pk}\0${record.sk}`, record);
    }
  }
  return byKey;
}

function resolves(
  entry: GovernanceTenantDirectoryRecord,
  item: TenantRecord | undefined,
  organizationId: string,
) {
  return (
    item !== undefined &&
    item.record.itemType === entry.data.recordItemType &&
    governanceTenantOrganizationId(item.record) === organizationId &&
    item.record.ttl === entry.data.recordTtl
  );
}

/**
 * Resolves locators to their canonical tenant records. A locator and its record change in one
 * transaction, but the locator page and the record batch are separate reads, so an unresolved
 * entry is re-read before failing closed: a locator that disappeared or changed was deleted or
 * rewritten together with its record after the page was read. Missing records whose recorded
 * DynamoDB TTL has elapsed have their locators pruned. An eventually consistent record read may
 * miss or predate the strongly read locator, so entries it leaves unresolved are strongly
 * re-read before that check; a resolving eventual copy may still be stale.
 *
 * A locator whose own `ttl` has passed is absent with its record (only retention TTL item types'
 * locators carry one): DynamoDB TTL removes both days later at no cost, so neither is read.
 *
 * Once the layout is `sharded`, writers keep only shard locators, so a legacy locator goes stale
 * when its record is deleted or rewritten. Such a locator is moved to its shard, or deleted with
 * its record gone, and the shard locator it leaves is resolved instead. Legacy locators that still
 * resolve stay where they are, and the same record may also be listed through its shard locator.
 */
export async function resolveTenantInventory(
  context: DynamoGovernanceContext,
  organizationId: string,
  listedDirectory: readonly GovernanceTenantDirectoryRecord[],
  layout: GovernanceInventoryLayout,
  consistentRead = true,
): Promise<readonly TenantRecord[]> {
  const now = context.now();
  const directory = listedDirectory.filter((entry) => !recordTtlPassed(entry, now));
  const records = await readCanonicalRecords(context, directory, consistentRead);
  if (!consistentRead) {
    const unresolvedEventually = directory.filter(
      (entry) => !resolves(entry, records.get(entryRecordKey(entry)), organizationId),
    );
    for (const entry of unresolvedEventually) records.delete(entryRecordKey(entry));
    for (const [key, item] of await readCanonicalRecords(context, unresolvedEventually)) {
      records.set(key, item);
    }
  }
  const unresolved = directory.filter(
    (entry) => !resolves(entry, records.get(entryRecordKey(entry)), organizationId),
  );
  const latest = unresolved.length > 0 ? await readTenantLocators(context, unresolved) : new Map();
  const rewritten = unresolved.flatMap((entry) => {
    const current = latest.get(`${entry.pk}\0${entry.sk}`);
    return current && !isDeepStrictEqual(current, entry) ? [current] : [];
  });
  const reread = rewritten.length > 0 ? await readCanonicalRecords(context, rewritten) : new Map();
  const currentEpochSeconds = Math.floor(now.getTime() / 1_000);
  const expiredLocators: GovernanceDirectoryRecord[] = [];
  const staleLegacyLocators: GovernanceTenantDirectoryRecord[] = [];
  const items = directory.flatMap((listed) => {
    const listedItem = records.get(entryRecordKey(listed));
    if (resolves(listed, listedItem, organizationId)) return [listedItem!];
    const entry = latest.get(`${listed.pk}\0${listed.sk}`);
    if (!entry || recordTtlPassed(entry, now)) return [];
    const item = isDeepStrictEqual(entry, listed)
      ? listedItem
      : (reread.get(entryRecordKey(entry)) as TenantRecord | undefined);
    if (resolves(entry, item, organizationId)) return [item!];
    if (
      !item &&
      entry.data.recordTtl !== undefined &&
      entry.data.recordTtl <= currentEpochSeconds
    ) {
      expiredLocators.push(entry);
      return [];
    }
    if (layout === "sharded" && entry.pk === governanceLegacyInventoryPartition(organizationId)) {
      staleLegacyLocators.push(entry);
      return [];
    }
    if (!item && entry.data.recordTtl !== undefined) {
      throw new Error("Governance inventory lost a tenant record before its recorded TTL.");
    }
    throw new Error("Governance inventory does not resolve to its canonical tenant record.");
  });
  await pruneExpiredLocators(context, expiredLocators);
  if (staleLegacyLocators.length === 0) return items;
  const moved = await reconcileTenantLocators(
    context,
    staleLegacyLocators.map((locator) => ({ locator })),
  );
  return [...items, ...(await resolveTenantInventory(context, organizationId, moved, layout))];
}

/** Resolves only the locators `selection` picks, each with the consistency it asks for. */
export async function resolveSelectedTenantInventory(
  context: DynamoGovernanceContext,
  organizationId: string,
  directory: readonly GovernanceTenantDirectoryRecord[],
  layout: GovernanceInventoryLayout,
  selection: TenantRecordSelection,
): Promise<readonly TenantRecord[]> {
  const consistent: GovernanceTenantDirectoryRecord[] = [];
  const eventual: GovernanceTenantDirectoryRecord[] = [];
  for (const entry of directory) {
    const read = selection.select(entry.data);
    if (read === "consistent") consistent.push(entry);
    if (read === "eventual") eventual.push(entry);
  }
  return [
    ...(await resolveTenantInventory(context, organizationId, consistent, layout)),
    ...(await resolveTenantInventory(context, organizationId, eventual, layout, false)),
  ];
}
