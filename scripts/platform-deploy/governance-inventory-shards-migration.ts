import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  DeployMigrationRecord,
  GOVERNANCE_INVENTORY_SHARD_WRITES_MARKER,
  key,
  listGovernedOrganizationIds,
  makeDynamoDatabase,
  reconcileTenantShardLocators,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type TableNames,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { log } from "./process.ts";

/** Written once a deploy re-checked every shard locator after shard writes turned on. */
export const GOVERNANCE_INVENTORY_SHARD_RECHECK_MARKER = {
  pk: key("GLOBAL", "deploy-migration"),
  sk: key("DEPLOY-MIGRATION", "governance-inventory-shard-recheck"),
};

/** Written once no organization has a legacy inventory locator left. */
export const GOVERNANCE_INVENTORY_SHARDS_MARKER = {
  pk: key("GLOBAL", "deploy-migration"),
  sk: key("DEPLOY-MIGRATION", "governance-inventory-shards"),
};

const decodeMarker = Schema.decodeUnknownSync(DeployMigrationRecord);

export async function writeDeployMigrationMarker(
  database: DynamoDatabaseService,
  id: (typeof DeployMigrationRecord.Type)["data"]["id"],
  completedAt = new Date(),
) {
  await database.putRecord(
    decodeMarker(
      withCanonicalRecordKeys({
        data: { completedAt: completedAt.toISOString(), id },
        itemType: "deploy-migration" as const,
      }),
    ),
  );
}

export type GovernanceInventoryShardRecheck =
  | { readonly kind: "already-rechecked" }
  | {
      readonly kind: "rechecked";
      /** Shard locators re-checked against their records. */
      readonly checked: number;
      readonly organizations: number;
    };

export interface PlatformTables {
  readonly client: DynamoDBDocumentClient;
  readonly tableNames: TableNames;
}

/**
 * Turns shard writes on for governance inventory locators and returns when they were turned on, in
 * epoch milliseconds. Only safe once no replaced code that lists the legacy partition alone runs.
 */
export async function switchGovernanceInventoryShardWrites(tables: PlatformTables) {
  const database = makeDynamoDatabase(tables.client, tables.tableNames);
  const switched = await database.getRecord(
    "control",
    GOVERNANCE_INVENTORY_SHARD_WRITES_MARKER,
    true,
  );
  if (switched) return Date.parse(decodeMarker(switched).data.completedAt);
  const switchedAt = new Date();
  await writeDeployMigrationMarker(database, "governance-inventory-shard-writes", switchedAt);
  log(`governance inventory: shard writes on since ${switchedAt.toISOString()}`);
  return switchedAt.getTime();
}

/**
 * Whether shard locators were re-checked after the switch: by this stage, or by the in-deploy
 * migration of earlier code, which re-checked them before writing its completion marker.
 */
export async function governanceInventoryShardsRechecked(database: DynamoDatabaseService) {
  for (const marker of [
    GOVERNANCE_INVENTORY_SHARD_RECHECK_MARKER,
    GOVERNANCE_INVENTORY_SHARDS_MARKER,
  ]) {
    if (await database.getRecord("control", marker, true)) return true;
  }
  return false;
}

/**
 * Re-checks every organization's shard locators against their records, once. Run after every
 * process has seen the shard-writes switch. A process that still wrote the legacy layout just after
 * the switch can delete or rewrite a record whose locator another process already put on a shard,
 * and every listing of that organization fails closed on the stale shard locator until this runs.
 * Shards then hold only locators written since the switch, so the work is bounded by them. Legacy
 * locators are left for `scripts/governance-inventory-migration.ts`; readers list both partitions.
 */
export async function recheckGovernanceInventoryShards(
  tables: PlatformTables,
): Promise<GovernanceInventoryShardRecheck> {
  const database = makeDynamoDatabase(tables.client, tables.tableNames);
  if (await governanceInventoryShardsRechecked(database)) return { kind: "already-rechecked" };
  const organizationIds = await listGovernedOrganizationIds(tables.client, tables.tableNames);
  let checked = 0;
  for (const organizationId of organizationIds) {
    checked += await reconcileTenantShardLocators(tables, organizationId);
  }
  await writeDeployMigrationMarker(database, "governance-inventory-shard-recheck");
  log(
    `governance inventory: re-checked ${checked} shard locators across ${organizationIds.length} organizations; move legacy locators with scripts/governance-inventory-migration.ts`,
  );
  return { checked, kind: "rechecked", organizations: organizationIds.length };
}
