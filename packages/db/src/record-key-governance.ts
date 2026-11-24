import { createHash } from "node:crypto";
import { key } from "./keys.ts";
import { field, stableShard, type KeyableRecord } from "./record-key-fields.ts";
import type { LogicalTableName } from "./record-keys.ts";
import { governanceThreadInventoryKeys } from "./thread-erasure/record-keys.ts";

export const GOVERNANCE_DISPATCH_SHARD_COUNT = 16;

/**
 * Partitions of one organization's governance inventory. One memory search writes a locator for
 * every record it stores, so a single partition caps an organization at DynamoDB's 1,000 write
 * units per partition per second; locators hash over this many partitions instead.
 */
export const GOVERNANCE_INVENTORY_SHARD_COUNT = 16;

export function governanceLegacyInventoryPartition(organizationId: string) {
  return key("ORG", organizationId, "GOVERNANCE-INVENTORY");
}

export function governanceInventoryPartition(
  organizationId: string,
  recordTable: string,
  recordPk: string,
  recordSk: string,
) {
  const shard = stableShard([recordTable, recordPk, recordSk], GOVERNANCE_INVENTORY_SHARD_COUNT);
  return key("ORG", organizationId, "GOVERNANCE-INVENTORY", "SHARD", shard);
}

export function governanceInventoryShardPartitions(organizationId: string) {
  return Array.from({ length: GOVERNANCE_INVENTORY_SHARD_COUNT }, (_, shard) =>
    key("ORG", organizationId, "GOVERNANCE-INVENTORY", "SHARD", String(shard).padStart(2, "0")),
  );
}

function governedOrganizationDiscoveryKeys(record: KeyableRecord) {
  const organizationId = field(record.data, "organizationId");
  if (
    !organizationId ||
    (record.itemType !== "retention-cleanup" && record.itemType !== "immutable-audit-export")
  ) {
    return {};
  }
  return {
    gsi2pk: key("GLOBAL", "GOVERNED-ORGANIZATIONS"),
    gsi2sk: key("ORG", organizationId, record.itemType.toUpperCase(), field(record.data, "id")!),
  };
}

function governanceDispatchKeys(record: KeyableRecord, identity: readonly string[]) {
  if (record.itemType === "retention-restamp") {
    return {
      gsi2pk: key(
        "GOVERNANCE-DISPATCH",
        "pending",
        stableShard(identity, GOVERNANCE_DISPATCH_SHARD_COUNT),
      ),
      gsi2sk: key(field(record.data, "dueAt")!, ...identity),
    };
  }
  if (record.itemType !== "governance-operation") return {};
  const status = field(record.data, "status");
  const dispatchable =
    field(record.data, "kind") === "tenant-erasure" || field(record.data, "dispatchReadyAt");
  const dueAt =
    status === "pending"
      ? field(record.data, "updatedAt")
      : status === "running"
        ? field(record.data, "leaseExpiresAt")
        : undefined;
  if (!dispatchable || !dueAt || (status !== "pending" && status !== "running")) return {};
  return {
    gsi2pk: key(
      "GOVERNANCE-DISPATCH",
      status,
      stableShard(identity, GOVERNANCE_DISPATCH_SHARD_COUNT),
    ),
    gsi2sk: key(dueAt, ...identity),
  };
}

/** Brain-inventory partition of one organization's locators that name exactly one Brain. */
export function governanceBrainInventoryPartition(organizationId: string, brainId: string) {
  return key("ORG", organizationId, "BRAIN", brainId, "GOVERNANCE-INVENTORY");
}

/** Brain-inventory partition of one organization's locators that name two or more Brains. */
export function governanceMultiBrainInventoryPartition(organizationId: string) {
  return key("ORG", organizationId, "GOVERNANCE-INVENTORY", "MULTI-BRAIN");
}

function governanceBrainInventoryKeys(record: KeyableRecord, identity: readonly string[]) {
  if (record.itemType !== "governance-tenant-record") return {};
  const brainIds = record.data.brainIds;
  const organizationId = field(record.data, "organizationId");
  if (!organizationId || !Array.isArray(brainIds) || brainIds.length === 0) return {};
  return {
    gsi2pk:
      brainIds.length === 1
        ? governanceBrainInventoryPartition(organizationId, String(brainIds[0]))
        : governanceMultiBrainInventoryPartition(organizationId),
    // The locator's own sort key, so the index orders exactly like the organization inventory.
    gsi2sk: key("RECORD", createHash("sha256").update(identity.join("\0")).digest("hex")),
  };
}

export function governanceSecondaryKeys(
  record: KeyableRecord,
  table: LogicalTableName,
  identity: readonly string[],
) {
  if (table === "identity" || table === "identity-email-outbox") return {};
  return {
    ...governedOrganizationDiscoveryKeys(record),
    ...governanceDispatchKeys(record, identity),
    ...governanceBrainInventoryKeys(record, identity),
    ...governanceThreadInventoryKeys(record, identity),
  };
}
