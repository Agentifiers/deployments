import {
  DatabaseError,
  type DynamoDatabaseService,
  type ObservabilitySourceContext,
  type IdGeneratorService,
  type PlatformRecord,
  type RecordDecodeError,
  type Ulid,
  type UsageScope,
  decodePlatformRecord,
  fromDatabase,
  IdGenerationError,
  withCanonicalRecordKeys,
  meterEventFundingDimensions,
  modelUsagePersistence,
} from "@deployments-ai/db";
import type { ModelUsageLedgerEntry } from "@deployments-ai/model-gateway";
import { Effect, Schema } from "effect";
import { isDeepStrictEqual } from "node:util";

export type ModelUsageScope = UsageScope &
  (
    | {
        readonly observability: ObservabilitySourceContext;
        readonly runId: Ulid;
      }
    | { readonly operationId: Ulid; readonly operationType: string }
  );

export class ModelUsageRecordError extends Schema.TaggedErrorClass<ModelUsageRecordError>()(
  "ModelUsageRecordError",
  {
    idempotencyKey: Schema.String,
    message: Schema.String,
  },
) {}

export type ModelUsagePersistenceError =
  | DatabaseError
  | IdGenerationError
  | ModelUsageRecordError
  | RecordDecodeError;

export type ModelUsageMeterEvent = Extract<PlatformRecord, { readonly itemType: "meter-event" }>;

export interface ModelUsageRecordResult {
  readonly record: ModelUsageMeterEvent;
  readonly status: "duplicate" | "recorded";
}

export interface ModelUsageRecorderService {
  readonly record: (
    entry: ModelUsageLedgerEntry,
    scope: ModelUsageScope,
  ) => Effect.Effect<ModelUsageRecordResult, ModelUsagePersistenceError>;
  readonly recordAll: (
    entries: readonly ModelUsageLedgerEntry[],
    scope: ModelUsageScope,
  ) => Effect.Effect<readonly ModelUsageRecordResult[], ModelUsagePersistenceError>;
}

function canonicalTimestamp(value: number | string, field: string, idempotencyKey: string) {
  const milliseconds = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new ModelUsageRecordError({
      idempotencyKey,
      message: `Model usage ${field} must be a valid timestamp.`,
    });
  }

  return new Date(milliseconds).toISOString();
}

function nonEmpty(value: string, field: string, idempotencyKey: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new ModelUsageRecordError({
      idempotencyKey,
      message: `Model usage ${field} is required.`,
    });
  }
  return normalized;
}

export function modelUsageMeterEvent(
  entry: ModelUsageLedgerEntry,
  scope: ModelUsageScope,
  id: Ulid,
): Effect.Effect<ModelUsageMeterEvent, ModelUsageRecordError | RecordDecodeError> {
  return Effect.try({
    catch: (cause) =>
      cause instanceof ModelUsageRecordError
        ? cause
        : new ModelUsageRecordError({
            idempotencyKey: entry.idempotencyKey,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
    try: () => {
      const idempotencyKey = nonEmpty(entry.idempotencyKey, "idempotencyKey", entry.idempotencyKey);
      const occurredAt = canonicalTimestamp(entry.occurredAt, "occurredAt", idempotencyKey);
      const entryRunId = nonEmpty(entry.runId, "runId", idempotencyKey);
      const scopeAttributionId =
        "runId" in scope
          ? nonEmpty(scope.runId, "scope.runId", idempotencyKey)
          : nonEmpty(scope.operationId, "scope.operationId", idempotencyKey);
      if (entryRunId !== scopeAttributionId) {
        throw new ModelUsageRecordError({
          idempotencyKey,
          message: "Model usage attribution must match the persistence scope.",
        });
      }
      const startedAt =
        entry.startedAt === undefined
          ? undefined
          : canonicalTimestamp(entry.startedAt, "startedAt", idempotencyKey);

      if (!Number.isSafeInteger(entry.quantity) || entry.quantity < 0) {
        throw new ModelUsageRecordError({
          idempotencyKey,
          message: "Model usage quantity must be a non-negative safe integer.",
        });
      }
      if (
        entry.costUsdMicros !== undefined &&
        (!Number.isSafeInteger(entry.costUsdMicros) || entry.costUsdMicros < 0)
      ) {
        throw new ModelUsageRecordError({
          idempotencyKey,
          message: "Model usage costUsdMicros must be a non-negative safe integer.",
        });
      }
      if (
        entry.costUsdNanoDollars !== undefined &&
        (!Number.isSafeInteger(entry.costUsdNanoDollars) || entry.costUsdNanoDollars < 0)
      ) {
        throw new ModelUsageRecordError({
          idempotencyKey,
          message: "Model usage costUsdNanoDollars must be a non-negative safe integer.",
        });
      }
      for (const [field, value] of [
        ["inputTokens", entry.inputTokens],
        ["outputTokens", entry.outputTokens],
      ] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
          throw new ModelUsageRecordError({
            idempotencyKey,
            message: `Model usage ${field} must be a non-negative safe integer.`,
          });
        }
      }

      return withCanonicalRecordKeys({
        data: {
          dimensions: {
            ...(entry.costUsdNanoDollars === undefined
              ? {}
              : { costUsdNanoDollars: entry.costUsdNanoDollars }),
            ...(entry.costUsdMicros === undefined ? {} : { costUsdMicros: entry.costUsdMicros }),
            ...meterEventFundingDimensions(entry.payer),
            ...(entry.inputTokens === undefined ? {} : { inputTokens: entry.inputTokens }),
            modelId: nonEmpty(entry.modelId, "modelId", idempotencyKey),
            ...("operationId" in scope
              ? {
                  operationId: scope.operationId,
                  operationType: nonEmpty(
                    scope.operationType,
                    "scope.operationType",
                    idempotencyKey,
                  ),
                }
              : {}),
            provider: entry.provider,
            ...(entry.outputTokens === undefined ? {} : { outputTokens: entry.outputTokens }),
            ...(startedAt ? { startedAt } : {}),
          },
          environmentId: scope.environmentId,
          id,
          idempotencyKey,
          metric: entry.type,
          occurredAt,
          organizationId: scope.organizationId,
          ...("runId" in scope ? { observability: scope.observability } : {}),
          projectId: scope.projectId,
          quantity: entry.quantity,
          ...("runId" in scope ? { runId: scope.runId } : {}),
          source: nonEmpty(entry.source, "source", idempotencyKey),
          unit: entry.unit,
          ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
        },
        itemType: "meter-event" as const,
      });
    },
  }).pipe(
    Effect.flatMap(decodePlatformRecord),
    Effect.map((record) => record as ModelUsageMeterEvent),
  );
}

function errorName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  const name = record.name ?? record.Code ?? record.code ?? record.__type;
  return typeof name === "string" ? name : undefined;
}

