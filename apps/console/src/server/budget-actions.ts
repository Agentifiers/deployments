import "@tanstack/react-start/server-only";
import { changesApplied, STATUS_AFTER, type Budget } from "../budgets/budget-state.ts";
import { PlatformApiError } from "../errors.ts";
import { callRoute } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

/** Budget calls send only the organization header; see `server/budget-data.ts`. */
export interface BudgetMutation {
  readonly accessToken: string;
  readonly idempotencyKey: string;
  readonly organizationId: string;
}

export interface BudgetChange extends BudgetMutation {
  readonly budgetId: string;
}

export function createBudget({
  accessToken,
  body,
  idempotencyKey,
  organizationId,
}: BudgetMutation & { readonly body: unknown }): Promise<Budget> {
  return callRoute(
    "createBudget",
    {
      body: decodeRequestBody("createBudget", "CreateBudgetRequest", body),
      idempotencyKey,
      scope: { organizationId },
    },
    accessToken,
  );
}

/**
 * No budget route takes an expected version, so the edit re-reads the budget and refuses when it
 * changed after the dialog opened. A change landing between this read and the PATCH still wins.
 */
export async function updateBudget({
  accessToken,
  body,
  budgetId,
  expectedVersion,
  idempotencyKey,
  organizationId,
}: BudgetChange & { readonly body: unknown; readonly expectedVersion: number }): Promise<Budget> {
  const changes = decodeRequestBody("updateBudget", "UpdateBudgetRequest", body);
  const latest = await callRoute(
    "getBudget",
    { path: { id: budgetId }, scope: { organizationId } },
    accessToken,
  );
  if (latest.version !== expectedVersion) {
    // A retried submission whose first attempt was applied finds its own write.
    if (changesApplied(latest, changes)) return latest;
    throw new PlatformApiError("updateBudget", {
      code: "budget_changed",
      detail:
        "Someone changed this budget after you opened this dialog. Close it to see the current values.",
      status: 409,
      title: "Budget changed",
    });
  }
  return callRoute(
    "updateBudget",
    { body: changes, idempotencyKey, path: { id: budgetId }, scope: { organizationId } },
    accessToken,
  );
}

export function setBudgetStatus({
  accessToken,
  budgetId,
  change,
  idempotencyKey,
  organizationId,
}: BudgetChange & { readonly change: "pause" | "resume" }): Promise<Budget> {
  return callRoute(
    "updateBudget",
    {
      body: { status: STATUS_AFTER[change] },
      idempotencyKey,
      path: { id: budgetId },
      scope: { organizationId },
    },
    accessToken,
  );
}

export function archiveBudget({
  accessToken,
  budgetId,
  idempotencyKey,
  organizationId,
}: BudgetChange): Promise<Budget> {
  return callRoute(
    "archiveBudget",
    { idempotencyKey, path: { id: budgetId }, scope: { organizationId } },
    accessToken,
  );
}
