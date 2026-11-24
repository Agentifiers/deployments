import { createHash } from "node:crypto";
import type { TransactionDelete, TransactionOperation, TransactionPut } from "./client-types.ts";
import { expiresByRetentionTtl } from "./governance/contracts.ts";
import type { GovernanceInventoryLayout } from "./governance-inventory-layout.ts";
import { key } from "./keys.ts";
import { field, type KeyableRecord } from "./record-key-fields.ts";
import {
  governanceInventoryPartition,
  governanceLegacyInventoryPartition,
} from "./record-key-governance.ts";
import { tableForItemType, withCanonicalRecordKeys, type PlatformRecord } from "./records/index.ts";
import { governanceThreadIds } from "./thread-erasure/ownership.ts";
import { stableTenantMutationCapacity } from "./thread-erasure/transaction-capacity.ts";

type DirectoryRecord = Extract<PlatformRecord, { readonly itemType: "governance-tenant-record" }>;
type LegacyDirectoryRecord = Extract<
  PlatformRecord,
  { readonly itemType: "governance-legacy-record" }
>;

const DIRECTORY_ITEM_TYPE = "governance-tenant-record";
const LEGACY_DIRECTORY_ITEM_TYPE = "governance-legacy-record";

export const MAX_THREADLESS_STABLE_TENANT_MUTATIONS_PER_TRANSACTION =
  stableTenantMutationCapacity(0);

export const GOVERNANCE_TENANT_RECORD_UPSERT_CONDITION =
  "attribute_not_exists(pk) OR (#directoryItemType = :directoryItemType AND #directoryData.#directoryOrganizationId = :directoryOrganizationId AND #directoryData.#directoryRecordItemType = :directoryRecordItemType AND #directoryData.#directoryRecordPk = :directoryRecordPk AND #directoryData.#directoryRecordSk = :directoryRecordSk AND #directoryData.#directoryRecordTable = :directoryRecordTable)";

function uniqueClaimOrganizationId(record: KeyableRecord) {
  if (record.itemType !== "unique-claim") return undefined;
  const ownerPk = field(record.data, "ownerPk");
  const [scope, encodedId] = ownerPk?.split("#") ?? [];
  if (scope !== "ORG" || !encodedId) return undefined;
  return decodeURIComponent(encodedId);
}

export function governanceTenantOrganizationId(record: KeyableRecord) {
  if (record.itemType === DIRECTORY_ITEM_TYPE || record.itemType === LEGACY_DIRECTORY_ITEM_TYPE) {
    return undefined;
  }
  return (
    field(record.data, "organizationId") ??
    (record.itemType === "organization" ? field(record.data, "id") : undefined) ??
    uniqueClaimOrganizationId(record)
  );
}

// Brain erasure owns every tenant record that names its Brain: the Brain itself, its
// Brain-scoped rate-limit counters, and any record whose data carries the Brain id under a
// `brainId` field at any nesting depth (Brain resources, derived-memory citations, Brain semantic
// event payloads). Locators carry this set so erasure can read one Brain without the organization.
const MAX_BRAIN_REFERENCE_DEPTH = 12;

function collectBrainIds(value: unknown, brainIds: Set<string>, depth: number) {
  if (depth > MAX_BRAIN_REFERENCE_DEPTH || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectBrainIds(entry, brainIds, depth + 1);
    return;
  }
  const object = value as Readonly<Record<string, unknown>>;
  if (typeof object.brainId === "string" && object.brainId.length > 0) {
    brainIds.add(object.brainId);
  }
  for (const entry of Object.values(object)) collectBrainIds(entry, brainIds, depth + 1);
}

export function governanceBrainIds(record: KeyableRecord): readonly string[] {
  const brainIds = new Set<string>();
  if (record.itemType === "brain") {
    const id = field(record.data, "id");
    if (id) brainIds.add(id);
  }
  if (record.itemType === "rate-limit-counter") {
    const scopeId = field(record.data, "scopeId");
    if (scopeId && field(record.data, "limitKey")?.includes(".brain")) brainIds.add(scopeId);
  }
  collectBrainIds(record.data, brainIds, 0);
  return [...brainIds].sort();
}

// Retention ages a record from the first of these data fields that holds a string.
const RETENTION_TIMESTAMP_FIELDS = [
  "retentionExpiresAt",
  "expiresAt",
  "completedAt",
  "occurredAt",
  "updatedAt",
  "createdAt",
] as const;

