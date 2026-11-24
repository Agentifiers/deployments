import { type QueryCommandInput } from "@aws-sdk/lib-dynamodb";
import { Schema } from "effect";
import { type PlatformRecord, type TableName } from "./records/index.ts";
import type { OrganizationGateCondition } from "./organization-gate/requirements.ts";
export type TableNames = Readonly<
  Record<Exclude<TableName, "identity" | "identity-email-outbox">, string> &
    Partial<Record<Extract<TableName, "identity" | "identity-email-outbox">, string>>
>;

export interface RecordKey {
  readonly pk: string;
  readonly sk: string;
}

export interface QueryRecordsResult {
  readonly items: readonly PlatformRecord[];
  readonly lastEvaluatedKey?: Record<string, unknown>;
}

interface TransactionCondition {
  readonly conditionExpression?: string;
  readonly expressionAttributeNames?: Readonly<Record<string, string>>;
  readonly expressionAttributeValues?: Readonly<Record<string, unknown>>;
}

export type TransactionOperation =
  | ({
      readonly kind: "condition-check";
      readonly key: RecordKey;
      /**
       * Set by `organizationGateCheck`: the check reads organization-wide state that the
       * organization's gate lanes copy, so the database layer may check one lane instead.
       */
      readonly organizationGate?: OrganizationGateCondition;
      readonly table: TableName;
    } & Required<Pick<TransactionCondition, "conditionExpression">> &
      Omit<TransactionCondition, "conditionExpression">)
  | ({
      readonly allowMissing?: boolean;
      readonly kind: "delete";
      readonly record: PlatformRecord;
    } & TransactionCondition)
  | ({
      readonly allowExisting?: boolean;
      readonly kind: "put";
      readonly replaceExpired?: boolean;
      readonly previousRecord?: PlatformRecord;
      readonly record: PlatformRecord;
    } & TransactionCondition);

export type TransactionPut = Extract<TransactionOperation, { readonly kind: "put" }>;
export type TransactionDelete = Extract<TransactionOperation, { readonly kind: "delete" }>;
export type TransactionConditionCheck = Extract<
  TransactionOperation,
  { readonly kind: "condition-check" }
>;
export type UniqueClaimRecord = Extract<PlatformRecord, { readonly itemType: "unique-claim" }>;
export type UniqueClaimPut = TransactionPut & {
  readonly record: UniqueClaimRecord;
};
export type UniqueClaimDelete = TransactionDelete & {
  readonly record: UniqueClaimRecord;
};
export type SemanticEventRecord = Extract<PlatformRecord, { readonly itemType: "semantic-event" }>;

export interface CanonicalPutRecords {
  readonly previousRecord?: PlatformRecord;
  readonly record: PlatformRecord;
}

export class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()("DatabaseError", {
  cause: Schema.Unknown,
  message: Schema.String,
  operation: Schema.String,
  reason: Schema.optional(Schema.Literals(["conflict", "unknown"])),
  table: Schema.String,
}) {}

/**
 * The generic DynamoDB persistence service. Every method returns a Promise that rejects with
 * {@link DatabaseError} or `RecordDecodeError`; Effect-native callers lift calls with
 * `fromDatabase`.
 */
export interface DynamoDatabaseService {
  readonly deleteRecord: (record: PlatformRecord, conditionExpression?: string) => Promise<void>;
  readonly getRecord: (
    table: TableName,
    key: RecordKey,
    consistentRead?: boolean,
  ) => Promise<PlatformRecord | undefined>;
  readonly putRecord: (record: PlatformRecord, conditionExpression?: string) => Promise<void>;
  readonly queryRecords: (
    table: TableName,
    input: Omit<QueryCommandInput, "TableName">,
    signal?: AbortSignal,
  ) => Promise<QueryRecordsResult>;
  readonly transactWrite: (
    operations: readonly TransactionOperation[],
    clientRequestToken?: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly transactWriteForErasure?: (
    operations: readonly TransactionOperation[],
    owner: { readonly operationId: string; readonly organizationId: string },
    clientRequestToken?: string,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export const DEFAULT_TABLE_NAMES: TableNames = {
  control: "control",
  events: "events",
  execution: "execution",
  identity: "identity",
  "identity-email-outbox": "identity-email-outbox",
  usage: "usage",
};
