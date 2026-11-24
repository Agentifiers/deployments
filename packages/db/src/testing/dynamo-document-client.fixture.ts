import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { Effect } from "effect";
import { isDeepStrictEqual } from "node:util";
import {
  isOrganizationGateLane,
  isOrganizationGateSource,
  organizationGateLaneRepairItems,
  organizationGateSourceOrganizationId,
  organizationGateState,
  type OrganizationGateSource,
} from "../organization-gate/lanes.ts";
import { decodePlatformRecord, type PlatformRecord } from "../records/index.ts";
import { dynamoExpression, type DynamoItem } from "./dynamo-expression.fixture.ts";

export { withMemorySearchTargetDirectory } from "../memory-search-target-directory.ts";

type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

interface ExpressionInput {
  readonly ConditionExpression?: string | undefined;
  readonly ExpressionAttributeNames?: Readonly<Record<string, string>> | undefined;
  readonly ExpressionAttributeValues?: Readonly<Record<string, unknown>> | undefined;
}

interface InjectedTransactionFailure {
  readonly error: () => Error;
  readonly matches: (input: TransactWriteCommandInput) => boolean;
}

export interface FakeDynamoTransaction {
  readonly input: TransactWriteCommandInput;
  readonly outcome: "applied" | "failed" | "replayed";
}

export interface FakeDynamoDocumentClient {
  readonly client: DynamoDBDocumentClient;
  readonly delete: (tableName: string, key: { readonly pk: string; readonly sk: string }) => void;
  /** Leaves every item of the next `count` batch writes unprocessed, as throttling does. */
  readonly deferNextBatchWrites: (count: number) => void;
  /** Fails the next matching transaction server-side, after DynamoDB registered its token. */
  readonly failNextTransaction: (
    matches: (input: TransactWriteCommandInput) => boolean,
    error: () => Error,
  ) => void;
  readonly get: (
    tableName: string,
    key: { readonly pk: string; readonly sk: string },
  ) => DynamoItem | undefined;
  readonly items: (tableName: string) => DynamoItem[];
  readonly put: (tableName: string, item: object) => void;
  readonly transactions: readonly FakeDynamoTransaction[];
}

function awsError(name: string, message: string, fields: Readonly<Record<string, unknown>> = {}) {
  return Object.assign(new Error(message), { name }, fields);
}

/** Builds the cancellation DynamoDB returns when one transaction item is rejected server-side. */
export function transactionCanceledError(reasons: readonly string[]) {
  return awsError(
    "TransactionCanceledException",
    `Transaction cancelled, please refer cancellation reasons for specific reasons [${reasons.join(", ")}]`,
    { CancellationReasons: reasons.map((Code) => ({ Code })) },
  );
}

function storedCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function conditionHolds(input: ExpressionInput, item: DynamoItem | undefined) {
  if (!input.ConditionExpression) return true;
  return dynamoExpression(input.ConditionExpression, {
    ...(input.ExpressionAttributeNames ? { names: input.ExpressionAttributeNames } : {}),
    ...(input.ExpressionAttributeValues ? { values: input.ExpressionAttributeValues } : {}),
  })(item);
}

/**
 * In-memory DynamoDB document client for persistence tests. It evaluates every condition
 * expression against pre-transaction state, rejects transactions that touch one item twice, and
 * enforces ClientRequestToken idempotency: a token used with different parameters fails with
 * IdempotentParameterMismatchException whether its first request committed or was cancelled,
 * and an identical retry of a committed request succeeds without applying it again.
 */
