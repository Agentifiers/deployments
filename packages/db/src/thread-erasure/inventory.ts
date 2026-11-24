import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { governanceInventoryLayout } from "../governance-inventory-layout.ts";
import type { TenantRecordPage } from "../governance/contracts.ts";
import {
  decodeCursor,
  decodeRecord,
  encodeCursor,
  type DynamoGovernanceContext,
} from "../governance/dynamo-store.ts";
import {
  resolveTenantInventory,
  type GovernanceTenantDirectoryRecord,
} from "../governance/inventory-resolution.ts";
import { governanceThreadIds } from "./ownership.ts";
import {
  governanceMultiThreadInventoryPartition,
  governanceThreadInventoryPartition,
} from "./record-keys.ts";

const THREAD_INVENTORY_PAGE_SIZE = 100;
const THREAD_PARTITION = 0;
const MULTI_THREAD_PARTITION = 1;

/**
 * The index is eventually consistent, so it only nominates locators; a record is returned only
 * if its strongly read current data still names the thread.
 */
export async function listThreadInventoryPage(
  context: DynamoGovernanceContext,
  organizationId: string,
  threadId: string,
  cursor?: string,
): Promise<TenantRecordPage> {
  const decoded = decodeCursor(cursor);
  if (decoded.tableIndex > MULTI_THREAD_PARTITION) {
    throw new Error("Invalid thread inventory cursor.");
  }
  const result = await context.client.send(
    new QueryCommand({
      ExclusiveStartKey: decoded.key,
      ExpressionAttributeNames: { "#partition": "gsi1pk" },
      ExpressionAttributeValues: {
        ":partition":
          decoded.tableIndex === THREAD_PARTITION
            ? governanceThreadInventoryPartition(organizationId, threadId)
            : governanceMultiThreadInventoryPartition(organizationId),
      },
      IndexName: "gsi1",
      KeyConditionExpression: "#partition = :partition",
      Limit: THREAD_INVENTORY_PAGE_SIZE,
      TableName: context.tableNames.control,
    }),
  );
  const layout = await governanceInventoryLayout(context.client, context.tableNames.control);
  const directory: GovernanceTenantDirectoryRecord[] = [];
  for (const item of result.Items ?? []) {
    const record = await decodeRecord(item);
    if (
      record.itemType !== "governance-tenant-record" ||
      record.data.organizationId !== organizationId
    ) {
      throw new Error("Governance thread inventory contains an unexpected record.");
    }
    if (record.data.threadIds?.some((id) => id === threadId)) directory.push(record);
  }
  const items = (await resolveTenantInventory(context, organizationId, directory, layout)).filter(
    (item) => governanceThreadIds(item.record).includes(threadId),
  );
  const next = result.LastEvaluatedKey
    ? { key: result.LastEvaluatedKey, tableIndex: decoded.tableIndex }
    : decoded.tableIndex === THREAD_PARTITION
      ? { tableIndex: MULTI_THREAD_PARTITION }
      : undefined;
  return { ...(next ? { cursor: encodeCursor(next) } : {}), items };
}
