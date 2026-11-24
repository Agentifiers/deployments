import type { PlatformRecord, TransactionOperation, Ulid } from "@deployments-ai/db";
import { memoryProviderMutationGateKey } from "./placement.ts";

export interface MemorySearchOperationFence {
  readonly actionGeneration: number;
  readonly operationId: Ulid;
}

type Operation = Extract<PlatformRecord, { readonly itemType: "memory-search-provisioning" }>;

export function matchesMemorySearchOperationFence(
  operation: Operation,
  fence: MemorySearchOperationFence,
) {
  return (
    operation.data.id === fence.operationId &&
    operation.data.actionGeneration === fence.actionGeneration
  );
}

export function memorySearchOperationFence(operation: Operation): MemorySearchOperationFence {
  return {
    actionGeneration: operation.data.actionGeneration,
    operationId: operation.data.id,
  };
}

export function openMemoryProviderMutationGateCondition(
  organizationId: Ulid,
  targetId: Ulid,
): TransactionOperation {
  return {
    conditionExpression: "#data.#status = :open AND #itemType = :itemType",
    expressionAttributeNames: {
      "#data": "data",
      "#itemType": "itemType",
      "#status": "status",
    },
    expressionAttributeValues: {
      ":itemType": "memory-provider-mutation-gate",
      ":open": "open",
    },
    key: memoryProviderMutationGateKey(organizationId, targetId),
    kind: "condition-check",
    table: "control",
  };
}
