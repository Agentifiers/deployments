import type { GovernanceOperation, GovernanceOperationStatus } from "../governance/contracts.ts";
import type { ConversationErasureCounts, ConversationErasurePhase } from "../records/governance.ts";

interface ConversationErasureViewFields {
  readonly completedAt?: string;
  readonly counts: ConversationErasureCounts;
  readonly createdAt: string;
  readonly environmentId: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly id: string;
  readonly phase: ConversationErasurePhase;
  readonly status: GovernanceOperationStatus;
  readonly updatedAt: string;
}

export type RedactedConversationErasure = ConversationErasureViewFields &
  (
    | { readonly kind: "end-user-erasure" }
    | { readonly kind: "thread-erasure"; readonly threadId: string }
  );

function terminalError(operation: GovernanceOperation) {
  const error = operation.error;
  return operation.status === "failed" &&
    typeof error?.code === "string" &&
    typeof error.message === "string"
    ? { error: { code: error.code, message: error.message } }
    : {};
}

export function redactConversationErasure(
  operation: GovernanceOperation,
): RedactedConversationErasure | undefined {
  const state = operation.conversationErasure;
  if (!state) return undefined;
  const fields: ConversationErasureViewFields = {
    ...(operation.completedAt ? { completedAt: operation.completedAt } : {}),
    counts: state.counts,
    createdAt: operation.createdAt,
    environmentId: state.environmentId,
    ...terminalError(operation),
    id: operation.id,
    phase: state.phase,
    status: operation.status,
    updatedAt: operation.updatedAt,
  };
  if (operation.kind === "thread-erasure" && state.target.kind === "thread") {
    return { ...fields, kind: "thread-erasure", threadId: state.target.threadId };
  }
  if (operation.kind === "end-user-erasure" && state.target.kind === "end-user") {
    return { ...fields, kind: "end-user-erasure" };
  }
  return undefined;
}
