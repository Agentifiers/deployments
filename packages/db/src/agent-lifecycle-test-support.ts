import {
  DatabaseError,
  type DynamoDatabaseService,
  type PlatformRecord,
  type QueryRecordsResult,
  type TableName,
  type TransactionOperation,
  tableForItemType,
} from "./index.ts";
import { Effect } from "effect";
import {
  makeAgentLifecyclePersistence,
  type AdmitManifest,
  type AgentEnvironmentScope,
  type PersistenceInvocation,
} from "./index.ts";
import { validateTransactionInvariants } from "./transaction-invariants.ts";

export const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
export const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
export const OTHER_ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
export const GENERATED_IDS = [
  "01ARZ3NDEKTSV4RRFFQ69G5FB0",
  "01ARZ3NDEKTSV4RRFFQ69G5FB1",
  "01ARZ3NDEKTSV4RRFFQ69G5FB2",
  "01ARZ3NDEKTSV4RRFFQ69G5FB3",
  "01ARZ3NDEKTSV4RRFFQ69G5FB4",
  "01ARZ3NDEKTSV4RRFFQ69G5FB5",
  "01ARZ3NDEKTSV4RRFFQ69G5FB6",
  "01ARZ3NDEKTSV4RRFFQ69G5FB7",
  "01ARZ3NDEKTSV4RRFFQ69G5FB8",
  "01ARZ3NDEKTSV4RRFFQ69G5FB9",
  "01ARZ3NDEKTSV4RRFFQ69G5FC0",
  "01ARZ3NDEKTSV4RRFFQ69G5FC1",
  "01ARZ3NDEKTSV4RRFFQ69G5FC2",
  "01ARZ3NDEKTSV4RRFFQ69G5FC3",
  "01ARZ3NDEKTSV4RRFFQ69G5FC4",
  "01ARZ3NDEKTSV4RRFFQ69G5FC5",
  "01ARZ3NDEKTSV4RRFFQ69G5FC6",
  "01ARZ3NDEKTSV4RRFFQ69G5FC7",
  "01ARZ3NDEKTSV4RRFFQ69G5FC8",
  "01ARZ3NDEKTSV4RRFFQ69G5FC9",
] as const;

export const ENVIRONMENT = {
  id: ENVIRONMENT_ID,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
} as AgentEnvironmentScope;

export const admitAllManifests: AdmitManifest = async () => [];

export function manifest(keyValue = "example.assistant", name = "Example Assistant") {
  return {
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key: keyValue, name, version: "1.0.0" },
    spec: {
      capabilities: {
        tools: [
          {
            authorization: "workspace",
            name: "records.read",
            required: true,
            requiredScopes: ["records:read"],
          },
        ],
      },
      instructions: "Answer using the available records.",
      model: { id: "openrouter/default" },
      runtime: {
        toolRequests: [
          {
            effect: "read",
            idempotencyKey: "records-read",
            inputSummary: "Read records.",
            requiredScopes: ["records:read"],
            toolName: "records.read",
          },
        ],
      },
      sandbox: { mode: "none" },
    },
  } as const;
}

export function invocation<Body>(
  body: Body,
  options: {
    readonly cursor?: string;
    readonly environmentId?: string;
    readonly id?: string;
    readonly limit?: number;
  } = {},
): PersistenceInvocation<Body> {
  return {
    body,
    identity: { principalId: PRINCIPAL_ID },
    idempotencyKey: "agent-lifecycle-test",
    ...(options.id ? { id: options.id } : {}),
    query: {
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(options.limit ? { limit: options.limit } : {}),
    },
    scope: { environmentId: options.environmentId ?? ENVIRONMENT_ID },
  };
}

export function storageKey(
  table: TableName,
  keyValue: { readonly pk: string; readonly sk: string },
) {
  return `${table}\u0000${keyValue.pk}\u0000${keyValue.sk}`;
}

export function conditionalFailure(operation: string) {
  return new DatabaseError({
    cause: new Error("simulated conflict"),
    message: "Conditional write failed.",
    operation,
    reason: "conflict",
    table: "control",
  });
}

