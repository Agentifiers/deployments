import { NonNegativeSafeInteger, Timestamp, Ulid } from "@deployments-ai/db";
import { Schema } from "effect";

export type ObservabilityErasurePendingReason =
  | "clickhouse_purge_running"
  | "iceberg_purge_running"
  | "pipeline_draining";

export interface ConversationErasureScope {
  readonly kind: "conversation";
  readonly runIds: readonly string[];
  readonly threadIds: readonly string[];
}

export interface ObservabilityErasureRequest {
  readonly drainAnchorAt: string;
  readonly operationId: string;
  readonly organizationId: string;
  readonly progress?: ObservabilityErasureProgress;
  readonly scope?: ConversationErasureScope;
}

interface ObservabilityErasureReceipt {
  readonly clickhouse: { readonly absenceVerifiedAt: string; readonly rowsDeleted: number };
  readonly clickhouseBackupsExpireBy: string;
  readonly iceberg: {
    readonly absenceVerifiedAt: string;
    readonly physicalRemovalBy: string;
    readonly rowsDeleted: number;
    readonly tables: readonly { readonly rowsDeleted: number; readonly table: string }[];
  };
  readonly operationId: string;
}

export type ObservabilityErasureResponse =
  | {
      readonly progress: ObservabilityErasureProgress;
      readonly reason: ObservabilityErasurePendingReason;
      readonly status: "pending";
    }
  | { readonly receipt: ObservabilityErasureReceipt; readonly status: "complete" };

const Count = NonNegativeSafeInteger;
const IsoTimestamp = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((value) =>
      Number.isFinite(Date.parse(value)) ? undefined : "Expected an ISO-8601 timestamp.",
    ),
  ),
);

export const IcebergTableStep = Schema.Literals(["count", "delete", "recount", "complete"]);
export type IcebergTableStep = typeof IcebergTableStep.Type;

export interface IcebergTableProgress {
  /**
   * Query submissions so far; part of the Athena idempotency token so a
   * re-invocation after a crash re-attaches to the same execution.
   */
  readonly attempt: number;
  readonly conflicts: number;
  readonly pendingRows: number;
  readonly queryExecutionId?: string;
  readonly rowsDeleted: number;
  readonly step: IcebergTableStep;
}

// Athena cannot OPTIMIZE S3 Tables, so the purge has no such step. Progress
// persisted while a table waited at `optimize` still decodes: that table had
// already recounted zero rows, so it resumes at a fresh recount.
const PersistedIcebergTableStep = Schema.Literals([...IcebergTableStep.literals, "optimize"]);

const PersistedIcebergTableProgress = Schema.Struct({
  attempt: Count,
  conflicts: Count,
  pendingRows: Count,
  queryExecutionId: Schema.optionalKey(Schema.String),
  rowsDeleted: Count,
  step: PersistedIcebergTableStep,
});

const ObservabilityErasureProgressSchema = Schema.Struct({
  clickhouse: Schema.Struct({
    pendingRows: Count,
    rowsDeleted: Count,
    verifiedAt: Schema.optionalKey(Timestamp),
  }),
  drainedAt: Schema.optionalKey(Timestamp),
  iceberg: Schema.Struct({
    tables: Schema.Record(Schema.String, PersistedIcebergTableProgress),
  }),
});

export interface ObservabilityErasureProgress {
  readonly clickhouse: {
    readonly pendingRows: number;
    readonly rowsDeleted: number;
    readonly verifiedAt?: string;
  };
  readonly drainedAt?: string;
  readonly iceberg: { readonly tables: Readonly<Record<string, IcebergTableProgress>> };
}

const ObservabilityErasureRequestSchema = Schema.Struct({
  drainAnchorAt: IsoTimestamp,
  operationId: Ulid,
  organizationId: Ulid,
  progress: Schema.optionalKey(ObservabilityErasureProgressSchema),
  scope: Schema.optionalKey(
    Schema.Struct({
      kind: Schema.Literal("conversation"),
      runIds: Schema.Array(Ulid),
      threadIds: Schema.Array(Ulid),
    }),
  ),
});

function resumableTableProgress(
  progress: typeof PersistedIcebergTableProgress.Type,
): IcebergTableProgress {
  if (progress.step !== "optimize") return { ...progress, step: progress.step };
  // Never re-attach to the persisted OPTIMIZE execution; the next attempt
  // number gives the recount a fresh Athena idempotency token.
  const { queryExecutionId: _optimizeExecution, ...settled } = progress;
  return { ...settled, conflicts: 0, step: "recount" };
}

export function decodeObservabilityErasureRequest(input: unknown): ObservabilityErasureRequest {
  const { progress, ...request } = Schema.decodeUnknownSync(ObservabilityErasureRequestSchema)(
    input,
    { onExcessProperty: "error" },
  );
  if (!progress) return request;
  const tables = Object.fromEntries(
    Object.entries(progress.iceberg.tables).map(([table, tableProgress]) => [
      table,
      resumableTableProgress(tableProgress),
    ]),
  );
  return { ...request, progress: { ...progress, iceberg: { tables } } };
}

export function initialObservabilityErasureProgress(): ObservabilityErasureProgress {
  return { clickhouse: { pendingRows: 0, rowsDeleted: 0 }, iceberg: { tables: {} } };
}

export function initialIcebergTableProgress(): IcebergTableProgress {
  return { attempt: 0, conflicts: 0, pendingRows: 0, rowsDeleted: 0, step: "count" };
}

/** Canonical millisecond-precision UTC timestamp accepted by the governance decoder. */
export function canonicalTimestamp(value: Date | string | number) {
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw new Error("Invalid timestamp.");
  return new Date(milliseconds).toISOString();
}
