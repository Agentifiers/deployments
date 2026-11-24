import { RUNTIME_LOG_RETENTION_DAYS } from "@deployments-ai/observability";
import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import { RuntimeLogBatchRecord } from "../records/runtime-logs.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";

export type RuntimeLogBatchRecordValue = Extract<
  PlatformRecord,
  { readonly itemType: "runtime-log-batch" }
>;
type RuntimeLogBatchData = RuntimeLogBatchRecordValue["data"];

export interface RuntimeLogRunScope {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly runId: Ulid;
}

export interface RuntimeLogBatchPage {
  readonly batches: readonly RuntimeLogBatchRecordValue[];
  /** The DynamoDB key to continue after, absent once the run's batches are exhausted. */
  readonly lastEvaluatedKey?: Readonly<Record<string, unknown>>;
}

export const RUNTIME_LOG_BATCH_PREFIX = "RUNTIME-LOG-BATCH#";

/** The sort key of one batch; it orders batches by execution attempt, then batch number. */
export function runtimeLogBatchSortKey(position: {
  readonly attempt: number;
  readonly batch: number;
}) {
  return key(
    "RUNTIME-LOG-BATCH",
    String(position.attempt).padStart(8, "0"),
    String(position.batch).padStart(8, "0"),
  );
}

export function runtimeLogBatchPartition(
  scope: Pick<RuntimeLogRunScope, "organizationId" | "runId">,
) {
  return key("ORG", scope.organizationId, "RUN", scope.runId);
}

export type RuntimeLogBatchInput = Omit<RuntimeLogBatchData, "expiresAt">;

export function runtimeLogBatchRecord(input: RuntimeLogBatchInput): RuntimeLogBatchRecordValue {
  const expiresAt = new Date(
    Date.parse(input.createdAt) + RUNTIME_LOG_RETENTION_DAYS * 86_400_000,
  ).toISOString();
  return Schema.decodeUnknownSync(RuntimeLogBatchRecord)({
    ...withCanonicalRecordKeys({
      data: { ...input, expiresAt },
      itemType: "runtime-log-batch" as const,
    }),
    ttl: Math.floor(Date.parse(expiresAt) / 1_000),
  }) as RuntimeLogBatchRecordValue;
}

export function makeRuntimeLogPersistence(database: DynamoDatabaseService) {
  return {
    /**
     * Stores one batch. A batch already stored under the same attempt and batch number means a
     * retried flush, so the call succeeds without writing twice.
     */
    async appendBatch(input: RuntimeLogBatchInput): Promise<void> {
      try {
        await database.putRecord(runtimeLogBatchRecord(input));
      } catch (cause) {
        if (!isDatabaseWriteConflict(cause)) throw cause;
      }
    },
    /**
     * One page of a run's unexpired batches in execution order, starting at batch `from` when
     * given and after `exclusiveStartKey` when given. Expired batches DynamoDB TTL has not
     * removed yet are left out.
     */
    async listRunBatches(
      scope: RuntimeLogRunScope,
      options: {
        readonly exclusiveStartKey?: Readonly<Record<string, unknown>> | undefined;
        readonly from?: { readonly attempt: number; readonly batch: number } | undefined;
        readonly limit: number;
        readonly now: Date;
        readonly signal?: AbortSignal;
      },
    ): Promise<RuntimeLogBatchPage> {
      const page = await database.queryRecords(
        "execution",
        {
          ...(options.exclusiveStartKey ? { ExclusiveStartKey: options.exclusiveStartKey } : {}),
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          ...(options.from
            ? {
                ExpressionAttributeValues: {
                  ":from": runtimeLogBatchSortKey(options.from),
                  ":pk": runtimeLogBatchPartition(scope),
                  ":to": `${RUNTIME_LOG_BATCH_PREFIX}~`,
                },
                KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :from AND :to",
              }
            : {
                ExpressionAttributeValues: {
                  ":pk": runtimeLogBatchPartition(scope),
                  ":prefix": RUNTIME_LOG_BATCH_PREFIX,
                },
                KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
              }),
          Limit: options.limit,
          ScanIndexForward: true,
        },
        options.signal,
      );
      const batches = page.items.flatMap((record) => {
        if (
          record.itemType !== "runtime-log-batch" ||
          record.data.organizationId !== scope.organizationId ||
          record.data.projectId !== scope.projectId ||
          record.data.environmentId !== scope.environmentId ||
          record.data.runId !== scope.runId
        ) {
          throw new Error(`Run ${scope.runId} stores runtime logs outside its scope.`);
        }
        return Date.parse(record.data.expiresAt) > options.now.getTime() ? [record] : [];
      });
      return {
        batches,
        ...(page.lastEvaluatedKey ? { lastEvaluatedKey: page.lastEvaluatedKey } : {}),
      };
    },
  };
}

export type RuntimeLogPersistence = ReturnType<typeof makeRuntimeLogPersistence>;
