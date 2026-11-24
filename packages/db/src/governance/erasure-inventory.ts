import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { runLocatorRecord } from "../dynamo-database.ts";
import { governanceTenantOrganizationId } from "../governance-tenant-directory.ts";
import { key } from "../keys.ts";
import {
  governanceInventoryShardPartitions,
  governanceLegacyInventoryPartition,
} from "../record-key-governance.ts";
import { tableForItemType, type PlatformRecord, type TableName } from "../records/index.ts";
import { makeUniqueClaimRecord, uniqueClaimRequirements } from "../unique-claims.ts";
import type {
  ErasableTenantRecord,
  GovernanceStore,
  TenantInventoryLocatorKey,
  TenantRecord,
} from "./contracts.ts";
import {
  decodeCursor,
  decodeRecord,
  encodeCursor,
  type DynamoGovernanceContext,
} from "./dynamo-store.ts";
import { batchGetAll } from "./inventory-resolution.ts";

const DEFAULT_ERASURE_PAGE_SIZE = 500;
const MAX_BATCH_GET_KEYS = 100;

interface RecordKey {
  readonly pk: string;
  readonly sk: string;
  readonly table: TableName;
}

function recordKeyId({ pk, sk, table }: RecordKey) {
  return `${table}\0${pk}\0${sk}`;
}

/** Strongly reads records by key; the result is keyed by the table each key was read from. */
async function readRecords(context: DynamoGovernanceContext, keys: readonly RecordKey[]) {
  const records = new Map<string, TenantRecord>();
  for (let offset = 0; offset < keys.length; offset += MAX_BATCH_GET_KEYS) {
    const chunk = keys.slice(offset, offset + MAX_BATCH_GET_KEYS);
    const tables = new Map<string, TableName>();
    const requests: Record<
      string,
      { ConsistentRead: boolean; Keys: { pk: string; sk: string }[] }
    > = {};
    for (const { pk, sk, table } of chunk) {
      const tableName = context.tableNames[table] ?? table;
      tables.set(tableName, table);
      (requests[tableName] ??= { ConsistentRead: true, Keys: [] }).Keys.push({ pk, sk });
    }
    const responses = await Promise.all(
      Object.entries(requests).map(async ([tableName, request]) => ({
        items: await batchGetAll(context, { [tableName]: request }),
        table: tables.get(tableName)!,
      })),
    );
    for (const { items, table } of responses) {
      for (const item of items) {
        const record = await decodeRecord(item);
        if (tableForItemType(record.itemType) !== table) {
          throw new Error("Governance inventory names a record stored in another table.");
        }
        records.set(recordKeyId({ pk: record.pk, sk: record.sk, table }), { record, table });
      }
    }
  }
  return records;
}

/** Keys of the records an owner's own transaction deletes with it. */
function dependentKeys(record: PlatformRecord): readonly RecordKey[] {
  const claims = uniqueClaimRequirements(record).map((requirement) => {
    const claim = makeUniqueClaimRecord(requirement, new Date(0).toISOString());
    return { pk: claim.pk, sk: claim.sk, table: "control" as const };
  });
  const runLocator = runLocatorRecord(record);
  return runLocator
    ? [...claims, { pk: runLocator.pk, sk: runLocator.sk, table: "control" as const }]
    : claims;
}

function ownedBy(dependent: PlatformRecord, owner: PlatformRecord) {
  if (dependent.itemType === "unique-claim") {
    return dependent.data.ownerPk === owner.pk && dependent.data.ownerSk === owner.sk;
  }
  return dependent.itemType === "run-locator" && dependent.data.runPk === owner.pk;
}

