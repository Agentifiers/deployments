import { Schema } from "effect";
import {
  DatabaseError,
  PrincipalRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type QueryRecordsResult,
  type TableName,
} from "./index.ts";

export function humanPrincipalRecord(id: string, primaryEmail: string) {
  return Schema.decodeUnknownSync(PrincipalRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-07-25T12:00:00.000Z",
        id,
        kind: "human",
        primaryEmail,
        status: "active",
        updatedAt: "2026-07-25T12:00:00.000Z",
        version: 1,
      },
      itemType: "principal" as const,
    }),
  );
}

function storageKey(table: TableName, key: { readonly pk: string; readonly sk: string }) {
  return `${table}\u0000${key.pk}\u0000${key.sk}`;
}

function conflict() {
  return new DatabaseError({
    cause: new Error("simulated conditional conflict"),
    message: "Conditional write failed.",
    operation: "transact-write",
    reason: "conflict",
    table: "control",
  });
}

/**
 * In-memory `DynamoDatabaseService` for tenancy tests: exact-key reads, partition queries with an
 * optional `:prefix` sort-key condition, `ScanIndexForward`, `Limit` and `ExclusiveStartKey`, and
 * all-or-nothing transactions that enforce create-only puts and versioned replacements.
 */
export function makeTenancyTestDatabase() {
  const records = new Map<string, PlatformRecord>();
  const tableFor = (record: PlatformRecord) => tableForItemType(record.itemType);
  const lookup = (table: TableName, key: { readonly pk: string; readonly sk: string }) =>
    records.get(storageKey(table, key));
  const put = (record: PlatformRecord) =>
    records.set(storageKey(tableFor(record), record), structuredClone(record));
  const attribute = (record: PlatformRecord, name: string) =>
    (record as unknown as Record<string, unknown>)[name];

  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => {
      records.delete(storageKey(tableFor(record), record));
    },
    getRecord: async (table, key) => {
      const record = lookup(table, key);
      return record ? structuredClone(record) : undefined;
    },
    putRecord: async (record) => {
      put(record);
    },
    queryRecords: async (table, input) => {
      const values = input.ExpressionAttributeValues as Record<string, unknown>;
      const names = input.ExpressionAttributeNames as Record<string, string> | undefined;
      const partitionName = names?.["#partition"] ?? "pk";
      const sortName = names?.["#sort"] ?? "sk";
      const partition = values[":partition"] ?? values[":pk"];
      const prefixValue = values[":prefix"];
      const prefix = typeof prefixValue === "string" ? prefixValue : "";
      const ascending = [...records.values()]
        .filter((record) => tableFor(record) === table)
        .filter(
          (record) =>
            attribute(record, partitionName) === partition &&
            String(attribute(record, sortName)).startsWith(prefix),
        )
        .toSorted((left, right) =>
          String(attribute(left, sortName)).localeCompare(String(attribute(right, sortName))),
        );
      const matching = input.ScanIndexForward === false ? ascending.toReversed() : ascending;
      const startKey = input.ExclusiveStartKey as Readonly<Record<string, unknown>> | undefined;
      const start = startKey
        ? matching.findIndex((record) => record.pk === startKey.pk && record.sk === startKey.sk) + 1
        : 0;
      const items = matching.slice(start, start + (input.Limit ?? 50));
      const last = items.at(-1);
      return {
        items: items.map((record) => structuredClone(record)),
        ...(last && start + items.length < matching.length
          ? {
              lastEvaluatedKey: {
                ...(input.IndexName
                  ? {
                      [partitionName]: attribute(last, partitionName),
                      [sortName]: attribute(last, sortName),
                    }
                  : {}),
                pk: last.pk,
                sk: last.sk,
              },
            }
          : {}),
      } satisfies QueryRecordsResult;
    },
    transactWrite: async (operations) => {
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        const existing = lookup(tableFor(operation.record), operation.record);
        if (operation.kind === "put") {
          if (operation.previousRecord) {
            const previous = operation.previousRecord.data;
            if (
              !existing ||
              !("version" in existing.data) ||
              !("version" in previous) ||
              existing.data.version !== previous.version
            ) {
              throw conflict();
            }
          } else if (!operation.allowExisting && existing) {
            throw conflict();
          }
        } else if (!existing && !operation.allowMissing) {
          throw conflict();
        }
      }
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        if (operation.kind === "delete") {
          records.delete(storageKey(tableFor(operation.record), operation.record));
        } else {
          put(operation.record);
        }
      }
    },
  };
  return { database, records };
}
