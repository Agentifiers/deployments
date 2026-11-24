import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type QueryCommandInput,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { Effect, Option, Random, Schedule } from "effect";
import type {
  DatabaseError,
  DynamoDatabaseService,
  QueryRecordsResult,
  RecordKey,
  TableNames,
  TransactionDelete,
  TransactionOperation,
  TransactionPut,
} from "./client-types.ts";
import { DEFAULT_TABLE_NAMES } from "./client-types.ts";
import { UNIQUE_CLAIM_CONDITION } from "./keys.ts";
import { governanceInventoryLayout } from "./governance-inventory-layout.ts";
import {
  governanceTenantDirectoryRecord,
  placeGovernanceLocatorOperations,
  withGovernanceTenantDirectory,
} from "./governance-tenant-directory.ts";
import { withMemorySearchTargetDirectory } from "./memory-search-target-directory.ts";
import {
  isOrganizationGateLane,
  isOrganizationGateSource,
  organizationGateLaneWriteCount,
  organizationGateLaneWrites,
  readOrganizationGateLanes,
} from "./organization-gate/lanes.ts";
import {
  decodePlatformRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type RecordDecodeError,
  type TableName,
} from "./records/index.ts";
import {
  readRetentionPolicy,
  retentionTtlOrganizations,
  withRetentionTtl,
} from "./retention-ttl.ts";
import {
  RUN_LOCATOR_UPSERT_CONDITION,
  canonicalizeTransactionOperation,
  databaseFailure,
  isTransientTransactionCancellation,
  recordVersion,
  transactionInvariantOperations,
  validateTransactionInvariants,
  withOrganizationErasureFences,
  withinTransactionItemLimit,
  withRecordVersionCondition,
  withStoredDataFieldsCondition,
  withStoredImmutableIdentityCondition,
} from "./transaction-invariants.ts";
import { uniqueClaimRequirements, uniqueOwnerAttributes } from "./unique-claims.ts";
import {
  capacityHolderDirectPutFailure,
  rejectUnslottedCapacityHolders,
  withCapacityClaims,
} from "./capacity/claims.ts";
import { erasureFenceFailure, withEndUserThreadIndex } from "./thread-erasure/fences.ts";
import { withInboxMailLinks } from "./thread-erasure/mail-fences.ts";
type TransactWriteItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
type RunLocator = Extract<PlatformRecord, { readonly itemType: "run-locator" }>;
const appendOnlyItemTypes = new Set<PlatformRecord["itemType"]>([
  "audit-event",
  "callback-dispatch-evidence",
  "identity-security-event",
  "immutable-audit-export",
  "installation-deployment",
  "model-invocation",
  "semantic-event",
]);
const MAX_TRANSACTION_CONFLICT_ATTEMPTS = 8;

type DatabaseFailure = DatabaseError | RecordDecodeError;

/** The Effect implementation behind {@link makeDynamoDatabase}; never exported. */
interface EffectDynamoDatabase {
  readonly deleteRecord: (
    record: PlatformRecord,
    conditionExpression?: string,
  ) => Effect.Effect<void, DatabaseFailure>;
  readonly getRecord: (
    table: TableName,
    key: RecordKey,
    consistentRead?: boolean,
  ) => Effect.Effect<Option.Option<PlatformRecord>, DatabaseFailure>;
  readonly putRecord: (
    record: PlatformRecord,
    conditionExpression?: string,
  ) => Effect.Effect<void, DatabaseFailure>;
  readonly queryRecords: (
    table: TableName,
    input: Omit<QueryCommandInput, "TableName">,
    signal?: AbortSignal,
  ) => Effect.Effect<QueryRecordsResult, DatabaseFailure>;
  readonly transactWrite: (
    operations: readonly TransactionOperation[],
    clientRequestToken?: string,
    signal?: AbortSignal,
  ) => Effect.Effect<void, DatabaseFailure>;
  readonly transactWriteForErasure: (
    operations: readonly TransactionOperation[],
    owner: { readonly operationId: string; readonly organizationId: string },
    clientRequestToken?: string,
    signal?: AbortSignal,
  ) => Effect.Effect<void, DatabaseFailure>;
}

