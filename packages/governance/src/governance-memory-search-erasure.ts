import {
  MemorySearchProviderId,
  Timestamp,
  Ulid,
  type ErasureMemorySearchSummary,
  type GovernanceOperation,
} from "@deployments-ai/db";
import { Schema } from "effect";

export const MemorySearchErasureReceipt = Schema.Struct({
  operationId: Ulid,
  targets: Schema.Array(
    Schema.Struct({
      backupErasureEligibleAt: Schema.optional(Timestamp),
      componentReceipts: Schema.Array(
        Schema.Struct({
          componentId: Ulid,
          generationId: Ulid,
          providerReceipt: Schema.Struct({
            absenceVerified: Schema.Literal(true),
            receiptDigest: Schema.String,
          }),
        }),
      ),
      providerId: MemorySearchProviderId,
      targetDigest: Schema.String,
    }),
  ),
});

const MemorySearchErasureResult = Schema.Union([
  Schema.Struct({
    reason: Schema.Literals([
      "cleanup_receipts_compacting",
      "live_purge_running",
      "provider_mutations_draining",
      "target_records_compacting",
    ]),
    status: Schema.Literal("pending"),
  }),
  Schema.Struct({
    receipt: MemorySearchErasureReceipt,
    status: Schema.Literal("complete"),
  }),
]);

const strict = { onExcessProperty: "error" } as const;

export type MemorySearchErasureReceipt = typeof MemorySearchErasureReceipt.Type;
export type MemorySearchErasureResult = typeof MemorySearchErasureResult.Type;

function verifiedReceipt(
  receipt: MemorySearchErasureReceipt,
  expectedOperationId: string,
): MemorySearchErasureReceipt {
  if (receipt.operationId !== expectedOperationId) {
    throw new Error("Memory search erasure receipt does not match the governance operation.");
  }
  const targetDigests = new Set<string>();
  for (const target of receipt.targets) {
    if (!target.targetDigest || targetDigests.has(target.targetDigest)) {
      throw new Error("Memory search erasure receipt has an invalid target inventory.");
    }
    targetDigests.add(target.targetDigest);
    if (target.componentReceipts.length === 0) {
      throw new Error("Memory search erasure receipt has no component absence proof.");
    }
    const componentIds = new Set<string>();
    for (const component of target.componentReceipts) {
      if (
        componentIds.has(component.componentId) ||
        component.providerReceipt.receiptDigest.length === 0
      ) {
        throw new Error("Memory search erasure receipt has an invalid component absence proof.");
      }
      componentIds.add(component.componentId);
    }
  }
  return receipt;
}

export function decodeMemorySearchErasureReceipt(
  payload: unknown,
  expectedOperationId: string,
): MemorySearchErasureReceipt {
  return verifiedReceipt(
    Schema.decodeUnknownSync(MemorySearchErasureReceipt)(payload),
    expectedOperationId,
  );
}

export function decodeMemorySearchErasureResult(
  payload: unknown,
  expectedOperationId: string,
): MemorySearchErasureResult {
  const result = Schema.decodeUnknownSync(MemorySearchErasureResult, strict)(payload);
  if (result.status === "complete") verifiedReceipt(result.receipt, expectedOperationId);
  return result;
}

export function memorySearchErasureSummary(
  operation: GovernanceOperation,
): ErasureMemorySearchSummary | undefined {
  if (!operation.memorySearchErasureReceipt) return undefined;
  const { targets } = decodeMemorySearchErasureReceipt(
    operation.memorySearchErasureReceipt,
    operation.id,
  );
  const backupsExpireBy = targets.reduce<string | undefined>(
    (latest, { backupErasureEligibleAt }) =>
      backupErasureEligibleAt !== undefined &&
      (latest === undefined || Date.parse(backupErasureEligibleAt) > Date.parse(latest))
        ? backupErasureEligibleAt
        : latest,
    undefined,
  );
  return backupsExpireBy ? { backupsExpireBy } : undefined;
}
