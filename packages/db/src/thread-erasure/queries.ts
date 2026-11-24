import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { MAX_THREADLESS_STABLE_TENANT_MUTATIONS_PER_TRANSACTION } from "../governance-tenant-directory.ts";
import { withCanonicalRecordKeys, type PlatformRecord, type TableName } from "../records/index.ts";

export type RecordOf<ItemType extends PlatformRecord["itemType"]> = Extract<
  PlatformRecord,
  { readonly itemType: ItemType }
>;

export async function queryPartition(
  database: DynamoDatabaseService,
  table: TableName,
  pk: string,
  skPrefix: string,
): Promise<readonly PlatformRecord[]> {
  const records: PlatformRecord[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await database.queryRecords(table, {
      ConsistentRead: true,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: { ":pk": pk, ":prefix": skPrefix },
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
    });
    records.push(...page.items);
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);
  return records;
}

export function only<ItemType extends PlatformRecord["itemType"]>(
  records: readonly PlatformRecord[],
  itemType: ItemType,
): readonly RecordOf<ItemType>[] {
  return records.filter((record): record is RecordOf<ItemType> => record.itemType === itemType);
}

export async function readByIdentity<ItemType extends PlatformRecord["itemType"]>(
  database: DynamoDatabaseService,
  table: TableName,
  itemType: ItemType,
  data: Readonly<Record<string, unknown>>,
): Promise<RecordOf<ItemType> | undefined> {
  const { pk, sk } = withCanonicalRecordKeys({ data, itemType } as never);
  const record = await database.getRecord(table, { pk, sk });
  return record?.itemType === itemType ? (record as RecordOf<ItemType>) : undefined;
}

export async function commitInBatches(
  database: DynamoDatabaseService,
  operations: readonly TransactionOperation[],
) {
  for (
    let offset = 0;
    offset < operations.length;
    offset += MAX_THREADLESS_STABLE_TENANT_MUTATIONS_PER_TRANSACTION
  ) {
    await database.transactWrite(
      operations.slice(offset, offset + MAX_THREADLESS_STABLE_TENANT_MUTATIONS_PER_TRANSACTION),
    );
  }
}
