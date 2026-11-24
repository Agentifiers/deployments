import type {
  ResolveWorkflowApprovalRequest,
  WorkflowApprovalResponse,
  WorkflowDefinitionDocumentV1,
  WorkflowExecutionSummaryResponse,
  WorkflowStepAttemptResponse,
} from "@deployments-ai/api-contract";
import { oneOf } from "../observability/range.ts";

export type ExecutionStatus = WorkflowExecutionSummaryResponse["status"];

export type ExecutionPhase = "active" | "canceling" | "terminal" | "waiting";

export const EXECUTION_PHASE: Readonly<Record<ExecutionStatus, ExecutionPhase>> = {
  canceled: "terminal",
  canceling: "canceling",
  completed: "terminal",
  failed: "terminal",
  queued: "active",
  running: "active",
  "waiting-for-agent": "waiting",
  "waiting-for-approval": "waiting",
  "waiting-for-delivery": "waiting",
  "waiting-for-tool": "waiting",
};

export const EXECUTION_STATUSES = [
  "waiting-for-approval",
  "waiting-for-agent",
  "waiting-for-tool",
  "waiting-for-delivery",
  "queued",
  "running",
  "canceling",
  "completed",
  "failed",
  "canceled",
] as const satisfies readonly ExecutionStatus[];

export const DEFINITION_STATUSES = ["active", "archived", "all"] as const;
export type DefinitionStatusFilter = (typeof DEFINITION_STATUSES)[number];

export interface DefinitionFilters {
  readonly status?: Exclude<DefinitionStatusFilter, "active">;
}

export interface ExecutionFilters {
  readonly status?: ExecutionStatus;
}

export function parseDefinitionFilters(
  search: Readonly<Record<string, unknown>>,
): DefinitionFilters {
  const status = oneOf(DEFINITION_STATUSES, search.status);
  return status === undefined || status === "active" ? {} : { status };
}

export function parseExecutionFilters(search: Readonly<Record<string, unknown>>): ExecutionFilters {
  const status = oneOf(EXECUTION_STATUSES, search.status);
  return status === undefined ? {} : { status };
}

const DEFINITION_EMPTY_TITLES: Readonly<Record<DefinitionStatusFilter, string>> = {
  active: "No active workflows",
  all: "No workflows yet",
  archived: "No archived workflows",
};

/**
 * A list's empty-state title once it shows no rows and has no page left to load. A filtered fill
 * can end empty with a cursor, so `undefined` while Load more may still find rows.
 */
export function definitionEmptyTitle(
  filters: DefinitionFilters,
  rows: number,
  hasNextPage: boolean,
): string | undefined {
  if (rows > 0 || hasNextPage) return undefined;
  return DEFINITION_EMPTY_TITLES[filters.status ?? "active"];
}

export function executionEmptyTitle(
  filters: ExecutionFilters,
  rows: number,
  hasNextPage: boolean,
): string | undefined {
  if (rows > 0 || hasNextPage) return undefined;
  return filters.status ? `No ${filters.status} executions` : "No executions yet";
}

export const CANCELABLE: Readonly<Record<ExecutionPhase, boolean>> = {
  active: true,
  canceling: false,
  terminal: false,
  waiting: true,
};

export interface ApprovalTarget {
  readonly approvalId: string;
  readonly executionId: string;
}

export interface PendingStep extends ApprovalTarget {
  readonly stepId: string;
  readonly waitingSince: string;
}

export interface PendingWorkflowApproval extends PendingStep {
  readonly prompt: string | undefined;
  readonly releaseId: string;
  readonly releaseNumber: number;
  readonly workflowName: string;
}

export interface ApprovalQueue {
  readonly complete: boolean;
  readonly items: readonly PendingWorkflowApproval[];
}