export function fakeDynamoDocumentClient(): FakeDynamoDocumentClient {
  const tables = new Map<string, Map<string, DynamoItem>>();
  const tokens = new Map<string, { readonly committed: boolean; readonly input: TransactItem[] }>();
  const transactions: FakeDynamoTransaction[] = [];
  const injected: InjectedTransactionFailure[] = [];
  let deferredBatchWrites = 0;
  const table = (name: string) => {
    let items = tables.get(name);
    if (!items) {
      items = new Map();
      tables.set(name, items);
    }
    return items;
  };
  const itemKey = (key: Readonly<Record<string, unknown>>) =>
    `${String(key.pk)}\u0000${String(key.sk)}`;
  const getItem = (tableName: string, key: Readonly<Record<string, unknown>>) =>
    table(tableName).get(itemKey(key));

  function query(input: QueryCommand["input"]) {
    const index = input.IndexName;
    const partitionField = index ? `${index}pk` : "pk";
    const sortField = index ? `${index}sk` : "sk";
    const context = {
      ...(input.ExpressionAttributeNames ? { names: input.ExpressionAttributeNames } : {}),
      ...(input.ExpressionAttributeValues ? { values: input.ExpressionAttributeValues } : {}),
    };
    const keyCondition = dynamoExpression(input.KeyConditionExpression!, context);
    const matches = [...table(input.TableName!).values()]
      .filter((item) => item[partitionField] !== undefined)
      .filter(keyCondition)
      .toSorted((left, right) => {
        const order = String(left[sortField]).localeCompare(String(right[sortField]));
        return input.ScanIndexForward === false ? -order : order;
      });
    const start = input.ExclusiveStartKey
      ? matches.findIndex(
          (item) =>
            itemKey(item) === itemKey(input.ExclusiveStartKey as Readonly<Record<string, unknown>>),
        ) + 1
      : 0;
    const limit = input.Limit ?? matches.length;
    const page = matches.slice(start, start + limit);
    const last = page.at(-1);
    const items = input.FilterExpression
      ? page.filter(dynamoExpression(input.FilterExpression, context))
      : page;
    return {
      Count: items.length,
      Items: items.map(storedCopy),
      ScannedCount: page.length,
      ...(last && start + limit < matches.length
        ? {
            LastEvaluatedKey: {
              pk: last.pk,
              sk: last.sk,
              ...(index
                ? { [partitionField]: last[partitionField], [sortField]: last[sortField] }
                : {}),
            },
          }
        : {}),
    };
  }

  function transactWrite(input: TransactWriteCommandInput) {
    const items = input.TransactItems ?? [];
    const token = input.ClientRequestToken;
    if (token) {
      const previous = tokens.get(token);
      if (previous) {
        if (!isDeepStrictEqual(storedCopy(previous.input), storedCopy(items))) {
          throw awsError(
            "IdempotentParameterMismatchException",
            "Specified idempotent token was used with different request parameters within the idempotency window",
          );
        }
        if (previous.committed) {
          transactions.push({ input, outcome: "replayed" });
          return {};
        }
      }
    }
    const remember = (error?: unknown) => {
      if (token) tokens.set(token, { committed: !error, input: storedCopy(items) });
      transactions.push({ input, outcome: error ? "failed" : "applied" });
    };
    if (items.length === 0 || items.length > 100) {
      throw awsError("ValidationException", "Transactions require between 1 and 100 items.");
    }
    const targets = items.map((item) => {
      const operation = item.ConditionCheck ?? item.Delete ?? item.Put ?? item.Update;
      if (!operation || item.Update) throw new Error("Unsupported transaction item.");
      const key = item.Put?.Item ?? item.ConditionCheck?.Key ?? item.Delete?.Key;
      return { key: key!, operation: operation as ExpressionInput, table: operation.TableName! };
    });
    const touched = new Set(targets.map((target) => `${target.table}\u0000${itemKey(target.key)}`));
    if (touched.size !== targets.length) {
      throw awsError(
        "ValidationException",
        "Transaction request cannot include multiple operations on one item",
      );
    }
    const injectedIndex = injected.findIndex((failure) => failure.matches(input));
    if (injectedIndex >= 0) {
      const [failure] = injected.splice(injectedIndex, 1);
      const error = failure!.error();
      remember(error);
      throw error;
    }
    const reasons = targets.map((target) =>
      conditionHolds(target.operation, getItem(target.table, target.key))
        ? "None"
        : "ConditionalCheckFailed",
    );
    if (reasons.some((reason) => reason !== "None")) {
      const error = transactionCanceledError(reasons);
      remember(error);
      throw error;
    }
    for (const [index, item] of items.entries()) {
      const target = targets[index]!;
      if (item.Put) table(target.table).set(itemKey(target.key), storedCopy(item.Put.Item!));
      if (item.Delete) table(target.table).delete(itemKey(target.key));
    }
    remember();
    return {};
  }

  const client = {
    send: async (command: unknown) => {
      if (command instanceof TransactWriteCommand) return transactWrite(command.input);
      if (command instanceof GetCommand) {
        const item = getItem(command.input.TableName!, command.input.Key!);
        return item ? { Item: storedCopy(item) } : {};
      }
      if (command instanceof QueryCommand) return query(command.input);
      if (command instanceof BatchGetCommand) {
        const responses: Record<string, DynamoItem[]> = {};
        for (const [name, request] of Object.entries(command.input.RequestItems ?? {})) {
          responses[name] = (request.Keys ?? []).flatMap((key) => {
            const item = getItem(name, key);
            return item ? [storedCopy(item)] : [];
          });
        }
        return { Responses: responses, UnprocessedKeys: {} };
      }
      if (command instanceof BatchWriteCommand) {
        const requests = Object.entries(command.input.RequestItems ?? {}).flatMap(
          ([name, writes]) => writes.map((write) => ({ name, write })),
        );
        const keys = new Set(
          requests.map(
            ({ name, write }) =>
              `${name}\u0000${itemKey((write.PutRequest?.Item ?? write.DeleteRequest?.Key)!)}`,
          ),
        );
        if (requests.length === 0 || requests.length > 25 || keys.size !== requests.length) {
          throw awsError("ValidationException", "Batch writes require 1 to 25 distinct items.");
        }
        if (deferredBatchWrites > 0) {
          deferredBatchWrites -= 1;
          return { UnprocessedItems: command.input.RequestItems };
        }
        for (const { name, write } of requests) {
          if (write.PutRequest)
            table(name).set(itemKey(write.PutRequest.Item!), storedCopy(write.PutRequest.Item!));
          if (write.DeleteRequest) table(name).delete(itemKey(write.DeleteRequest.Key!));
        }
        return { UnprocessedItems: {} };
      }
      if (command instanceof PutCommand) {
        const item = command.input.Item!;
        if (!conditionHolds(command.input, getItem(command.input.TableName!, item))) {
          throw awsError("ConditionalCheckFailedException", "The conditional request failed");
        }
        table(command.input.TableName!).set(itemKey(item), storedCopy(item));
        return {};
      }
      if (command instanceof DeleteCommand) {
        const key = command.input.Key!;
        if (!conditionHolds(command.input, getItem(command.input.TableName!, key))) {
          throw awsError("ConditionalCheckFailedException", "The conditional request failed");
        }
        table(command.input.TableName!).delete(itemKey(key));
        return {};
      }
      throw new Error("Unsupported fake DynamoDB command.");
    },
  } as unknown as DynamoDBDocumentClient;

  /**
   * Items a test seeds directly stand in for data the lane reconcile has already covered, so an
   * organization's gate lanes follow every gate source seeded or removed this way.
   */
  function reconcileGateLanes(tableName: string, item: DynamoItem | undefined) {
    if (!item || !isOrganizationGateSource(item as unknown as PlatformRecord)) return;
    const gateRecords = [...table(tableName).values()].flatMap((stored) => {
      const record = stored as unknown as PlatformRecord;
      return isOrganizationGateSource(record) || isOrganizationGateLane(record)
        ? [Effect.runSync(decodePlatformRecord(stored))]
        : [];
    });
    const organizationId = organizationGateSourceOrganizationId(
      Effect.runSync(decodePlatformRecord(item)) as OrganizationGateSource,
    );
    const writes = organizationGateLaneRepairItems({
      at: new Date().toISOString(),
      controlTable: tableName,
      lanes: gateRecords
        .filter(isOrganizationGateLane)
        .filter((lane) => lane.data.organizationId === organizationId),
      organizationId,
      state: organizationGateState(organizationId, gateRecords.filter(isOrganizationGateSource)),
    });
    for (const write of writes) {
      if (write.Put) table(tableName).set(itemKey(write.Put.Item!), storedCopy(write.Put.Item!));
      if (write.Delete) table(tableName).delete(itemKey(write.Delete.Key!));
    }
  }

  return {
    client,
    delete(tableName: string, key: { readonly pk: string; readonly sk: string }) {
      const removed = getItem(tableName, key);
      table(tableName).delete(itemKey(key));
      reconcileGateLanes(tableName, removed);
    },
    deferNextBatchWrites(count: number) {
      deferredBatchWrites = count;
    },
    failNextTransaction(
      matches: (input: TransactWriteCommandInput) => boolean,
      error: () => Error,
    ) {
      injected.push({ error, matches });
    },
    get(tableName: string, key: { readonly pk: string; readonly sk: string }) {
      const item = getItem(tableName, key);
      return item ? storedCopy(item) : undefined;
    },
    items(tableName: string) {
      return [...table(tableName).values()].map(storedCopy);
    },
    put(tableName: string, item: object) {
      const stored: DynamoItem = storedCopy({ ...item });
      table(tableName).set(itemKey(stored), stored);
      reconcileGateLanes(tableName, stored);
    },
    transactions,
  };
}