export function makeDatabase() {
  const records = new Map<string, PlatformRecord>();
  const queries: Record<string, unknown>[] = [];
  const transactionTokens: (string | undefined)[] = [];
  const transactions: TransactionOperation[][] = [];
  const tableFor = (record: PlatformRecord): TableName => tableForItemType(record.itemType);
  const lookup = (table: TableName, keyValue: { readonly pk: string; readonly sk: string }) =>
    records.get(storageKey(table, keyValue));
  const put = (record: PlatformRecord) =>
    records.set(storageKey(tableFor(record), record), structuredClone(record));

  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => {
      records.delete(storageKey(tableFor(record), record));
    },
    getRecord: async (table, keyValue) => {
      const record = lookup(table, keyValue);
      return record ? structuredClone(record) : undefined;
    },
    putRecord: async (record) => {
      put(record);
    },
    queryRecords: async (table, input) => {
      queries.push(input as Record<string, unknown>);
      const values = input.ExpressionAttributeValues as Record<string, unknown>;
      const index =
        input.IndexName === "gsi1" ? "gsi1" : input.IndexName === "gsi2" ? "gsi2" : "base";
      const pkName = index === "base" ? "pk" : `${index}pk`;
      const skName = index === "base" ? "sk" : `${index}sk`;
      const partition = values[":pk"];
      const prefixValue = values[":prefix"];
      const prefix = typeof prefixValue === "string" ? prefixValue : "";
      let matching = [...records.values()]
        .filter((record) => tableFor(record) === table)
        .filter(
          (record) =>
            (record as unknown as Readonly<Record<string, unknown>>)[pkName] === partition,
        )
        .filter((record) => {
          const value = (record as unknown as Readonly<Record<string, unknown>>)[skName];
          return typeof value === "string" && value.startsWith(prefix);
        })
        .toSorted((left, right) => {
          const leftValue = (left as unknown as Readonly<Record<string, unknown>>)[skName];
          const rightValue = (right as unknown as Readonly<Record<string, unknown>>)[skName];
          return String(leftValue).localeCompare(String(rightValue));
        });
      if (input.ScanIndexForward === false) matching = matching.toReversed();
      const startKey = input.ExclusiveStartKey as Record<string, unknown> | undefined;
      const start = startKey
        ? Math.max(
            0,
            matching.findIndex((record) => record.pk === startKey.pk && record.sk === startKey.sk) +
              1,
          )
        : 0;
      const limit = input.Limit ?? 100;
      const items = matching.slice(start, start + limit).map((record) => structuredClone(record));
      const last = items.at(-1);
      return {
        items,
        ...(last && start + items.length < matching.length
          ? {
              lastEvaluatedKey: {
                ...(index === "gsi1" ? { gsi1pk: last.gsi1pk, gsi1sk: last.gsi1sk } : {}),
                ...(index === "gsi2" ? { gsi2pk: last.gsi2pk, gsi2sk: last.gsi2sk } : {}),
                pk: last.pk,
                sk: last.sk,
              },
            }
          : {}),
      } satisfies QueryRecordsResult;
    },
    transactWrite: async (operations, clientRequestToken) => {
      await Effect.runPromise(validateTransactionInvariants(operations));
      transactionTokens.push(clientRequestToken);
      for (const operation of operations) {
        if (operation.kind === "condition-check") {
          const existing = lookup(operation.table, operation.key);
          const values = operation.expressionAttributeValues;
          const data = existing?.data as Readonly<Record<string, unknown>> | undefined;
          if (
            !existing ||
            (values?.[":active"] !== undefined && data?.status !== values[":active"]) ||
            (values?.[":zero"] !== undefined && data?.activeDeploymentCount !== values[":zero"]) ||
            (values?.[":version"] !== undefined && data?.version !== values[":version"])
          ) {
            throw conditionalFailure("condition-check");
          }
          continue;
        }
        const existing = lookup(tableFor(operation.record), operation.record);
        if (operation.kind === "put") {
          if (operation.previousRecord) {
            const existingData = existing?.data as Readonly<Record<string, unknown>> | undefined;
            const previousData = operation.previousRecord.data as Readonly<Record<string, unknown>>;
            if (!existing || existingData?.version !== previousData.version) {
              throw conditionalFailure("replace");
            }
          } else if (!operation.allowExisting && existing) {
            throw conditionalFailure("create");
          }
        } else if (!existing && !operation.allowMissing) {
          throw conditionalFailure("delete");
        }
      }
      transactions.push([...operations]);
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
  return { database, queries, records, transactionTokens, transactions };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Deterministic ULIDs: the fixed list first, then a monotonically increasing suffix. */
function testId(index: number) {
  if (index < GENERATED_IDS.length) return GENERATED_IDS[index]!;
  let suffix = "";
  for (let value = index; suffix.length < 4; value = Math.floor(value / 32)) {
    suffix = CROCKFORD[value % 32]! + suffix;
  }
  return `01ARZ3NDEKTSV4RRFFQ69H${suffix}`;
}

export function makeService(
  environments: readonly AgentEnvironmentScope[] = [ENVIRONMENT],
  admitManifest: AdmitManifest = admitAllManifests,
) {
  const store = makeDatabase();
  let nextId = 0;
  let tick = 0;
  const service = makeAgentLifecyclePersistence({
    admitManifest,
    database: store.database,
    generateId: async () => testId(nextId++),
    now: () => new Date(Date.UTC(2026, 6, 25, 12, 0, tick++)),
    resolveEnvironment: async (request) =>
      environments.find((environment) => environment.id === request.scope.environmentId),
  });
  return { service, ...store };
}