export function makeGovernanceErasureInventory(context: DynamoGovernanceContext) {
  const { client, now, options, tableNames } = context;
  const pageSize = options.tenantErasurePageSize ?? DEFAULT_ERASURE_PAGE_SIZE;
  return {
    async listTenantErasurePage(organizationId, { cursor, through }) {
      const partitions = [
        governanceLegacyInventoryPartition(organizationId),
        ...governanceInventoryShardPartitions(organizationId),
      ];
      const decoded = decodeCursor(cursor);
      const partition = partitions[decoded.tableIndex];
      if (partition === undefined) throw new Error("Invalid governance inventory cursor.");
      if (!cursor && !through && options.requireTenantInventoryReady) {
        const state = await client.send(
          new GetCommand({
            ConsistentRead: true,
            Key: { pk: key("GLOBAL", "GOVERNANCE-INVENTORY"), sk: key("STATE", "v1") },
            TableName: tableNames.control,
          }),
        );
        const record = state.Item ? await decodeRecord(state.Item) : undefined;
        if (record?.itemType !== "governance-inventory-state") {
          throw new Error(
            "Governance tenant inventory is unavailable until its authoritative directory backfill completes.",
          );
        }
      }
      const bound = through
        ? through.cursor
          ? decodeCursor(through.cursor)
          : { tableIndex: partitions.length }
        : undefined;
      const boundSk =
        bound?.tableIndex === decoded.tableIndex && typeof bound.key?.sk === "string"
          ? bound.key.sk
          : undefined;
      if (bound && bound.tableIndex < decoded.tableIndex) {
        throw new Error("Governance erasure listing bound precedes its cursor.");
      }
      const result = await client.send(
        new QueryCommand({
          ConsistentRead: true,
          ExclusiveStartKey: decoded.key,
          ExpressionAttributeNames: { "#pk": "pk", ...(boundSk ? { "#sk": "sk" } : {}) },
          ExpressionAttributeValues: {
            ":pk": partition,
            ...(boundSk ? { ":through": boundSk } : {}),
          },
          KeyConditionExpression: boundSk ? "#pk = :pk AND #sk <= :through" : "#pk = :pk",
          Limit: pageSize,
          TableName: tableNames.control,
        }),
      );
      const epochSeconds = Math.floor(now().getTime() / 1_000);
      const staleLocators: TenantInventoryLocatorKey[] = [];
      const live: Extract<PlatformRecord, { readonly itemType: "governance-tenant-record" }>[] = [];
      for (const item of result.Items ?? []) {
        const locator = await decodeRecord(item);
        if (locator.itemType !== "governance-tenant-record") {
          throw new Error("Governance inventory partition contains an unexpected record.");
        }
        // The retention-TTL types carry their record's TTL on the locator too, so DynamoDB
        // removes both for free. Any other expired record still has side effects to undo.
        if (locator.ttl !== undefined && locator.ttl <= epochSeconds) continue;
        live.push(locator);
      }
      const listed = await readRecords(
        context,
        live.map(({ data }) => ({ pk: data.recordPk, sk: data.recordSk, table: data.recordTable })),
      );
      const found: ErasableTenantRecord[] = [];
      for (const locator of live) {
        const item = listed.get(
          recordKeyId({
            pk: locator.data.recordPk,
            sk: locator.data.recordSk,
            table: locator.data.recordTable,
          }),
        );
        if (!item) {
          staleLocators.push({ pk: locator.pk, sk: locator.sk });
          continue;
        }
        if (governanceTenantOrganizationId(item.record) !== organizationId) {
          // A claim value another organization took after this one released it keeps its key,
          // so this organization's locator outlives the claim it was written for.
          if (item.record.itemType !== "unique-claim") {
            throw new Error("Governance inventory names another organization's record.");
          }
          staleLocators.push({ pk: locator.pk, sk: locator.sk });
          continue;
        }
        found.push({ ...item, locators: [{ pk: locator.pk, sk: locator.sk }] });
      }
      const dependents = await readRecords(
        context,
        found.flatMap(({ record }) => dependentKeys(record)),
      );
      const records = found.map((item) => ({
        ...item,
        dependents: dependentKeys(item.record).flatMap((dependentKey) => {
          const dependent = dependents.get(recordKeyId(dependentKey));
          return dependent && ownedBy(dependent.record, item.record) ? [dependent] : [];
        }),
      }));
      const next = result.LastEvaluatedKey
        ? { key: result.LastEvaluatedKey, tableIndex: decoded.tableIndex }
        : !bound && decoded.tableIndex + 1 < partitions.length
          ? { tableIndex: decoded.tableIndex + 1 }
          : undefined;
      return { ...(next ? { cursor: encodeCursor(next) } : {}), records, staleLocators };
    },
    async listTenantGovernanceRecords(organizationId) {
      const kinds = [
        { prefix: "GOVERNANCE-OPERATION#", table: "control" as const },
        { prefix: "IMMUTABLE-AUDIT-EXPORT#", table: "events" as const },
      ];
      const records: TenantRecord[] = [];
      for (const { prefix, table } of kinds) {
        let exclusiveStartKey: Record<string, unknown> | undefined;
        do {
          const result = await client.send(
            new QueryCommand({
              ConsistentRead: true,
              ExclusiveStartKey: exclusiveStartKey,
              ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
              ExpressionAttributeValues: { ":pk": key("ORG", organizationId), ":prefix": prefix },
              KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
              TableName: tableNames[table],
            }),
          );
          for (const item of result.Items ?? []) {
            records.push({ record: await decodeRecord(item), table });
          }
          exclusiveStartKey = result.LastEvaluatedKey;
        } while (exclusiveStartKey);
      }
      return records;
    },
  } satisfies Pick<GovernanceStore, "listTenantErasurePage" | "listTenantGovernanceRecords">;
}
