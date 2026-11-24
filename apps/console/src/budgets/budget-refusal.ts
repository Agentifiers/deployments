import type { PlatformProblem } from "../errors.ts";
import { oneOf } from "../observability/range.ts";
import {
  BUDGET_PERIOD_KINDS,
  BUDGET_SCOPE_LEVELS,
  type BudgetPeriodKind,
  type BudgetScopeLevel,
} from "./budget-state.ts";

/** The budget a `budget_exhausted` refusal names. */
export interface RefusalNotice {
  readonly budgetId: string;
  readonly name: string;
  readonly percent: number;
  readonly period: BudgetPeriodKind;
  readonly periodStart: string;
  readonly scope: BudgetScopeLevel;
}

/**
 * The refusal detail written by `packages/conversations/src/run-admission.ts`. The name is
 * user text, so the greedy capture ends at the last ID anchor; the text after the real ID is fixed.
 */
const REFUSAL_DETAIL = new RegExp(
  `^Budget "([\\s\\S]*)" \\(([0-7][0-9A-HJKMNP-TV-Z]{25})\\) for the (${BUDGET_SCOPE_LEVELS.join("|")}) ` +
    `has reached (\\d+)% of its (${BUDGET_PERIOD_KINDS.join("|")}) limit for the period starting ` +
    "([^;]+); new runs are refused",
  "u",
);

export function refusalNotice(
  problem: Pick<PlatformProblem, "code" | "detail">,
): RefusalNotice | undefined {
  if (problem.code !== "budget_exhausted" || problem.detail === undefined) return undefined;
  const match = REFUSAL_DETAIL.exec(problem.detail);
  const scope = oneOf(BUDGET_SCOPE_LEVELS, match?.[3]);
  const period = oneOf(BUDGET_PERIOD_KINDS, match?.[5]);
  if (!match || !scope || !period) return undefined;
  const [, name = "", budgetId = "", , percent = "", , periodStart = ""] = match;
  return { budgetId, name, percent: Number(percent), period, periodStart, scope };
}
