import { Schema } from "effect";
import type { DynamoDatabaseService, RecordKey, TransactionOperation } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { PersistenceError } from "../persistence-types.ts";
import type { KeyableRecord } from "../record-keys.ts";
import type { DynamoValue } from "../record-schema.ts";
import { withCanonicalRecordKeys, type PlatformRecord, type TableName } from "../records/index.ts";
import {
  makeSemanticEventRecord,
  transactWithSemanticEvents,
  type CreateSemanticEventRecordOptions,
} from "../semantic-event-storage.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";

export interface EvaluationScope {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
}

/** Caller-built semantic event metadata; the facade supplies aggregate identity and version. */
export interface EvaluationPersistenceEvent {
  readonly actor?: CreateSemanticEventRecordOptions["actor"];
  readonly eventId: Ulid;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, DynamoValue>>;
}

export interface EvaluationPageOptions {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface EvaluationPage<Resource> {
  readonly items: readonly Resource[];
  readonly nextCursor?: string;
}

type EvaluationAggregateType =
  | "evaluation_run"
  | "regression_dataset"
  | "release_comparison"
  | "score_definition";

type RecordOf<ItemType extends PlatformRecord["itemType"]> = Extract<
  PlatformRecord,
  { readonly itemType: ItemType }
>;

const DEFAULT_EVALUATION_PAGE_LIMIT = 50;
const MAX_CURSOR_LENGTH = 8_192;
const WRITE_CONFLICT = "evaluation_write_conflict";

export function invalidInput(code: string, message: string): never {
  throw new PersistenceError("invalid-input", code, message);
}

export function conflict(code: string, message: string): never {
  throw new PersistenceError("conflict", code, message);
}

export function notFound(code: string, message: string): never {
  throw new PersistenceError("not-found", code, message);
}

/** Awaits a database promise, mapping write conflicts to a typed persistence conflict. */
export async function runDatabase<A>(operation: string, promise: Promise<A>): Promise<A> {
  try {
    return await promise;
  } catch (cause) {
    if (cause instanceof PersistenceError) throw cause;
    if (isDatabaseWriteConflict(cause)) {
      throw new PersistenceError(
        "conflict",
        WRITE_CONFLICT,
        `The evaluation ${operation} conflicted with a concurrent change; retry the request.`,
      );
    }
    throw cause;
  }
}

export function inEvaluationScope(scope: EvaluationScope, data: Readonly<Record<string, unknown>>) {
  return (
    data.organizationId === scope.organizationId &&
    data.projectId === scope.projectId &&
    data.environmentId === scope.environmentId
  );
}

/** Decodes a full record through its canonical schema after deriving canonical keys. */
export function canonicalRecord<ItemType extends PlatformRecord["itemType"]>(
  schema: Schema.Codec<RecordOf<ItemType>, unknown, never, never>,
  input: KeyableRecord & { readonly itemType: ItemType },
): RecordOf<ItemType> {
  try {
    return Schema.decodeUnknownSync(schema)(withCanonicalRecordKeys(input));
  } catch (cause) {
    if (cause instanceof PersistenceError) throw cause;
    throw new PersistenceError(
      "invalid-input",
      "invalid_evaluation_record",
      cause instanceof Error ? cause.message : `Invalid ${input.itemType} record.`,
    );
  }
}

export async function readScopedRecord<ItemType extends PlatformRecord["itemType"]>(
  database: DynamoDatabaseService,
  scope: EvaluationScope,
  table: TableName,
  key: RecordKey,
  itemType: ItemType,
): Promise<RecordOf<ItemType> | undefined> {
  const found = await runDatabase(`read ${itemType}`, database.getRecord(table, key, true));
  if (!found || found.itemType !== itemType) return undefined;
  return inEvaluationScope(scope, found.data as Readonly<Record<string, unknown>>)
    ? (found as RecordOf<ItemType>)
    : undefined;
}

export function nextRecordVersion<Resource extends PlatformRecord>(
  previous: Resource,
  next: Resource,
): Resource {
  const previousVersion = "version" in previous.data ? previous.data.version : undefined;
  const nextVersion = "version" in next.data ? next.data.version : undefined;
  if (typeof previousVersion !== "number" || nextVersion !== previousVersion + 1) {
    conflict(
      "evaluation_version_conflict",
      `${next.itemType} updates must advance the stored version by exactly one.`,
    );
  }
  return next;
}

/** Semantic event for one aggregate version written by an evaluation transaction. */
export interface EvaluationAggregateEvent {
  readonly aggregateId: Ulid;
  readonly aggregateType: EvaluationAggregateType;
  readonly aggregateVersion: number;
  readonly event: EvaluationPersistenceEvent;
}

/** The semantic event record of one evaluation aggregate version. */
function aggregateEventRecord(scope: EvaluationScope, aggregate: EvaluationAggregateEvent) {
  return makeSemanticEventRecord({
    ...scope,
    ...(aggregate.event.actor ? { actor: aggregate.event.actor } : {}),
    aggregateId: aggregate.aggregateId,
    aggregateType: aggregate.aggregateType,
    aggregateVersion: aggregate.aggregateVersion,
    eventId: aggregate.event.eventId,
    eventType: aggregate.event.eventType,
    occurredAt: aggregate.event.occurredAt,
    payload: aggregate.event.payload,
  });
}

/**
 * Commits operations with one semantic event per aggregate version they write. Every aggregate
 * version needs its event: the event store condition-checks the predecessor event, so an
 * event-less version bump makes the aggregate's next event write fail.
 */
export function commitWithEvents(
  database: DynamoDatabaseService,
  scope: EvaluationScope,
  operations: readonly TransactionOperation[],
  aggregates: readonly EvaluationAggregateEvent[],
  operation: string,
) {
  return runDatabase(
    operation,
    transactWithSemanticEvents(
      database,
      operations,
      aggregates.map((aggregate) => aggregateEventRecord(scope, aggregate)),
      aggregates[0]?.event.eventId,
    ),
  );
}

const UPDATED_AGGREGATE_TYPES = {
  "evaluation-run": "evaluation_run",
  "release-comparison": "release_comparison",
} as const satisfies Readonly<Record<string, EvaluationAggregateType>>;

/**
 * Commits the next version of an evaluation run or release comparison with its semantic event.
 * A rejected write is a retryable conflict: another writer advanced the aggregate.
 */
export async function commitAggregateUpdate<
  Resource extends RecordOf<keyof typeof UPDATED_AGGREGATE_TYPES>,
>(
  database: DynamoDatabaseService,
  scope: EvaluationScope,
  previous: Resource,
  record: Resource,
  event: EvaluationPersistenceEvent,
  operation: string,
): Promise<Resource> {
  await runDatabase(
    operation,
    transactWithSemanticEvents(
      database,
      [{ kind: "put", previousRecord: previous, record }],
      [
        aggregateEventRecord(scope, {
          aggregateId: record.data.id,
          aggregateType: UPDATED_AGGREGATE_TYPES[record.itemType],
          aggregateVersion: record.data.version,
          event,
        }),
      ],
      event.eventId,
    ),
  );
  return record;
}

/** Commits operations with at most one aggregate event; `undefined` is for non-aggregate records. */
export function commitWithEvent(
  database: DynamoDatabaseService,
  scope: EvaluationScope,
  operations: readonly TransactionOperation[],
  aggregate: EvaluationAggregateEvent | undefined,
  operation: string,
) {
  return commitWithEvents(database, scope, operations, aggregate ? [aggregate] : [], operation);
}

function encodeCursor(key: Readonly<Record<string, unknown>>) {
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}

function decodeCursor(
  cursor: string | undefined,
  expected: { readonly partitionField: string; readonly partition: string },
): Record<string, unknown> | undefined {
  if (cursor === undefined) return undefined;
  const reject = () => invalidInput("invalid_cursor", "The page cursor is invalid for this list.");
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) reject();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    reject();
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) reject();
  const value = decoded as Record<string, unknown>;
  if (
    Object.values(value).some((entry) => typeof entry !== "string") ||
    value[expected.partitionField] !== expected.partition
  ) {
    reject();
  }
  return value;
}

