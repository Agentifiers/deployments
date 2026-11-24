import {
  isDatabaseContention,
  key,
  tableForItemType,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
  memoryPersistence,
} from "@deployments-ai/db";

const COMPACTION_TRANSACTION_RECORDS = 15;
const COMPACTION_PAGE_SIZE = COMPACTION_TRANSACTION_RECORDS * 10;

type TargetRecord = Extract<
  PlatformRecord,
  {
    readonly itemType:
      | "memory-index-job"
      | "memory-index-state"
      | "memory-provider-mutation-claim"
      | "memory-provider-mutation-gate"
      | "memory-shadow-job";
  }
>;

type TargetDirectoryRecord = Extract<
  PlatformRecord,
  { readonly itemType: "memory-search-target-record" }
>;

function isTargetRecord(record: PlatformRecord): record is TargetRecord {
  return [
    "memory-index-job",
    "memory-index-state",
    "memory-provider-mutation-claim",
    "memory-provider-mutation-gate",
    "memory-shadow-job",
  ].includes(record.itemType);
}

function requireCompactable(record: PlatformRecord, organizationId: Ulid, target: Ulid) {
  if (!isTargetRecord(record)) {
    throw new Error("Target compaction index returned an unsupported record type.");
  }
  if (record.data.organizationId !== organizationId || record.data.targetId !== target) {
    throw new Error("Target compaction index returned a record outside its cleanup boundary.");
  }
  if (record.itemType === "memory-provider-mutation-gate" && record.data.status !== "closed") {
    throw new Error("Target compaction requires a closed provider mutation gate.");
  }
  if (
    record.itemType === "memory-provider-mutation-claim" &&
    record.data.status !== "applied" &&
    record.data.status !== "failed"
  ) {
    throw new Error("Target compaction found an unresolved provider mutation claim.");
  }
  if (
    record.itemType === "memory-index-job" &&
    record.data.status !== "failed" &&
    record.data.status !== "succeeded"
  ) {
    throw new Error("Target compaction found a nonterminal index job.");
  }
}

function requireDirectoryRecord(
  record: PlatformRecord,
  organizationId: Ulid,
  targetId: Ulid,
): TargetDirectoryRecord {
  if (record.itemType !== "memory-search-target-record") {
    throw new Error("Target compaction directory returned an unsupported record type.");
  }
  if (record.data.organizationId !== organizationId || record.data.targetId !== targetId) {
    throw new Error("Target compaction directory returned a record outside its cleanup boundary.");
  }
  return record;
}

function requireMatchingReference(record: PlatformRecord, directory: TargetDirectoryRecord) {
  if (
    record.itemType !== directory.data.recordItemType ||
    record.pk !== directory.data.recordPk ||
    record.sk !== directory.data.recordSk ||
    tableForItemType(record.itemType) !== directory.data.recordTable
  ) {
    throw new Error("Target compaction directory reference does not match its stored record.");
  }
}

async function targetPage(database: DynamoDatabaseService, targetId: Ulid) {
  return memoryPersistence.find(database, "control", {
    ConsistentRead: true,
    ExpressionAttributeValues: {
      ":pk": key("MEMORY-SEARCH-TARGET", targetId),
    },
    KeyConditionExpression: "pk = :pk",
    Limit: COMPACTION_PAGE_SIZE,
  });
}

async function deleteOperations(args: {
  readonly database: DynamoDatabaseService;
  readonly directories: readonly TargetDirectoryRecord[];
  readonly organizationId: Ulid;
  readonly targetId: Ulid;
}) {
  return Promise.all(
    args.directories.map(async (directory): Promise<TransactionOperation> => {
      const stored = await memoryPersistence.read(
        args.database,
        directory.data.recordTable,
        { pk: directory.data.recordPk, sk: directory.data.recordSk },
        true,
      );
      if (stored === undefined) {
        return { allowMissing: true, kind: "delete", record: directory };
      }
      requireMatchingReference(stored, directory);
      requireCompactable(stored, args.organizationId, args.targetId);
      return { kind: "delete", record: stored };
    }),
  );
}

async function persistCompactionTransaction(
  database: DynamoDatabaseService,
  operations: readonly TransactionOperation[],
  erasureOwner?: { readonly operationId: Ulid; readonly organizationId: Ulid },
) {
  if (erasureOwner) {
    if (!memoryPersistence.supportsErasure(database)) {
      throw new Error("Erasure-owner-aware target compaction is unavailable.");
    }
    await memoryPersistence.commitErasure(database, operations, erasureOwner);
    return;
  }
  await memoryPersistence.commit(database, operations);
}

export const MEMORY_SEARCH_COMPACTION_BUDGET_MS = 240_000;

/**
 * Deletes the target's records in transactions of 15 until `deadline`. The closed mutation gate
 * stays, because a resumed drain reads it; `ready` returns its deletion for the caller's final
 * commit once nothing else is left.
 */
export async function memorySearchTargetCompactionOperations(args: {
  readonly database: DynamoDatabaseService;
  readonly deadline: number;
  readonly erasureOwner?: {
    readonly operationId: Ulid;
    readonly organizationId: Ulid;
  };
  readonly now: () => Date;
  readonly organizationId: Ulid;
  readonly targetId: Ulid;
}): Promise<
  | { readonly operations: readonly TransactionOperation[]; readonly status: "ready" }
  | { readonly status: "pending" }
> {
  try {
    while (args.now().getTime() < args.deadline) {
      const page = await targetPage(args.database, args.targetId);
      const directories = page.items.map((candidate) =>
        requireDirectoryRecord(candidate, args.organizationId, args.targetId),
      );
      const isGate = (directory: TargetDirectoryRecord) =>
        directory.data.recordItemType === "memory-provider-mutation-gate";
      const operations = await deleteOperations({
        database: args.database,
        directories: directories.filter((directory) => !isGate(directory)),
        organizationId: args.organizationId,
        targetId: args.targetId,
      });
      if (operations.length === 0 && !page.lastEvaluatedKey) {
        return {
          operations: await deleteOperations({
            database: args.database,
            directories: directories.filter(isGate),
            organizationId: args.organizationId,
            targetId: args.targetId,
          }),
          status: "ready",
        };
      }
      for (let start = 0; start < operations.length; start += COMPACTION_TRANSACTION_RECORDS) {
        await persistCompactionTransaction(
          args.database,
          operations.slice(start, start + COMPACTION_TRANSACTION_RECORDS),
          args.erasureOwner,
        );
        if (args.now().getTime() >= args.deadline) return { status: "pending" };
      }
    }
    return { status: "pending" };
  } catch (cause) {
    if (isDatabaseContention(cause)) return { status: "pending" };
    throw cause;
  }
}