/** Runs each operation to a Promise that rejects with the original DatabaseError or RecordDecodeError. */
function promiseDatabase(database: EffectDynamoDatabase): DynamoDatabaseService {
  return {
    deleteRecord: (...args) => Effect.runPromise(database.deleteRecord(...args)),
    getRecord: (...args) =>
      Effect.runPromise(database.getRecord(...args).pipe(Effect.map(Option.getOrUndefined))),
    putRecord: (...args) => Effect.runPromise(database.putRecord(...args)),
    queryRecords: (...args) => Effect.runPromise(database.queryRecords(...args)),
    transactWrite: (...args) => Effect.runPromise(database.transactWrite(...args)),
    transactWriteForErasure: (...args) =>
      Effect.runPromise(database.transactWriteForErasure(...args)),
  };
}

/**
 * Jittered exponential backoff: retry `n` waits 1..min(10 * 2^n, 250) ms. An aborted signal stops
 * the backoff with the abort reason instead of scheduling another attempt.
 */
function transactionConflictBackoff(signal?: AbortSignal) {
  return Schedule.recurs(MAX_TRANSACTION_CONFLICT_ATTEMPTS - 1).pipe(
    Schedule.modifyDelay((attempt) =>
      signal?.aborted
        ? Effect.fail(signal.reason)
        : Random.nextIntBetween(1, Math.min(10 * 2 ** attempt, 250)),
    ),
  );
}

/** Fails with the signal's reason once it aborts, so a pending conflict backoff stops promptly. */
function abortFailure(signal: AbortSignal) {
  return Effect.callback<never, unknown>((resume) => {
    const abort = () => resume(Effect.fail(signal.reason));
    signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });
}

function sendTransactWrite(
  client: DynamoDBDocumentClient,
  input: TransactWriteCommandInput,
  operation: string,
  table: string,
  signal?: AbortSignal,
) {
  const attempts = Effect.tryPromise({
    catch: (cause) => cause,
    try: () =>
      client.send(new TransactWriteCommand(input), signal ? { abortSignal: signal } : undefined),
  }).pipe(
    Effect.retry({
      schedule: transactionConflictBackoff(signal),
      while: isTransientTransactionCancellation,
    }),
  );
  return (signal ? Effect.raceFirst(attempts, abortFailure(signal)) : attempts).pipe(
    Effect.mapError(
      (cause) => erasureFenceFailure(input, cause) ?? databaseFailure(operation, table, cause),
    ),
  );
}

export function runLocatorRecord(record: PlatformRecord): RunLocator | undefined {
  if (record.itemType !== "run") return undefined;
  return withCanonicalRecordKeys({
    data: {
      ...(record.data.agentReleaseId === undefined
        ? {}
        : { agentReleaseId: record.data.agentReleaseId }),
      createdAt: record.data.createdAt,
      environmentId: record.data.environmentId,
      executionPurpose: record.data.executionPurpose ?? "customer",
      id: record.data.id,
      organizationId: record.data.organizationId,
      projectId: record.data.projectId,
      runPk: record.pk,
      runSk: record.sk,
      runStatus: record.data.status,
      threadId: record.data.threadId,
    },
    itemType: "run-locator" as const,
  }) as RunLocator;
}

function runLocatorPut(record: RunLocator): TransactionPut {
  return {
    allowExisting: true,
    conditionExpression: RUN_LOCATOR_UPSERT_CONDITION,
    expressionAttributeNames: {
      "#locatorData": "data",
      "#locatorItemType": "itemType",
      "#locatorRunPk": "runPk",
      "#locatorRunSk": "runSk",
    },
    expressionAttributeValues: {
      ":locatorItemType": "run-locator",
      ":locatorRunPk": record.data.runPk,
      ":locatorRunSk": record.data.runSk,
    },
    kind: "put",
    record,
  };
}

function withRunLocators(operations: readonly TransactionOperation[]) {
  return operations.flatMap((operation) => {
    const locator =
      operation.kind === "condition-check" ? undefined : runLocatorRecord(operation.record);
    if (!locator) return [operation];
    if (operation.kind === "delete") {
      return [operation, { allowMissing: true, kind: "delete" as const, record: locator }];
    }
    if (operation.kind !== "put") return [operation];
    return [operation, runLocatorPut(locator)];
  });
}