function errorCause(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Readonly<Record<string, unknown>>).cause;
}

function isConditionalWriteFailure(value: unknown): boolean {
  let current: unknown = value;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (errorName(current)?.includes("ConditionalCheckFailed")) return true;
    current = errorCause(current);
  }
  return false;
}

function semanticUsageData(record: ModelUsageMeterEvent) {
  const { id: _id, ...data } = record.data;
  return data;
}

function validateDuplicate(
  existing: PlatformRecord | undefined,
  attempted: ModelUsageMeterEvent,
  cause: DatabaseError,
): Effect.Effect<ModelUsageRecordResult, DatabaseError | ModelUsageRecordError> {
  if (existing === undefined) return Effect.fail(cause);
  if (
    existing.itemType !== "meter-event" ||
    !isDeepStrictEqual(semanticUsageData(existing), semanticUsageData(attempted))
  ) {
    return Effect.fail(
      new ModelUsageRecordError({
        idempotencyKey: attempted.data.idempotencyKey,
        message: "Model usage idempotency key is already bound to a different payload.",
      }),
    );
  }

  return Effect.succeed({ record: existing, status: "duplicate" as const });
}

function duplicateResult(
  database: DynamoDatabaseService,
  attempted: ModelUsageMeterEvent,
  cause: DatabaseError,
): Effect.Effect<
  ModelUsageRecordResult,
  DatabaseError | ModelUsageRecordError | RecordDecodeError
> {
  if (!isConditionalWriteFailure(cause)) return Effect.fail(cause);

  return fromDatabase(() =>
    modelUsagePersistence.read(database, "usage", { pk: attempted.pk, sk: attempted.sk }),
  ).pipe(Effect.flatMap((existing) => validateDuplicate(existing, attempted, cause)));
}

export function makeModelUsageRecorder(
  database: DynamoDatabaseService,
  ids: IdGeneratorService,
): ModelUsageRecorderService {
  const record = Effect.fn("ModelUsageRecorder.record")((entry, scope) =>
    Effect.try({
      try: () => ids.generate(),
      catch: (cause) =>
        cause instanceof IdGenerationError
          ? cause
          : new IdGenerationError({ cause, message: "Model usage id generation failed." }),
    }).pipe(
      Effect.flatMap((id) => modelUsageMeterEvent(entry, scope, id)),
      Effect.flatMap((meterEvent) =>
        fromDatabase(() => modelUsagePersistence.write(database, meterEvent)).pipe(
          Effect.as({ record: meterEvent, status: "recorded" as const }),
          Effect.catchTag("DatabaseError", (cause) => duplicateResult(database, meterEvent, cause)),
        ),
      ),
    ),
  );

  return {
    record,
    recordAll: Effect.fn("ModelUsageRecorder.recordAll")((entries, scope) =>
      Effect.forEach(entries, (entry) => record(entry, scope), {
        concurrency: 4,
      }),
    ),
  };
}
