import { type DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { key } from "./keys.ts";

/**
 * Where writers put governance inventory locators. Code released before the shards lists only an
 * organization's legacy partition, so locators stay `legacy` until a deploy writes the shard-writes
 * marker after replaced code has ended. From then on they are `sharded`; the marker is never
 * removed. Readers list both partitions whatever the layout.
 */
export type GovernanceInventoryLayout = "legacy" | "sharded";

export const GOVERNANCE_INVENTORY_SHARD_WRITES_MARKER = {
  pk: key("GLOBAL", "deploy-migration"),
  sk: key("DEPLOY-MIGRATION", "governance-inventory-shard-writes"),
} as const;

/** How long a process keeps a `legacy` read before it reads the marker again. */
export const GOVERNANCE_INVENTORY_LEGACY_LAYOUT_CACHE_MILLISECONDS = 30_000;

/**
 * Time after the marker is written by which no process sends a legacy locator write any more: one
 * cached `legacy` read plus the conflict retries of a transaction built from it.
 */
export const GOVERNANCE_INVENTORY_LEGACY_WRITES_END_MILLISECONDS = 60_000;

interface CachedLayout {
  readonly layout: GovernanceInventoryLayout;
  readonly readAt: number;
}

const cachedLayouts = new WeakMap<DynamoDBDocumentClient, Map<string, CachedLayout>>();

export async function governanceInventoryLayout(
  client: DynamoDBDocumentClient,
  controlTable: string,
  now = Date.now(),
): Promise<GovernanceInventoryLayout> {
  let byTable = cachedLayouts.get(client);
  if (!byTable) {
    byTable = new Map();
    cachedLayouts.set(client, byTable);
  }
  const cached = byTable.get(controlTable);
  if (
    cached &&
    (cached.layout === "sharded" ||
      now - cached.readAt < GOVERNANCE_INVENTORY_LEGACY_LAYOUT_CACHE_MILLISECONDS)
  ) {
    return cached.layout;
  }
  const result = await client.send(
    new GetCommand({
      ConsistentRead: true,
      Key: GOVERNANCE_INVENTORY_SHARD_WRITES_MARKER,
      TableName: controlTable,
    }),
  );
  const layout = result.Item ? "sharded" : "legacy";
  byTable.set(controlTable, { layout, readAt: now });
  return layout;
}