/** The data timestamp retention ages a record from; locators carry it to preselect candidates. */
export function governanceRecordTimestamp(record: KeyableRecord): string | undefined {
  const data = record.data as Readonly<Record<string, unknown>> | undefined;
  for (const name of RETENTION_TIMESTAMP_FIELDS) {
    const value = data?.[name];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** Digest of one object location, shared by locators and retention blob-liveness checks. */
export function governanceObjectDigest(bucket: string, objectKey: string) {
  return createHash("sha256").update(bucket).update("\0").update(objectKey).digest("hex");
}

const MAX_OBJECT_REFERENCE_DEPTH = 12;

function collectObjectDigests(value: unknown, digests: Set<string>, depth: number) {
  if (depth > MAX_OBJECT_REFERENCE_DEPTH || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectObjectDigests(entry, digests, depth + 1);
    return;
  }
  const object = value as Readonly<Record<string, unknown>>;
  if (typeof object.bucket === "string" && typeof object.key === "string") {
    digests.add(governanceObjectDigest(object.bucket, object.key));
  }
  for (const entry of Object.values(object)) collectObjectDigests(entry, digests, depth + 1);
}

// Every `{ bucket, key }` object anywhere in the record data, a superset of the blob references
// governance deletes, so a locator never under-reports an object its record keeps alive.
export function governanceObjectDigests(record: KeyableRecord): readonly string[] {
  const digests = new Set<string>();
  collectObjectDigests(record.data, digests, 0);
  return [...digests].sort();
}

export function governanceLegacyDirectoryRecord(
  record: PlatformRecord,
): LegacyDirectoryRecord | undefined {
  if (
    record.itemType !== "idempotency" ||
    record.data.organizationId !== undefined ||
    record.data.principalId === undefined
  ) {
    return undefined;
  }
  return withCanonicalRecordKeys({
    data: {
      kind: "principal-idempotency" as const,
      recordItemType: "idempotency" as const,
      recordPk: record.pk,
      recordSk: record.sk,
      recordTable: "events" as const,
      ...(record.ttl !== undefined ? { recordTtl: record.ttl } : {}),
    },
    itemType: LEGACY_DIRECTORY_ITEM_TYPE,
  }) as LegacyDirectoryRecord;
}

export function governanceTenantRecordDigest(table: string, pk: string, sk: string) {
  return createHash("sha256")
    .update(table)
    .update("\0")
    .update(pk)
    .update("\0")
    .update(sk)
    .digest("hex");
}

export function governanceTenantDirectoryKey(
  organizationId: string,
  recordTable: string,
  recordPk: string,
  recordSk: string,
) {
  return {
    pk: governanceInventoryPartition(organizationId, recordTable, recordPk, recordSk),
    sk: key("RECORD", governanceTenantRecordDigest(recordTable, recordPk, recordSk)),
  };
}

export function governanceTenantDirectoryRecord(
  record: PlatformRecord,
  organizationIdOverride?: string,
): DirectoryRecord | undefined {
  const recordTable = tableForItemType(record.itemType);
  if (
    recordTable === "identity" ||
    recordTable === "identity-email-outbox" ||
    record.itemType === DIRECTORY_ITEM_TYPE ||
    // Tenant erasure deletes an organization's gate lanes with the organization itself.
    record.itemType === "organization-gate-lane"
  ) {
    return undefined;
  }
  const organizationId = organizationIdOverride ?? governanceTenantOrganizationId(record);
  if (!organizationId) return undefined;
  const brainIds = governanceBrainIds(record);
  const threadIds = governanceThreadIds(record);
  const recordTimestamp = governanceRecordTimestamp(record);
  return withCanonicalRecordKeys({
    data: {
      ...(brainIds.length > 0 ? { brainIds } : {}),
      organizationId,
      recordObjectDigests: governanceObjectDigests(record),
      recordItemType: record.itemType,
      recordPk: record.pk,
      recordSk: record.sk,
      recordTable,
      ...(recordTimestamp !== undefined ? { recordTimestamp } : {}),
      ...(record.ttl !== undefined ? { recordTtl: record.ttl } : {}),
      ...(threadIds.length > 0 ? { threadIds } : {}),
    },
    itemType: DIRECTORY_ITEM_TYPE,
    ...(record.ttl !== undefined && expiresByRetentionTtl(record.itemType)
      ? { ttl: record.ttl }
      : {}),
  }) as DirectoryRecord;
}

function directoryPut(record: DirectoryRecord): TransactionPut {
  return {
    allowExisting: true,
    conditionExpression: GOVERNANCE_TENANT_RECORD_UPSERT_CONDITION,
    expressionAttributeNames: {
      "#directoryData": "data",
      "#directoryItemType": "itemType",
      "#directoryOrganizationId": "organizationId",
      "#directoryRecordItemType": "recordItemType",
      "#directoryRecordPk": "recordPk",
      "#directoryRecordSk": "recordSk",
      "#directoryRecordTable": "recordTable",
    },
    expressionAttributeValues: {
      ":directoryItemType": DIRECTORY_ITEM_TYPE,
      ":directoryOrganizationId": record.data.organizationId,
      ":directoryRecordItemType": record.data.recordItemType,
      ":directoryRecordPk": record.data.recordPk,
      ":directoryRecordSk": record.data.recordSk,
      ":directoryRecordTable": record.data.recordTable,
    },
    kind: "put",
    record,
  };
}

function directoryDelete(record: DirectoryRecord): TransactionDelete {
  return { allowMissing: true, kind: "delete", record };
}

function legacyDirectoryPut(record: LegacyDirectoryRecord): TransactionPut {
  return {
    allowExisting: true,
    conditionExpression:
      "attribute_not_exists(pk) OR (#directoryItemType = :directoryItemType AND #directoryData.#directoryRecordPk = :directoryRecordPk AND #directoryData.#directoryRecordSk = :directoryRecordSk)",
    expressionAttributeNames: {
      "#directoryData": "data",
      "#directoryItemType": "itemType",
      "#directoryRecordPk": "recordPk",
      "#directoryRecordSk": "recordSk",
    },
    expressionAttributeValues: {
      ":directoryItemType": LEGACY_DIRECTORY_ITEM_TYPE,
      ":directoryRecordPk": record.data.recordPk,
      ":directoryRecordSk": record.data.recordSk,
    },
    kind: "put",
    record,
  };
}

function legacyDirectoryDelete(record: LegacyDirectoryRecord): TransactionDelete {
  return { allowMissing: true, kind: "delete", record };
}

export function withGovernanceTenantDirectory(
  operations: readonly TransactionOperation[],
): readonly TransactionOperation[] {
  return operations.flatMap<TransactionOperation>((operation): TransactionOperation[] => {
    if (operation.kind === "condition-check") return [operation];
    const current =
      governanceTenantDirectoryRecord(operation.record) ??
      governanceLegacyDirectoryRecord(operation.record);
    const previous =
      operation.kind === "put" && operation.previousRecord
        ? (governanceTenantDirectoryRecord(operation.previousRecord) ??
          governanceLegacyDirectoryRecord(operation.previousRecord))
        : undefined;
    const put = current
      ? current.itemType === DIRECTORY_ITEM_TYPE
        ? directoryPut(current)
        : legacyDirectoryPut(current)
      : undefined;
    const remove = (record: DirectoryRecord | LegacyDirectoryRecord) =>
      record.itemType === DIRECTORY_ITEM_TYPE
        ? directoryDelete(record)
        : legacyDirectoryDelete(record);
    if (operation.kind === "delete") return current ? [operation, remove(current)] : [operation];
    if (previous && (!current || previous.pk !== current.pk || previous.sk !== current.sk)) {
      return [operation, remove(previous), ...(put ? [put] : [])];
    }
    return put ? [operation, put] : [operation];
  });
}

/** The locator where `layout` writes it: on its shard, or on its organization's legacy partition. */
export function placeGovernanceLocator<Locator extends DirectoryRecord>(
  locator: Locator,
  layout: GovernanceInventoryLayout,
): Locator {
  return layout === "sharded"
    ? locator
    : { ...locator, pk: governanceLegacyInventoryPartition(locator.data.organizationId) };
}

/** Places the locator writes of canonical operations; a locator write is canonical on its shard. */
export function placeGovernanceLocatorOperations(
  operations: readonly TransactionOperation[],
  layout: GovernanceInventoryLayout,
): readonly TransactionOperation[] {
  return operations.map((operation) =>
    operation.kind === "condition-check" || operation.record.itemType !== DIRECTORY_ITEM_TYPE
      ? operation
      : { ...operation, record: placeGovernanceLocator(operation.record, layout) },
  );
}

export function governanceTenantDirectoryPutItem(
  record: PlatformRecord,
  controlTable: string,
  layout: GovernanceInventoryLayout,
) {
  const directory = governanceTenantDirectoryRecord(record);
  if (!directory) return undefined;
  const operation = directoryPut(directory);
  return {
    Put: {
      ConditionExpression: operation.conditionExpression,
      ExpressionAttributeNames: operation.expressionAttributeNames,
      ExpressionAttributeValues: operation.expressionAttributeValues,
      Item: placeGovernanceLocator(directory, layout),
      TableName: controlTable,
    },
  };
}

export function governanceTenantDirectoryDeleteItem(
  record: PlatformRecord,
  controlTable: string,
  layout: GovernanceInventoryLayout,
  organizationId?: string,
) {
  const directory = governanceTenantDirectoryRecord(record, organizationId);
  if (!directory) return undefined;
  const placed = placeGovernanceLocator(directory, layout);
  return {
    Delete: {
      Key: { pk: placed.pk, sk: placed.sk },
      TableName: controlTable,
    },
  };
}

export function governancePersistenceDirectoryDeleteItem(
  record: PlatformRecord,
  controlTable: string,
  layout: GovernanceInventoryLayout,
  organizationId?: string,
) {
  const tenant = governanceTenantDirectoryRecord(record, organizationId);
  const directory = tenant
    ? placeGovernanceLocator(tenant, layout)
    : governanceLegacyDirectoryRecord(record);
  if (!directory) return undefined;
  return {
    Delete: {
      Key: { pk: directory.pk, sk: directory.sk },
      TableName: controlTable,
    },
  };
}

export function governanceTenantDirectoryDeleteLocatorItem(
  organizationId: string,
  recordTable: string,
  recordPk: string,
  recordSk: string,
  controlTable: string,
  layout: GovernanceInventoryLayout,
) {
  const shard = governanceTenantDirectoryKey(organizationId, recordTable, recordPk, recordSk);
  return {
    Delete: {
      Key:
        layout === "sharded"
          ? shard
          : { pk: governanceLegacyInventoryPartition(organizationId), sk: shard.sk },
      TableName: controlTable,
    },
  };
}

export function isCanonicalGovernanceTenantDirectoryPut(operation: TransactionPut) {
  if (operation.record.itemType === LEGACY_DIRECTORY_ITEM_TYPE) {
    return (
      operation.allowExisting === true &&
      operation.expressionAttributeValues?.[":directoryItemType"] === LEGACY_DIRECTORY_ITEM_TYPE &&
      operation.expressionAttributeValues?.[":directoryRecordPk"] ===
        operation.record.data.recordPk &&
      operation.expressionAttributeValues?.[":directoryRecordSk"] === operation.record.data.recordSk
    );
  }
  if (
    operation.record.itemType !== DIRECTORY_ITEM_TYPE ||
    operation.conditionExpression !== GOVERNANCE_TENANT_RECORD_UPSERT_CONDITION
  ) {
    return false;
  }
  const record = operation.record;
  return (
    operation.expressionAttributeNames?.["#directoryData"] === "data" &&
    operation.expressionAttributeNames?.["#directoryItemType"] === "itemType" &&
    operation.expressionAttributeNames?.["#directoryOrganizationId"] === "organizationId" &&
    operation.expressionAttributeNames?.["#directoryRecordItemType"] === "recordItemType" &&
    operation.expressionAttributeNames?.["#directoryRecordPk"] === "recordPk" &&
    operation.expressionAttributeNames?.["#directoryRecordSk"] === "recordSk" &&
    operation.expressionAttributeNames?.["#directoryRecordTable"] === "recordTable" &&
    operation.expressionAttributeValues?.[":directoryItemType"] === record.itemType &&
    operation.expressionAttributeValues?.[":directoryOrganizationId"] ===
      record.data.organizationId &&
    operation.expressionAttributeValues?.[":directoryRecordItemType"] ===
      record.data.recordItemType &&
    operation.expressionAttributeValues?.[":directoryRecordPk"] === record.data.recordPk &&
    operation.expressionAttributeValues?.[":directoryRecordSk"] === record.data.recordSk &&
    operation.expressionAttributeValues?.[":directoryRecordTable"] === record.data.recordTable &&
    record.pk ===
      governanceInventoryPartition(
        record.data.organizationId,
        record.data.recordTable,
        record.data.recordPk,
        record.data.recordSk,
      ) &&
    record.sk ===
      key(
        "RECORD",
        governanceTenantRecordDigest(
          record.data.recordTable,
          record.data.recordPk,
          record.data.recordSk,
        ),
      )
  );
}
