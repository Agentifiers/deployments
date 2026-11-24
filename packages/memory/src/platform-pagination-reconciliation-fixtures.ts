import { optionalExpressionString } from "./test-fixtures.ts";
import type {
  DynamoDatabaseService,
  PlatformRecord,
  QueryRecordsResult,
  TransactionOperation,
  Ulid,
} from "@deployments-ai/db";

export const fixedNow = new Date("2026-07-21T18:00:00.000Z");

const ulidAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function indexedUlid(index: number) {
  let value = index;
  let suffix = "";
  for (let position = 0; position < 6; position += 1) {
    suffix = ulidAlphabet[value % ulidAlphabet.length] + suffix;
    value = Math.floor(value / ulidAlphabet.length);
  }
  return `01ARZ3NDEKTSV4RRFFQ6${suffix}` as Ulid;
}

export function memoryDatabase() {
  const tables = new Map<string, Map<string, PlatformRecord>>();
  const clientRequestTokens: (string | undefined)[] = [];
  const queries: { readonly input: Record<string, unknown>; readonly table: string }[] = [];
  const transactions: (readonly TransactionOperation[])[] = [];
  const transactionSizes: number[] = [];
  // Each table's records grouped by `pk`, in the table's insertion order, so a partition query reads
  // only its partition. A record's `pk` is part of its key, so it never moves between partitions.
  const partitions = new Map<string, Map<string, Map<string, PlatformRecord>>>();
  const table = (name: string) => {
    let records = tables.get(name);
    if (!records) {
      records = new Map();
      tables.set(name, records);
    }
    return records;
  };
  const partition = (name: string, pk: string) => {
    let byPk = partitions.get(name);
    if (!byPk) {
      byPk = new Map();
      partitions.set(name, byPk);
    }
    let records = byPk.get(pk);
    if (!records) {
      records = new Map();
      byPk.set(pk, records);
    }
    return records;
  };
  const put = (name: string, value: PlatformRecord) => {
    const key = `${value.pk}\u0000${value.sk}`;
    table(name).set(key, value);
    partition(name, value.pk).set(key, value);
  };
  const remove = (name: string, record: { readonly pk: string; readonly sk: string }) => {
    const key = `${record.pk}\u0000${record.sk}`;
    table(name).delete(key);
    partitions.get(name)?.get(record.pk)?.delete(key);
  };
  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => {
      for (const name of tables.keys()) remove(name, record);
    },
    getRecord: async (name, key) => {
      const value = table(name).get(`${key.pk}\u0000${key.sk}`);
      return value;
    },
    putRecord: async (record) =>
      put(record.itemType === "semantic-event" ? "events" : tableName(record), record),
    queryRecords: async (name, input) => {
      queries.push({ input: input as Record<string, unknown>, table: name });
      const expressions = input.ExpressionAttributeValues as Record<string, unknown> | undefined;
      const pkName =
        input.IndexName === "gsi2" ? "gsi2pk" : input.IndexName === "gsi1" ? "gsi1pk" : "pk";
      const skName =
        input.IndexName === "gsi2" ? "gsi2sk" : input.IndexName === "gsi1" ? "gsi1sk" : "sk";
      const partitionKey = optionalExpressionString(expressions, ":pk");
      const values = [
        ...(pkName === "pk" && partitionKey !== undefined
          ? (partitions.get(name)?.get(partitionKey)?.values() ?? [])
          : table(name).values()),
      ];
      const prefix = optionalExpressionString(expressions, ":prefix");
      const exact = expressions?.[":run"];
      const lowerBound =
        optionalExpressionString(expressions, ":since") ??
        optionalExpressionString(expressions, ":from");
      const upperBound = optionalExpressionString(expressions, ":to");
      const matching = values
        .filter((value) => partitionKey === undefined || value[pkName] === partitionKey)
        .filter((value) => exact === undefined || value[skName] === exact)
        .filter(
          (value) =>
            lowerBound === undefined ||
            (typeof value[skName] === "string" && value[skName] >= lowerBound),
        )
        .filter(
          (value) =>
            upperBound === undefined ||
            (typeof value[skName] === "string" && value[skName] <= upperBound),
        )
        .filter(
          (value) =>
            prefix === undefined ||
            (typeof value[skName] === "string" && value[skName].startsWith(prefix)),
        );
      const position = (value: Record<string, unknown>) =>
        [value[skName], value.pk, value.sk]
          .map((part) => (typeof part === "string" ? part : ""))
          .join("\u0000");
      if (input.ScanIndexForward !== undefined) {
        matching.sort((left, right) =>
          position(left) < position(right) ? -1 : position(left) > position(right) ? 1 : 0,
        );
        if (!input.ScanIndexForward) matching.reverse();
      }
      const startKey = input.ExclusiveStartKey as Record<string, unknown> | undefined;
      const legacyCursor = Number(startKey?.cursor ?? Number.NaN);
      // A forward query resumes after the start key's position even when that item has since moved.
      const keyedIndex = !startKey
        ? -1
        : input.ScanIndexForward
          ? matching.findLastIndex((value) => position(value) <= position(startKey))
          : matching.findIndex(
              (value) =>
                value.pk === startKey.pk &&
                value.sk === startKey.sk &&
                value.gsi2pk === startKey.gsi2pk &&
                value.gsi2sk === startKey.gsi2sk,
            );
      const start = Number.isFinite(legacyCursor) ? legacyCursor : Math.max(keyedIndex + 1, 0);
      const end = Math.min(start + (input.Limit ?? 100), matching.length);
      const lastEvaluatedRecord = matching[end - 1];
      return {
        items: matching.slice(start, end),
        ...(end < matching.length && lastEvaluatedRecord
          ? {
              lastEvaluatedKey: {
                gsi2pk: lastEvaluatedRecord.gsi2pk,
                gsi2sk: lastEvaluatedRecord.gsi2sk,
                pk: lastEvaluatedRecord.pk,
                sk: lastEvaluatedRecord.sk,
              },
            }
          : {}),
      } satisfies QueryRecordsResult;
    },
    transactWrite: async (operations: readonly TransactionOperation[], clientRequestToken) => {
      clientRequestTokens.push(clientRequestToken);
      transactions.push(operations);
      transactionSizes.push(operations.length);
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        if (operation.kind === "delete") {
          remove(tableName(operation.record), operation.record);
        } else {
          put(tableName(operation.record), operation.record);
        }
      }
    },
  };
  return { clientRequestTokens, database, put, queries, tables, transactions, transactionSizes };
}

function tableName(record: PlatformRecord) {
  if (record.itemType === "semantic-event" || record.itemType === "idempotency") return "events";
  if (
    record.itemType === "memory-index-job" ||
    record.itemType === "memory-flush" ||
    record.itemType === "memory-recall-attempt" ||
    record.itemType === "memory-retrieval" ||
    record.itemType === "memory-review-item"
  ) {
    return "execution";
  }
  return "control";
}