function withPersistenceCompanions(operations: readonly TransactionOperation[]) {
  return withGovernanceTenantDirectory(
    withRunLocators(
      withMemorySearchTargetDirectory(
        withInboxMailLinks(withEndUserThreadIndex(withCapacityClaims(operations))),
      ),
    ),
  );
}

function expandTransactionOperations(
  operations: readonly TransactionOperation[],
  erasureOwner?: { readonly operationId: string; readonly organizationId: string },
) {
  return Effect.forEach(
    withPersistenceCompanions(operations),
    canonicalizeTransactionOperation,
  ).pipe(
    Effect.flatMap(rejectUnslottedCapacityHolders),
    Effect.flatMap((canonicalOperations) =>
      transactionInvariantOperations(canonicalOperations, erasureOwner),
    ),
  );
}

function prepareTransactionOperations(
  operations: readonly TransactionOperation[],
  erasureOwner?: { readonly operationId: string; readonly organizationId: string },
) {
  return expandTransactionOperations(operations, erasureOwner).pipe(
    Effect.flatMap(withinTransactionItemLimit),
  );
}

/**
 * The number of DynamoDB items `transactWrite(operations)` sends once persistence companions,
 * invariant checks, and organization gate lane writes are added; a transaction fits when this is
 * at most 100. Throws the `DatabaseError` or `RecordDecodeError` that `transactWrite` would reject
 * with for invalid operations.
 */
export function transactionItemCount(operations: readonly TransactionOperation[]): number {
  return (
    Effect.runSync(expandTransactionOperations(operations)).length +
    organizationGateLaneWriteCount(operations)
  );
}

/**
 * Canonicalizes and validates transaction operations exactly as {@link makeDynamoDatabase} does
 * before sending them; in-memory database fakes use it to enforce the same invariants.
 */
export function prepareDynamoTransactionOperations(
  operations: readonly TransactionOperation[],
  erasureOwner?: { readonly operationId: string; readonly organizationId: string },
): Promise<readonly TransactionOperation[]> {
  return Effect.runPromise(prepareTransactionOperations(operations, erasureOwner));
}

function organizationGateRecordFailure(operation: "delete" | "put", table: TableName) {
  return databaseFailure(
    operation,
    table,
    "Organization gate records change only in a transaction that moves the organization's gate lanes.",
  );
}

function makeTransactWriteItem(
  operation: TransactionOperation,
  tableNames: TableNames,
): TransactWriteItem {
  const shared = {
    ...(operation.conditionExpression
      ? { ConditionExpression: operation.conditionExpression }
      : {}),
    ...(operation.expressionAttributeNames
      ? { ExpressionAttributeNames: operation.expressionAttributeNames }
      : {}),
    ...(operation.expressionAttributeValues
      ? { ExpressionAttributeValues: operation.expressionAttributeValues }
      : {}),
  };

  switch (operation.kind) {
    case "condition-check":
      return {
        ConditionCheck: {
          ...shared,
          ConditionExpression: operation.conditionExpression,
          Key: { pk: operation.key.pk, sk: operation.key.sk },
          TableName: tableNames[operation.table] ?? DEFAULT_TABLE_NAMES[operation.table],
        },
      };
    case "delete": {
      const deleteTable = tableForItemType(operation.record.itemType);
      return {
        Delete: {
          ...shared,
          Key: { pk: operation.record.pk, sk: operation.record.sk },
          TableName: tableNames[deleteTable] ?? DEFAULT_TABLE_NAMES[deleteTable],
        },
      };
    }
    case "put": {
      const table = tableForItemType(operation.record.itemType);
      return {
        Put: {
          ...shared,
          Item: operation.record,
          TableName: tableNames[table] ?? DEFAULT_TABLE_NAMES[table],
        },
      };
    }
  }
}

