import {
  DatabaseError,
  type DynamoDatabaseService,
  type TransactionOperation,
} from "../client-types.ts";
import { prepareDynamoTransactionOperations } from "../dynamo-database.ts";
import { tableForItemType, type PlatformRecord } from "../records/index.ts";

function conflict(message: string) {
  return new DatabaseError({
    cause: "ConditionalCheckFailedException",
    message,
    operation: "transact-write",
    reason: "conflict",
    table: "multiple",
  });
}

/**
 * Evaluates the semantic-event predecessor check the way DynamoDB does: against the state before
 * the transaction. Other condition checks (erasure fence, organization existence) are not modeled.
 */
function predecessorEventExists(
  records: ReadonlyMap<string, PlatformRecord>,
  itemKey: string,
  values: Readonly<Record<string, unknown>>,
) {
  const stored = records.get(itemKey);
  if (stored?.itemType !== "semantic-event") return false;
  return (
    stored.data.aggregateId === values[":aggregateId"] &&
    stored.data.aggregateType === values[":aggregateType"] &&
    stored.data.aggregateVersion === values[":aggregateVersion"]
  );
}

/**
 * In-memory database for evaluation persistence tests. Transactions run through the real
 * canonicalization and transaction-invariant validation before they are applied.
 */
export interface EvaluationMemoryDatabase {
  readonly all: () => PlatformRecord[];
  readonly database: DynamoDatabaseService;
  readonly records: Map<string, PlatformRecord>;
  readonly transactions: (readonly TransactionOperation[])[];
}

export function evaluationMemoryDatabase(
  initial: readonly PlatformRecord[] = [],
): EvaluationMemoryDatabase {
  const records = new Map<string, PlatformRecord>();
  const storeKey = (table: string, pk: string, sk: string) => `${table}\u0000${pk}\u0000${sk}`;
  for (const record of initial) {
    records.set(storeKey(tableForItemType(record.itemType), record.pk, record.sk), record);
  }
  const transactions: (readonly TransactionOperation[])[] = [];

  function apply(operations: readonly TransactionOperation[]) {
    const staged = new Map(records);
    for (const operation of operations) {
      if (operation.kind === "condition-check") {
        const values = operation.expressionAttributeValues ?? {};
        if (
          operation.table === "events" &&
          values[":itemType"] === "semantic-event" &&
          !predecessorEventExists(
            records,
            storeKey(operation.table, operation.key.pk, operation.key.sk),
            values,
          )
        ) {
          throw conflict("The previous semantic event of the aggregate is missing.");
        }
        continue;
      }
      const table = tableForItemType(operation.record.itemType);
      const itemKey = storeKey(table, operation.record.pk, operation.record.sk);
      const existing = staged.get(itemKey);
      if (operation.kind === "delete") {
        if (!existing && !operation.allowMissing) throw conflict("Deleted record is missing.");
        staged.delete(itemKey);
        continue;
      }
      if (operation.record.itemType.startsWith("governance-")) {
        staged.set(itemKey, operation.record);
        continue;
      }
      if (operation.previousRecord) {
        const previousVersion =
          "version" in operation.previousRecord.data
            ? operation.previousRecord.data.version
            : undefined;
        const storedVersion =
          existing && "version" in existing.data ? existing.data.version : undefined;
        if (!existing || storedVersion !== previousVersion) {
          throw conflict("Stored version does not match the previous record.");
        }
      } else if (existing && !operation.allowExisting) {
        throw conflict("Create-only put found an existing record.");
      }
      staged.set(itemKey, operation.record);
    }
    records.clear();
    for (const [itemKey, record] of staged) records.set(itemKey, record);
  }

  const service: DynamoDatabaseService = {
    deleteRecord: async () => {
      throw new Error("Evaluation persistence writes through transactions.");
    },
    getRecord: async (table, recordKey) => records.get(storeKey(table, recordKey.pk, recordKey.sk)),
    putRecord: async () => {
      throw new Error("Evaluation persistence writes through transactions.");
    },
    queryRecords: async (table, query) => {
      const index = query.IndexName;
      const partitionField = index ? `${index}pk` : "pk";
      const sortField = index ? `${index}sk` : "sk";
      const values = query.ExpressionAttributeValues ?? {};
      const condition = query.KeyConditionExpression ?? "";
      const sortValue = (record: PlatformRecord) => {
        const value = (record as unknown as Record<string, unknown>)[sortField];
        return typeof value === "string" ? value : "";
      };
      const matches = [...records.entries()]
        .filter(([itemKey]) => itemKey.startsWith(`${table}\u0000`))
        .map(([, record]) => record)
        .filter((record) => {
          const fields = record as unknown as Record<string, unknown>;
          if (fields[partitionField] !== values[":pk"]) return false;
          const sort = sortValue(record);
          if (condition.includes("begins_with")) return sort.startsWith(String(values[":sk"]));
          if (condition.includes("BETWEEN")) {
            return sort >= String(values[":lower"]) && sort <= String(values[":upper"]);
          }
          return true;
        })
        .sort((left, right) => sortValue(left).localeCompare(sortValue(right)));
      if (query.ScanIndexForward === false) matches.reverse();
      const start = query.ExclusiveStartKey
        ? matches.findIndex(
            (record) =>
              record.pk === query.ExclusiveStartKey?.pk &&
              record.sk === query.ExclusiveStartKey?.sk,
          ) + 1
        : 0;
      const limit = query.Limit ?? matches.length;
      const items = matches.slice(start, start + limit);
      const last = items.at(-1);
      return {
        items,
        ...(last && start + limit < matches.length
          ? {
              lastEvaluatedKey: {
                pk: last.pk,
                sk: last.sk,
                ...(index
                  ? {
                      [partitionField]: (last as unknown as Record<string, unknown>)[
                        partitionField
                      ],
                      [sortField]: sortValue(last),
                    }
                  : {}),
              },
            }
          : {}),
      };
    },
    transactWrite: async (operations) => {
      const prepared = await prepareDynamoTransactionOperations(operations);
      try {
        apply(prepared);
        transactions.push(operations);
      } catch (cause) {
        throw cause instanceof DatabaseError ? cause : conflict(String(cause));
      }
    },
  };

  return {
    all: () => [...records.values()],
    database: service,
    records,
    transactions,
  };
}

export function withCreateOnlyPutRecord(database: DynamoDatabaseService): DynamoDatabaseService {
  return { ...database, putRecord: (record) => database.transactWrite([{ kind: "put", record }]) };
}
