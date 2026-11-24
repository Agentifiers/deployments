import type { ConsoleOperation, OperationAccess } from "../access.ts";
import type { RouteResponse } from "../server/platform-api.ts";

export type AgentEmailDraft = RouteResponse<"getAgentEmailDraft">;
export type DraftStatus = AgentEmailDraft["status"];
export type DraftAction = "edit" | "submit" | "approve" | "reject" | "cancel" | "send";

interface DraftTransition {
  readonly from: readonly DraftStatus[];
  readonly operation: ConsoleOperation;
}

/** Mirrors the runtime's `transitionDraft`, `updateDraft`, and `sendDraft` preconditions. */
const DRAFT_TRANSITIONS: Readonly<Record<DraftAction, DraftTransition>> = {
  edit: { from: ["draft", "rejected"], operation: "updateAgentEmailDraft" },
  submit: { from: ["draft", "rejected"], operation: "submitAgentEmailDraft" },
  approve: { from: ["pending_approval"], operation: "approveAgentEmailDraft" },
  reject: { from: ["pending_approval"], operation: "rejectAgentEmailDraft" },
  cancel: {
    from: ["approved", "draft", "pending_approval", "rejected", "scheduled"],
    operation: "cancelAgentEmailDraft",
  },
  send: { from: ["approved"], operation: "sendAgentEmailDraft" },
};

const DRAFT_ACTION_ORDER: readonly DraftAction[] = [
  "send",
  "approve",
  "submit",
  "edit",
  "reject",
  "cancel",
];

export function draftActions(status: DraftStatus, access: OperationAccess): readonly DraftAction[] {
  return DRAFT_ACTION_ORDER.filter((action) => {
    const transition = DRAFT_TRANSITIONS[action];
    return transition.from.includes(status) && access[transition.operation];
  });
}

/** The runtime keeps a rejection's reason and `rejectedAt` through cancel; only edit and submit clear them. */
export function draftReasonLabel(draft: Pick<AgentEmailDraft, "rejectedAt">): string {
  return draft.rejectedAt === undefined ? "Failure" : "Rejection reason";
}

export const DRAFT_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "scheduled",
  "queued",
  "sent",
  "failed",
  "cancelled",
] as const satisfies readonly DraftStatus[];

export type FreshDraft<Draft> =
  | { readonly kind: "reading" }
  | { readonly kind: "failed"; readonly error: Error }
  | { readonly kind: "ready"; readonly draft: Draft };

/** The draft as re-read after the send dialog opened; a cached copy never stands in for it. */
export function freshDraft<Draft>(query: {
  readonly data: Draft | undefined;
  readonly error: Error | null;
  readonly isFetchedAfterMount: boolean;
  readonly isFetching: boolean;
}): FreshDraft<Draft> {
  if (query.isFetching || !query.isFetchedAfterMount) return { kind: "reading" };
  if (query.error !== null) return { error: query.error, kind: "failed" };
  return query.data === undefined ? { kind: "reading" } : { draft: query.data, kind: "ready" };
}
