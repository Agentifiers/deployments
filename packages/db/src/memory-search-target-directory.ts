import type { TransactionDelete, TransactionOperation, TransactionPut } from "./client-types.ts";
import { memorySearchTargetRecordDigest } from "./memory-search-record-keys.ts";
import { tableForItemType, withCanonicalRecordKeys, type PlatformRecord } from "./records/index.ts";

const targetRecordItemTypes = new Set<PlatformRecord["itemType"]>([
  "memory-index-job",
  "memory-index-state",
  "memory-provider-mutation-claim",
  "memory-provider-mutation-gate",
  "memory-shadow-job",
]);

type TargetDirectoryRecord = Extract<
  PlatformRecord,
  { readonly itemType: "memory-search-target-record" }
>;

const MEMORY_SEARCH_TARGET_RECORD_UPSERT_CONDITION =
  "attribute_not_exists(pk) OR (#directoryItemType = :directoryItemType AND #directoryData.#directoryOrganizationId = :directoryOrganizationId AND #directoryData.#directoryTargetId = :directoryTargetId AND #directoryData.#directoryRecordItemType = :directoryRecordItemType AND #directoryData.#directoryRecordPk = :directoryRecordPk AND #directoryData.#directoryRecordSk = :directoryRecordSk AND #directoryData.#directoryRecordTable = :directoryRecordTable)";

function memorySearchTargetDirectoryRecord(
  record: PlatformRecord,
): TargetDirectoryRecord | undefined {
  if (!targetRecordItemTypes.has(record.itemType)) return undefined;
  const data = record.data as Readonly<Record<string, unknown>>;
  if (typeof data.targetId !== "string") return undefined;
  if (
    typeof data.organizationId !== "string" ||
    typeof data.createdAt !== "string" ||
    typeof data.version !== "number"
  ) {
    throw new Error(`Target-qualified ${record.itemType} is missing its canonical envelope.`);
  }
  const recordTable = tableForItemType(record.itemType);
  if (recordTable !== "control" && recordTable !== "execution") {
    throw new Error(`Target-qualified ${record.itemType} uses an unsupported table.`);
  }
  return withCanonicalRecordKeys({
    data: {
      createdAt: data.createdAt,
      organizationId: data.organizationId,
      recordItemType: record.itemType,
      recordPk: record.pk,
      recordSk: record.sk,
      recordTable,
      targetId: data.targetId,
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : data.createdAt,
      version: data.version,
    },
    itemType: "memory-search-target-record" as const,
  }) as TargetDirectoryRecord;
}

function targetDirectoryPut(record: TargetDirectoryRecord): TransactionPut {
  return {
    allowExisting: true,
    conditionExpression: MEMORY_SEARCH_TARGET_RECORD_UPSERT_CONDITION,
    expressionAttributeNames: {
      "#directoryData": "data",
      "#directoryItemType": "itemType",
      "#directoryOrganizationId": "organizationId",
      "#directoryRecordItemType": "recordItemType",
      "#directoryRecordPk": "recordPk",
      "#directoryRecordSk": "recordSk",
      "#directoryRecordTable": "recordTable",
      "#directoryTargetId": "targetId",
    },
    expressionAttributeValues: {
      ":directoryItemType": "memory-search-target-record",
      ":directoryOrganizationId": record.data.organizationId,
      ":directoryRecordItemType": record.data.recordItemType,
      ":directoryRecordPk": record.data.recordPk,
      ":directoryRecordSk": record.data.recordSk,
      ":directoryRecordTable": record.data.recordTable,
      ":directoryTargetId": record.data.targetId,
    },
    kind: "put",
    record,
  };
}

function targetDirectoryDelete(record: TargetDirectoryRecord): TransactionDelete {
  return { allowMissing: true, kind: "delete", record };
}

export function withMemorySearchTargetDirectory(
  operations: readonly TransactionOperation[],
): readonly TransactionOperation[] {
  return operations.flatMap<TransactionOperation>((operation): TransactionOperation[] => {
    if (operation.kind === "condition-check") return [operation];
    const directoryRecord = memorySearchTargetDirectoryRecord(operation.record);
    if (!directoryRecord) return [operation];
    return operation.kind === "put"
      ? [operation, targetDirectoryPut(directoryRecord)]
      : [operation, targetDirectoryDelete(directoryRecord)];
  });
}

export function isCanonicalMemorySearchTargetDirectoryPut(operation: TransactionPut) {
  if (
    operation.record.itemType !== "memory-search-target-record" ||
    operation.conditionExpression !== MEMORY_SEARCH_TARGET_RECORD_UPSERT_CONDITION
  ) {
    return false;
  }
  const record = operation.record;
  return (
    Object.keys(operation.expressionAttributeNames ?? {}).length === 8 &&
    operation.expressionAttributeNames?.["#directoryData"] === "data" &&
    operation.expressionAttributeNames?.["#directoryItemType"] === "itemType" &&
    operation.expressionAttributeNames?.["#directoryOrganizationId"] === "organizationId" &&
    operation.expressionAttributeNames?.["#directoryRecordItemType"] === "recordItemType" &&
    operation.expressionAttributeNames?.["#directoryRecordPk"] === "recordPk" &&
    operation.expressionAttributeNames?.["#directoryRecordSk"] === "recordSk" &&
    operation.expressionAttributeNames?.["#directoryRecordTable"] === "recordTable" &&
    operation.expressionAttributeNames?.["#directoryTargetId"] === "targetId" &&
    Object.keys(operation.expressionAttributeValues ?? {}).length === 7 &&
    operation.expressionAttributeValues?.[":directoryItemType"] === record.itemType &&
    operation.expressionAttributeValues?.[":directoryOrganizationId"] ===
      record.data.organizationId &&
    operation.expressionAttributeValues?.[":directoryRecordItemType"] ===
      record.data.recordItemType &&
    operation.expressionAttributeValues?.[":directoryRecordPk"] === record.data.recordPk &&
    operation.expressionAttributeValues?.[":directoryRecordSk"] === record.data.recordSk &&
    operation.expressionAttributeValues?.[":directoryRecordTable"] === record.data.recordTable &&
    operation.expressionAttributeValues?.[":directoryTargetId"] === record.data.targetId &&
    record.sk ===
      `RECORD#${memorySearchTargetRecordDigest(record.data.recordTable, record.data.recordPk, record.data.recordSk)}`
  );
}
