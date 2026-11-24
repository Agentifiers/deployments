import {
  Metadata,
  NonEmptyString,
  NonNegativeSafeInteger,
  Timestamp,
  type ErasureObservabilitySummary,
  type GovernanceOperation,
  type GovernanceStore,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { GovernanceError } from "./types.ts";

const ObservabilityErasureReceipt = Schema.Struct({
  clickhouse: Schema.Struct({
    absenceVerifiedAt: Timestamp,
    rowsDeleted: NonNegativeSafeInteger,
  }),
  clickhouseBackupsExpireBy: Timestamp,
  iceberg: Schema.Struct({
    absenceVerifiedAt: Timestamp,
    physicalRemovalBy: Timestamp,
    rowsDeleted: NonNegativeSafeInteger,
    tables: Schema.Array(
      Schema.Struct({
        rowsDeleted: NonNegativeSafeInteger,
        table: NonEmptyString,
      }),
    ),
  }),
  // Must equal the governance operation ID (a ULID); verifiedReceipt enforces it.
  operationId: NonEmptyString,
});

const ObservabilityErasureResult = Schema.Union([
  Schema.Struct({
    progress: Metadata,
    reason: Schema.Literals([
      "clickhouse_purge_running",
      "iceberg_purge_running",
      "pipeline_draining",
    ]),
    status: Schema.Literal("pending"),
  }),
  Schema.Struct({
    receipt: ObservabilityErasureReceipt,
    status: Schema.Literal("complete"),
  }),
]);

const strict = { onExcessProperty: "error" } as const;

export type ObservabilityErasureReceipt = typeof ObservabilityErasureReceipt.Type;
export type ObservabilityErasureResult = typeof ObservabilityErasureResult.Type;

export interface ObservabilityErasureRequest {
  readonly drainAnchorAt: string;
  readonly operationId: string;
  readonly organizationId: string;
  readonly progress?: Readonly<Record<string, unknown>>;
  readonly scope?: {
    readonly kind: "conversation";
    readonly runIds: readonly string[];
    readonly threadIds: readonly string[];
  };
}

function verifiedReceipt(
  receipt: ObservabilityErasureReceipt,
  expectedOperationId: string,
): ObservabilityErasureReceipt {
  if (receipt.operationId !== expectedOperationId) {
    throw new Error("Observability erasure receipt does not match the governance operation.");
  }
  const tableRows = receipt.iceberg.tables.reduce((total, table) => total + table.rowsDeleted, 0);
  if (tableRows !== receipt.iceberg.rowsDeleted) {
    throw new Error("Observability erasure receipt Iceberg row counts are inconsistent.");
  }
  if (
    new Set(receipt.iceberg.tables.map((table) => table.table)).size !==
    receipt.iceberg.tables.length
  ) {
    throw new Error("Observability erasure receipt lists an Iceberg table more than once.");
  }
  return receipt;
}

export function decodeObservabilityErasureResult(
  payload: unknown,
  expectedOperationId: string,
): ObservabilityErasureResult {
  const result = Schema.decodeUnknownSync(ObservabilityErasureResult, strict)(payload);
  if (result.status === "complete") verifiedReceipt(result.receipt, expectedOperationId);
  return result;
}

export function observabilityErasureSummary(
  operation: GovernanceOperation,
): ErasureObservabilitySummary | undefined {
  if (!operation.observabilityErasureReceipt) return undefined;
  const receipt = verifiedReceipt(
    Schema.decodeUnknownSync(
      ObservabilityErasureReceipt,
      strict,
    )(operation.observabilityErasureReceipt),
    operation.id,
  );
  return {
    backupsExpireBy: receipt.clickhouseBackupsExpireBy,
    clickhouseRowsDeleted: receipt.clickhouse.rowsDeleted,
    icebergRowsDeleted: receipt.iceberg.rowsDeleted,
    physicalRemovalBy: receipt.iceberg.physicalRemovalBy,
  };
}

export async function eraseObservability(input: {
  readonly checkpoint: (operation: GovernanceOperation) => void;
  readonly now: () => Date;
  readonly operation: GovernanceOperation;
  readonly purgeObservability:
    | ((request: ObservabilityErasureRequest) => Promise<ObservabilityErasureResult>)
    | undefined;
  readonly scope?: ObservabilityErasureRequest["scope"];
  readonly store: GovernanceStore;
}) {
  const { checkpoint, now, operation, purgeObservability, scope, store } = input;
  if (!purgeObservability || operation.observabilityErasureReceipt) return;
  if (!operation.canonicalDeletedAt) {
    throw new GovernanceError(
      "erasure_checkpoint_incomplete",
      "Observability erasure requires the canonical deletion checkpoint.",
    );
  }
  const result = await purgeObservability({
    drainAnchorAt: operation.canonicalDeletedAt,
    operationId: operation.id,
    organizationId: operation.organizationId,
    ...(operation.observabilityErasureProgress
      ? { progress: operation.observabilityErasureProgress }
      : {}),
    ...(scope ? { scope } : {}),
  });
  if (result.status === "pending") {
    checkpoint(
      await store.updateOperation(
        {
          ...operation,
          observabilityErasureProgress: result.progress,
          updatedAt: now().toISOString(),
          version: operation.version + 1,
        },
        operation.version,
      ),
    );
    throw new GovernanceError(
      "observability_erasure_pending",
      `Observability erasure is waiting (${result.reason}).`,
    );
  }
  const { observabilityErasureProgress: _progress, ...withoutProgress } = operation;
  checkpoint(
    await store.updateOperation(
      {
        ...withoutProgress,
        observabilityErasureReceipt: verifiedReceipt(result.receipt, operation.id),
        updatedAt: now().toISOString(),
        version: operation.version + 1,
      },
      operation.version,
    ),
  );
}
