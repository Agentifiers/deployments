import {
  DatabaseError,
  tableForItemType,
  type DynamoDatabaseService,
  type ModelCatalogEntryInput,
  type PlatformRecord,
  type QueryRecordsResult,
  type TableName,
} from "@deployments-ai/db";

export const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
export const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
export const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
export const ENVIRONMENT = {
  id: ENVIRONMENT_ID,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  status: "active",
} as const;

let sequence = 0;
/** Monotonic ULIDs so records created later sort after earlier ones. */
export async function generateId() {
  sequence += 1;
  return `01ARZ3NDEKTSV4RRFFQ69G${String(sequence).padStart(4, "0")}`;
}

function conflict(operation: string) {
  return new DatabaseError({
    cause: new Error("simulated conflict"),
    message: "Conditional write failed.",
    operation,
    reason: "conflict",
    table: "control",
  });
}

function field(record: PlatformRecord, name: string) {
  return (record as unknown as Readonly<Record<string, unknown>>)[name];
}

/**
 * Applies reads, key-prefix queries, and transactions with DynamoDB's create-only,
 * optimistic-version, and condition-check semantics over an in-memory table.
 */
export function memoryDatabase() {
  const records = new Map<string, PlatformRecord>();
  const storageKey = (table: TableName, key: { readonly pk: string; readonly sk: string }) =>
    `${table}\u0000${key.pk}\u0000${key.sk}`;
  const keyOf = (record: PlatformRecord) => storageKey(tableForItemType(record.itemType), record);
  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => {
      records.delete(keyOf(record));
    },
    getRecord: async (table, key) => structuredClone(records.get(storageKey(table, key))),
    putRecord: async (record) => {
      records.set(keyOf(record), structuredClone(record));
    },
    queryRecords: async (table, input) => {
      const values = input.ExpressionAttributeValues ?? {};
      const index = input.IndexName === "gsi1" || input.IndexName === "gsi2" ? input.IndexName : "";
      const pkName = index ? `${index}pk` : "pk";
      const skName = index ? `${index}sk` : "sk";
      const prefix = String(values[":prefix"] ?? "");
      let matching = [...records.values()]
        .filter((record) => {
          const sortKey = field(record, skName);
          return (
            tableForItemType(record.itemType) === table &&
            field(record, pkName) === values[":pk"] &&
            (typeof sortKey === "string" ? sortKey : "").startsWith(prefix)
          );
        })
        .toSorted((left, right) =>
          String(field(left, skName)).localeCompare(String(field(right, skName))),
        );
      if (input.ScanIndexForward === false) matching = matching.toReversed();
      const startKey = input.ExclusiveStartKey;
      const start = startKey
        ? matching.findIndex((record) => record.pk === startKey.pk && record.sk === startKey.sk) + 1
        : 0;
      const limit = input.Limit ?? matching.length;
      const items = matching.slice(start, start + limit);
      const last = items.at(-1);
      return {
        items: structuredClone(items),
        ...(last && start + items.length < matching.length
          ? {
              lastEvaluatedKey: {
                ...(index ? { [pkName]: field(last, pkName), [skName]: field(last, skName) } : {}),
                pk: last.pk,
                sk: last.sk,
              },
            }
          : {}),
      } satisfies QueryRecordsResult;
    },
    transactWrite: async (operations) => {
      for (const operation of operations) {
        if (operation.kind === "condition-check") {
          const existing = records.get(storageKey(operation.table, operation.key));
          const values = operation.expressionAttributeValues;
          const data = existing?.data as Readonly<Record<string, unknown>> | undefined;
          if (
            !existing ||
            (values?.[":active"] !== undefined && data?.status !== values[":active"]) ||
            (values?.[":version"] !== undefined && data?.version !== values[":version"])
          ) {
            throw conflict("condition-check");
          }
          continue;
        }
        const existing = records.get(keyOf(operation.record));
        if (operation.kind === "delete") {
          if (!existing && !operation.allowMissing) throw conflict("delete");
          continue;
        }
        const previousVersion = (
          operation.previousRecord?.data as Readonly<Record<string, unknown>> | undefined
        )?.version;
        if (operation.previousRecord) {
          if (
            (existing?.data as Readonly<Record<string, unknown>> | undefined)?.version !==
            previousVersion
          ) {
            throw conflict("replace");
          }
        } else if (existing && !operation.allowExisting) {
          throw conflict("create");
        }
      }
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        if (operation.kind === "delete") records.delete(keyOf(operation.record));
        else records.set(keyOf(operation.record), structuredClone(operation.record));
      }
    },
  };
  return { database, records };
}

export function catalogEntry(
  modelId: string,
  overrides: Partial<ModelCatalogEntryInput> = {},
): ModelCatalogEntryInput {
  const [provider, ...rest] = modelId.split("/");
  return {
    capabilities: {
      imageInput: false,
      reasoning: false,
      structuredOutputs: true,
      toolCalling: true,
    },
    contextWindowTokens: 200_000,
    displayName: rest.join("/"),
    modelId,
    pricing: { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
    provider: provider === "openai" ? "openai" : "openrouter",
    providerModelId: rest.join("/"),
    ...overrides,
  };
}