export function pendingStepOf(
  execution: Pick<WorkflowExecutionSummaryResponse, "currentStepId" | "id" | "status">,
  attempts: readonly WorkflowStepAttemptResponse[],
): PendingStep | undefined {
  if (execution.status !== "waiting-for-approval") return undefined;
  const attempt = attempts.findLast(
    (candidate) =>
      candidate.stepId === execution.currentStepId &&
      candidate.stepType === "approval" &&
      candidate.status === "waiting",
  );
  if (attempt?.approvalId === undefined) return undefined;
  return {
    approvalId: attempt.approvalId,
    executionId: execution.id,
    stepId: attempt.stepId,
    waitingSince: attempt.startedAt ?? attempt.createdAt,
  };
}

export interface ApprovalPanel {
  readonly settling: boolean;
  readonly target: PendingStep | undefined;
}

/**
 * What the execution page shows for its waiting approval. `held` is the approval whose dialog is
 * open, kept until the dialog closes even after the poll moves the execution on. `settling` is
 * true from a decision until the poll stops reporting that approval as waiting.
 */
export function approvalPanel({
  held,
  settledApprovalId,
  waiting,
}: Readonly<{
  held: PendingStep | undefined;
  settledApprovalId: string | undefined;
  waiting: PendingStep | undefined;
}>): ApprovalPanel {
  const settling = waiting !== undefined && waiting.approvalId === settledApprovalId;
  return { settling, target: held ?? (settling ? undefined : waiting) };
}

/**
 * The Approvals tab's rows. `held` is the approval whose dialog is open, kept until the dialog
 * closes even after a queue refresh stops listing it.
 */
export function approvalQueueRows(
  items: readonly PendingWorkflowApproval[],
  held: PendingWorkflowApproval | undefined,
): readonly PendingWorkflowApproval[] {
  return held === undefined || items.some((item) => item.approvalId === held.approvalId)
    ? items
    : [...items, held];
}

export function approvalPrompt(document: WorkflowDefinitionDocumentV1, stepId: string) {
  const step = document.steps.find((candidate) => candidate.id === stepId);
  return step?.type === "approval" ? step.prompt : undefined;
}

export type ApprovalDecision = ResolveWorkflowApprovalRequest["decision"];
export type ApprovalStatus = WorkflowApprovalResponse["status"];

export type ApprovalOutcome =
  | { readonly kind: "applied"; readonly status: ApprovalDecision }
  | { readonly kind: "expired" }
  | { readonly kind: "already-closed"; readonly status: Exclude<ApprovalStatus, "pending"> };

export function approvalOutcome(
  requested: ApprovalDecision,
  status: Exclude<ApprovalStatus, "pending">,
): ApprovalOutcome {
  if (status === requested) return { kind: "applied", status };
  if (status === "expired") return { kind: "expired" };
  return { kind: "already-closed", status };
}

export function describeApprovalOutcome(outcome: ApprovalOutcome): string {
  switch (outcome.kind) {
    case "already-closed":
      return `Nothing changed. The approval was already ${outcome.status}.`;
    case "applied":
      return outcome.status === "approved" ? "Approved." : "Rejected.";
    case "expired":
      return "Your decision was not applied. The approval's deadline had passed, so it closed as expired.";
  }
}

/** The editor's text and the definition version it was loaded from, captured when it opens. */
export interface DraftEdit {
  readonly expectedVersion: number;
  readonly text: string;
}

export const prettyJson = (value: unknown) => JSON.stringify(value, null, 2);

export const draftEditOf = (definition: {
  readonly draft: unknown;
  readonly version: number;
}): DraftEdit => ({
  expectedVersion: definition.version,
  text: prettyJson(definition.draft),
});

export type ParsedJsonObject =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "object"; readonly value: Readonly<Record<string, unknown>> };

export function parseJsonObject(text: string): ParsedJsonObject {
  if (text.trim() === "") return { kind: "empty" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { kind: "object", value: value as Record<string, unknown> }
    : { kind: "invalid", message: "Enter a JSON object." };
}