function pageLimit(limit: number | undefined) {
  const value = limit ?? DEFAULT_EVALUATION_PAGE_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    invalidInput("invalid_limit", "limit must be an integer from 1 through 100.");
  }
  return value;
}

export interface EvaluationCollectionQuery<ItemType extends PlatformRecord["itemType"]> {
  readonly index?: "gsi1" | "gsi2";
  readonly itemType: ItemType;
  readonly newestFirst?: boolean;
  readonly partition: string;
  /** Omit only for dedicated partitions that hold a single item type. */
  readonly prefix?: string;
  readonly table: TableName;
}

/**
 * Queries one partition (base table or GSI), optionally by sort-key prefix, and decodes a
 * scoped page. Every returned item must match the expected item type and tenant scope.
 */
export async function queryScopedPage<ItemType extends PlatformRecord["itemType"]>(
  database: DynamoDatabaseService,
  scope: EvaluationScope,
  input: EvaluationCollectionQuery<ItemType> & { readonly options: EvaluationPageOptions },
): Promise<EvaluationPage<RecordOf<ItemType>>> {
  const partitionField = input.index ? `${input.index}pk` : "pk";
  const sortField = input.index ? `${input.index}sk` : "sk";
  const exclusiveStartKey = decodeCursor(input.options.cursor, {
    partition: input.partition,
    partitionField,
  });
  const result = await runDatabase(
    `list ${input.itemType}`,
    database.queryRecords(input.table, {
      ...(input.index ? { IndexName: input.index } : { ConsistentRead: true }),
      ExpressionAttributeValues: {
        ":pk": input.partition,
        ...(input.prefix === undefined ? {} : { ":sk": input.prefix }),
      },
      KeyConditionExpression:
        input.prefix === undefined
          ? `${partitionField} = :pk`
          : `${partitionField} = :pk AND begins_with(${sortField}, :sk)`,
      Limit: pageLimit(input.options.limit),
      ScanIndexForward: input.newestFirst !== true,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }),
  );
  const items = result.items.map((record) => {
    if (
      record.itemType !== input.itemType ||
      !inEvaluationScope(scope, record.data as Readonly<Record<string, unknown>>)
    ) {
      throw new PersistenceError(
        "internal",
        "evaluation_scope_violation",
        `The ${input.itemType} collection contains an out-of-scope record.`,
      );
    }
    return record as RecordOf<ItemType>;
  });
  return {
    items,
    ...(result.lastEvaluatedKey ? { nextCursor: encodeCursor(result.lastEvaluatedKey) } : {}),
  };
}

