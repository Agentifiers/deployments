import type {
  CreateTenantErasureRequest,
  TenantErasureResponse,
  TenantErasureSummary,
} from "@deployments-ai/api-contract/governance";
import { operationView, type OperationError } from "./operation-state.ts";

export const ERASE_PHRASE: CreateTenantErasureRequest["confirmation"] = "ERASE";

export const ERASURE_BLOCKERS = {
  tenant_artifact_uploads_pending: "Artifact uploads are still in progress.",
  tenant_brain_uploads_pending: "Brain document uploads are still in progress.",
  tenant_governance_busy: "Another governance operation is still running.",
  tenant_has_active_runs: "Agent runs are still active. Stop or let them finish.",
} as const satisfies Readonly<Record<string, string>>;

type BlockerCode = keyof typeof ERASURE_BLOCKERS;

export type ErasureBlocker =
  | { readonly kind: BlockerCode }
  | { readonly kind: "other"; readonly error: OperationError };

export type ErasureReceipt = (typeof TenantErasureSummary)["Type"];

export type ErasureState =
  | { readonly kind: "not_requested" }
  | { readonly kind: "in_progress"; readonly operationId: string; readonly startedAt?: string }
  | { readonly kind: "blocked"; readonly operationId: string; readonly blocker: ErasureBlocker }
  | {
      readonly kind: "erased";
      readonly completedAt: string;
      readonly operationId: string;
      readonly receipt?: ErasureReceipt;
    };

const isBlockerCode = (code: string): code is BlockerCode => Object.hasOwn(ERASURE_BLOCKERS, code);
export function erasureState(response: TenantErasureResponse | undefined): ErasureState {
  if (response === undefined) return { kind: "not_requested" };
  const { id: operationId, phase } = operationView(response);
  switch (phase.status) {
    case "pending":
      return { kind: "in_progress", operationId };
    case "running":
      return phase.startedAt === undefined
        ? { kind: "in_progress", operationId }
        : { kind: "in_progress", operationId, startedAt: phase.startedAt };
    case "completed":
      return response.summary === undefined
        ? { completedAt: phase.completedAt, kind: "erased", operationId }
        : {
            completedAt: phase.completedAt,
            kind: "erased",
            operationId,
            receipt: response.summary,
          };
    case "failed": {
      const { error } = phase;
      const found: ErasureBlocker = isBlockerCode(error.code)
        ? { kind: error.code }
        : { error, kind: "other" };
      return { blocker: found, kind: "blocked", operationId };
    }
    case "canceled":
      return {
        blocker: {
          error: phase.error ?? { code: "canceled", message: "The erasure was canceled." },
          kind: "other",
        },
        kind: "blocked",
        operationId,
      };
  }
}