export function makeDynamoDatabase(
  client: DynamoDBDocumentClient,
  tableNames: TableNames = DEFAULT_TABLE_NAMES,
): DynamoDatabaseService {
  const readLanes = (organizationId: string) =>
    Effect.tryPromise({
      catch: (cause) => databaseFailure("query", "control", cause),
      try: () => readOrganizationGateLanes(client, tableNames.control, organizationId),
    });
  const readPolicies = (organizationIds: ReadonlySet<string>) =>
    Effect.forEach(
      [...organizationIds],
      (organizationId) =>
        Effect.tryPromise({
          catch: (cause) => databaseFailure("get", "control", cause),
          try: async () =>
            [
              organizationId,
              await readRetentionPolicy(client, tableNames.control, organizationId),
            ] as const,
        }),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((entries) => new Map(entries)));
  const placedTransactItems = (operations: readonly TransactionOperation[]) =>
    Effect.tryPromise({
      catch: (cause) => databaseFailure("get", "control", cause),
      try: async () => {
        const writesLocator = operations.some(
          (operation) =>
            operation.kind !== "condition-check" &&
            operation.record.itemType === "governance-tenant-record",
        );
        const layout = writesLocator
          ? await governanceInventoryLayout(client, tableNames.control)
          : "sharded";
        return placeGovernanceLocatorOperations(operations, layout).map((operation) =>
          makeTransactWriteItem(operation, tableNames),
        );
      },
    });
  const transact = (
    operations: readonly TransactionOperation[],
    clientRequestToken?: string,
    signal?: AbortSignal,
    erasureOwner?: { readonly operationId: string; readonly organizationId: string },
  ) => {
    return organizationGateLaneWrites(operations, readLanes).pipe(
      Effect.flatMap((laneWrites) => {
        const unstamped = [...operations, ...laneWrites];
        const organizationIds = retentionTtlOrganizations(unstamped);
        const prepared = prepareTransactionOperations(unstamped, erasureOwner);
        if (organizationIds.size === 0) return prepared;
        // Validated before any policy read, so an invalid transaction sends nothing.
        return prepared.pipe(
          Effect.flatMap(() => readPolicies(organizationIds)),
          Effect.flatMap((policies) =>
            prepareTransactionOperations(withRetentionTtl(unstamped, policies), erasureOwner),
          ),
        );
      }),
      Effect.flatMap(placedTransactItems),
      Effect.flatMap((transactItems) =>
        sendTransactWrite(
          client,
          {
            // Sent verbatim: request idempotency relies on DynamoDB rejecting a rebuilt retry
            // (fresh IDs or timestamps) under the same token instead of committing it again.
            ...(clientRequestToken ? { ClientRequestToken: clientRequestToken } : {}),
            TransactItems: transactItems,
          },
          "transact-write",
          "multiple",
          signal,
        ),
      ),
      Effect.asVoid,
    );
  };
  const database: EffectDynamoDatabase = {
    deleteRecord: Effect.fn("DynamoDatabase.deleteRecord")((record, conditionExpression) =>
      decodePlatformRecord(record).pipe(
        Effect.flatMap((canonicalRecord) => {
          const table = tableForItemType(canonicalRecord.itemType);
          if (appendOnlyItemTypes.has(canonicalRecord.itemType)) {
            return Effect.fail(
              databaseFailure(
                "delete",
                table,
                `${canonicalRecord.itemType} records are append-only and cannot be deleted.`,
              ),
            );
          }
          if (
            canonicalRecord.itemType === "unique-claim" ||
            uniqueClaimRequirements(canonicalRecord).length > 0
          ) {
            return Effect.fail(
              databaseFailure(
                "delete",
                table,
                "Unique claims and their owners must be deleted together in a transaction.",
              ),
            );
          }
          if (
            isOrganizationGateSource(canonicalRecord) ||
            isOrganizationGateLane(canonicalRecord)
          ) {
            return Effect.fail(organizationGateRecordFailure("delete", table));
          }
          const deleteOperation: TransactionDelete = {
            ...(conditionExpression ? { conditionExpression } : {}),
            kind: "delete",
            record: canonicalRecord,
          };
          const version = recordVersion(canonicalRecord);
          const versionedDelete =
            version === undefined
              ? deleteOperation
              : withRecordVersionCondition(deleteOperation, version);
          const conditionedDelete = withStoredDataFieldsCondition(
            withStoredImmutableIdentityCondition(versionedDelete, canonicalRecord),
            uniqueOwnerAttributes(canonicalRecord),
          );
          const tenantDelete =
            typeof (canonicalRecord.data as Readonly<Record<string, unknown>>).organizationId ===
              "string" || governanceTenantDirectoryRecord(canonicalRecord) !== undefined;
          if (canonicalRecord.itemType === "run" || tenantDelete) {
            return Effect.forEach(
              withPersistenceCompanions([conditionedDelete]),
              canonicalizeTransactionOperation,
            ).pipe(
              Effect.flatMap(validateTransactionInvariants),
              Effect.flatMap(placedTransactItems),
              Effect.flatMap((transactItems) =>
                sendTransactWrite(client, { TransactItems: transactItems }, "delete", table),
              ),
              Effect.asVoid,
            );
          }
          return Effect.tryPromise({
            catch: (cause) => databaseFailure("delete", table, cause),
            try: () =>
              client.send(
                new DeleteCommand({
                  ...(conditionedDelete.conditionExpression
                    ? {
                        ConditionExpression: conditionedDelete.conditionExpression,
                      }
                    : {}),
                  ...(conditionedDelete.expressionAttributeNames
                    ? {
                        ExpressionAttributeNames: conditionedDelete.expressionAttributeNames,
                      }
                    : {}),
                  ...(conditionedDelete.expressionAttributeValues
                    ? {
                        ExpressionAttributeValues: conditionedDelete.expressionAttributeValues,
                      }
                    : {}),
                  Key: { pk: canonicalRecord.pk, sk: canonicalRecord.sk },
                  TableName: tableNames[table] ?? DEFAULT_TABLE_NAMES[table],
                }),
              ),
          });
        }),
        Effect.asVoid,
      ),
    ),
    getRecord: Effect.fn("DynamoDatabase.getRecord")((table, key, consistentRead = true) =>
      Effect.tryPromise({
        catch: (cause) => databaseFailure("get", table, cause),
        try: () =>
          client.send(
            new GetCommand({
              ConsistentRead: consistentRead,
              Key: { pk: key.pk, sk: key.sk },
              TableName: tableNames[table] ?? DEFAULT_TABLE_NAMES[table],
            }),
          ),
      }).pipe(
        Effect.flatMap((result) =>
          result.Item === undefined
            ? Effect.succeed(Option.none())
            : decodePlatformRecord(result.Item).pipe(Effect.map(Option.some)),
        ),
      ),
    ),
    putRecord: Effect.fn("DynamoDatabase.putRecord")((record, conditionExpression) =>
      decodePlatformRecord(record).pipe(
        Effect.flatMap((canonicalRecord) => {
          const table = tableForItemType(canonicalRecord.itemType);
          if (
            canonicalRecord.itemType === "semantic-event" ||
            canonicalRecord.itemType === "identity-security-event"
          ) {
            return Effect.fail(
              databaseFailure(
                "put",
                table,
                `${canonicalRecord.itemType} records require a transactional append.`,
              ),
            );
          }
          const appendOnly = appendOnlyItemTypes.has(canonicalRecord.itemType);
          if (canonicalRecord.itemType === "unique-claim") {
            return Effect.fail(
              databaseFailure(
                "put",
                table,
                "Unique claims must be committed with their owning resource in a transaction.",
              ),
            );
          }
          if (
            isOrganizationGateSource(canonicalRecord) ||
            isOrganizationGateLane(canonicalRecord)
          ) {
            return Effect.fail(organizationGateRecordFailure("put", table));
          }
          if (uniqueClaimRequirements(canonicalRecord).length > 0) {
            return Effect.fail(
              databaseFailure(
                "put",
                table,
                "Resources with unique fields must be committed with their claims in a transaction.",
              ),
            );
          }
          const capacityFailure = capacityHolderDirectPutFailure(
            canonicalRecord,
            conditionExpression,
          );
          if (capacityFailure) return Effect.fail(capacityFailure);
          const locator = runLocatorRecord(canonicalRecord);
          if (locator) {
            const runPut: TransactionPut = {
              conditionExpression: conditionExpression ?? UNIQUE_CLAIM_CONDITION,
              kind: "put",
              record: canonicalRecord,
            };
            return Effect.forEach(
              withPersistenceCompanions([runPut]),
              canonicalizeTransactionOperation,
            ).pipe(
              Effect.flatMap(withOrganizationErasureFences),
              Effect.flatMap(placedTransactItems),
              Effect.flatMap((transactItems) =>
                sendTransactWrite(client, { TransactItems: transactItems }, "put", table),
              ),
              Effect.asVoid,
            );
          }
          if (
            typeof (canonicalRecord.data as Readonly<Record<string, unknown>>).organizationId ===
              "string" ||
            governanceTenantDirectoryRecord(canonicalRecord) !== undefined
          ) {
            const tenantPut: TransactionPut = {
              conditionExpression: appendOnly
                ? "attribute_not_exists(pk) AND attribute_not_exists(sk)"
                : conditionExpression
                  ? `(${conditionExpression}) AND (${UNIQUE_CLAIM_CONDITION})`
                  : UNIQUE_CLAIM_CONDITION,
              kind: "put",
              record: canonicalRecord,
            };
            return readPolicies(retentionTtlOrganizations([tenantPut])).pipe(
              Effect.flatMap((policies) =>
                Effect.forEach(
                  withPersistenceCompanions(withRetentionTtl([tenantPut], policies)),
                  canonicalizeTransactionOperation,
                ),
              ),
              Effect.flatMap(withOrganizationErasureFences),
              Effect.flatMap(placedTransactItems),
              Effect.flatMap((transactItems) =>
                sendTransactWrite(client, { TransactItems: transactItems }, "put", table),
              ),
              Effect.asVoid,
            );
          }
          return Effect.tryPromise({
            catch: (cause) => databaseFailure("put", table, cause),
            try: () =>
              client.send(
                new PutCommand({
                  ConditionExpression: appendOnly
                    ? `attribute_not_exists(pk) AND attribute_not_exists(sk)`
                    : conditionExpression
                      ? `(${conditionExpression}) AND (${UNIQUE_CLAIM_CONDITION})`
                      : UNIQUE_CLAIM_CONDITION,
                  Item: canonicalRecord,
                  TableName: tableNames[table] ?? DEFAULT_TABLE_NAMES[table],
                }),
              ),
          });
        }),
        Effect.asVoid,
      ),
    ),
    queryRecords: Effect.fn("DynamoDatabase.queryRecords")((table, input, signal) =>
      Effect.tryPromise({
        catch: (cause) => databaseFailure("query", table, cause),
        try: () =>
          client.send(
            new QueryCommand({
              ...input,
              TableName: tableNames[table] ?? DEFAULT_TABLE_NAMES[table],
            }),
            signal ? { abortSignal: signal } : undefined,
          ),
      }).pipe(
        Effect.flatMap((result) =>
          Effect.forEach(result.Items ?? [], decodePlatformRecord, {
            concurrency: 8,
          }).pipe(
            Effect.map((items) => ({
              items,
              ...(result.LastEvaluatedKey ? { lastEvaluatedKey: result.LastEvaluatedKey } : {}),
            })),
          ),
        ),
      ),
    ),
    transactWrite: Effect.fn("DynamoDatabase.transactWrite")((operations, token, signal) =>
      transact(operations, token, signal),
    ),
    transactWriteForErasure: Effect.fn("DynamoDatabase.transactWriteForErasure")(
      (operations, owner, token, signal) => transact(operations, token, signal, owner),
    ),
  };
  return promiseDatabase(database);
}

export function tableNamesFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): TableNames {
  const tableName = (table: TableName) =>
    environment[`DEPLOYMENTS_AI_${table.toUpperCase().replaceAll("-", "_")}_TABLE`] ?? table;
  return {
    control: tableName("control"),
    events: tableName("events"),
    execution: tableName("execution"),
    identity: tableName("identity"),
    "identity-email-outbox": tableName("identity-email-outbox"),
    usage: tableName("usage"),
  };
}