/** Underlying index pages one filtered list request may read before it returns a partial page. */
export const MAX_FILTERED_PAGE_READS = 5;
const FILTERED_READ_LIMIT = 100;

function recordCursor(record: PlatformRecord, index: "gsi1" | "gsi2" | undefined) {
  const fields: Readonly<Record<string, unknown>> = record;
  return encodeCursor({
    pk: record.pk,
    sk: record.sk,
    ...(index
      ? { [`${index}pk`]: fields[`${index}pk`], [`${index}sk`]: fields[`${index}sk`] }
      : {}),
  });
}

/**
 * Pages a collection keeping only records that satisfy `include`. It reads at most
 * {@link MAX_FILTERED_PAGE_READS} index pages per call, so a sparse filter can return fewer
 * items than `limit` together with a `nextCursor`; the cursor resumes after the last record
 * returned or examined, and is interchangeable with the unfiltered list's cursor.
 */
export async function queryFilteredScopedPage<ItemType extends PlatformRecord["itemType"]>(
  database: DynamoDatabaseService,
  scope: EvaluationScope,
  input: EvaluationCollectionQuery<ItemType> & {
    readonly include?: (record: RecordOf<ItemType>) => boolean;
    readonly options: EvaluationPageOptions;
  },
): Promise<EvaluationPage<RecordOf<ItemType>>> {
  const { include, options, ...query } = input;
  if (!include) return queryScopedPage(database, scope, { ...query, options });
  const limit = pageLimit(options.limit);
  const items: RecordOf<ItemType>[] = [];
  let cursor = options.cursor;
  for (let read = 0; read < MAX_FILTERED_PAGE_READS; read += 1) {
    const page = await queryScopedPage(database, scope, {
      ...query,
      options: { cursor, limit: FILTERED_READ_LIMIT },
    });
    for (const [position, record] of page.items.entries()) {
      if (!include(record)) continue;
      items.push(record);
      if (items.length === limit) {
        const more = position < page.items.length - 1 || page.nextCursor !== undefined;
        return { items, ...(more ? { nextCursor: recordCursor(record, query.index) } : {}) };
      }
    }
    if (page.nextCursor === undefined) return { items };
    cursor = page.nextCursor;
  }
  return { items, ...(cursor === undefined ? {} : { nextCursor: cursor }) };
}

/** Reads every page of a bounded collection; fails when it exceeds `maximum` records. */
export async function queryAllScoped<ItemType extends PlatformRecord["itemType"]>(
  database: DynamoDatabaseService,
  scope: EvaluationScope,
  input: EvaluationCollectionQuery<ItemType>,
  maximum: number,
): Promise<readonly RecordOf<ItemType>[]> {
  const records: RecordOf<ItemType>[] = [];
  let cursor: string | undefined;
  do {
    const page = await queryScopedPage(database, scope, {
      ...input,
      options: { cursor, limit: 100 },
    });
    records.push(...page.items);
    if (records.length > maximum) {
      throw new PersistenceError(
        "unprocessable",
        "evaluation_collection_too_large",
        `The ${input.itemType} collection exceeds ${maximum} records.`,
      );
    }
    cursor = page.nextCursor;
  } while (cursor);
  return records;
}
