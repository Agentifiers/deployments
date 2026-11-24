import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { governanceInventoryLayout } from "../governance-inventory-layout.ts";
import { governanceBrainIds } from "../governance-tenant-directory.ts";
import {
  governanceBrainInventoryPartition,
  governanceMultiBrainInventoryPartition,
} from "../record-key-governance.ts";
import type { BrainTenantInventory } from "./contracts.ts";
import {
  decodeCursor,
  decodeRecord,
  encodeCursor,
  type DynamoGovernanceContext,
} from "./dynamo-store.ts";
import {
  resolveTenantInventory,
  type GovernanceTenantDirectoryRecord,
} from "./inventory-resolution.ts";

const BRAIN_INVENTORY_PAGE_SIZE = 100;
const BRAIN_PARTITION = 0;
const MULTI_BRAIN_PARTITION = 1;

/**
 * Lists the canonical records one Brain owns. Every governance locator carries the Brain ids its
 * record names and is projected into the Brain inventory index: locators naming exactly one Brain
 * under that Brain's partition, locators naming several Brains under the organization's
 * multi-Brain partition. The index is eventually consistent, so it only nominates locators; each
 * page is resolved against strongly read locators and canonical records, and a record is returned
 * only if its current data still names the Brain.
 */
export function makeGovernanceBrainInventory(
  context: DynamoGovernanceContext,
): BrainTenantInventory {
  return {
    async listBrainRecords(organizationId, brainId, cursor) {
      const decoded = decodeCursor(cursor);
      if (decoded.tableIndex > MULTI_BRAIN_PARTITION) {
        throw new Error("Invalid governance inventory cursor.");
      }
      const result = await context.client.send(
        new QueryCommand({
          ExclusiveStartKey: decoded.key,
          ExpressionAttributeNames: { "#partition": "gsi2pk" },
          ExpressionAttributeValues: {
            ":partition":
              decoded.tableIndex === BRAIN_PARTITION
                ? governanceBrainInventoryPartition(organizationId, brainId)
                : governanceMultiBrainInventoryPartition(organizationId),
          },
          IndexName: "gsi2",
          KeyConditionExpression: "#partition = :partition",
          Limit: BRAIN_INVENTORY_PAGE_SIZE,
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
          throw new Error("Governance Brain inventory contains an unexpected record.");
        }
        if (record.data.brainIds?.includes(brainId)) directory.push(record);
      }
      const items = (
        await resolveTenantInventory(context, organizationId, directory, layout)
      ).filter((item) => governanceBrainIds(item.record).includes(brainId));
      const next = result.LastEvaluatedKey
        ? { key: result.LastEvaluatedKey, tableIndex: decoded.tableIndex }
        : decoded.tableIndex === BRAIN_PARTITION
          ? { tableIndex: MULTI_BRAIN_PARTITION }
          : undefined;
      return { ...(next ? { cursor: encodeCursor(next) } : {}), items };
    },
  };
}
