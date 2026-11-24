import type { DynamoDatabaseService } from "../client-types.ts";
import type { UsageScope } from "../usage-scope.ts";
import type { BudgetExhaustion } from "./contracts.ts";
import { budgetPeriodBounds } from "./periods.ts";
import { activeBudgetsForScope, readBudgetSpend } from "./spend.ts";

/**
 * The first active budget governing the run's workspace, environment, project, or organization
 * (in that order) whose spend for the period containing `at` has reached its amount. Paused and
 * archived budgets never refuse admission. Reads are bounded: one budget-scope index query per
 * level of the scope's chain (four with a workspace) plus one 16-shard spend read per active
 * budget.
 */
export async function findExhaustedBudget(
  database: DynamoDatabaseService,
  scope: UsageScope,
  at: Date,
): Promise<BudgetExhaustion | undefined> {
  const budgets = await activeBudgetsForScope(database, scope);
  const evaluated = await Promise.all(
    budgets.map(async (budget) => {
      const bounds = budgetPeriodBounds(budget.data.period, at);
      const spendUsdMicros = await readBudgetSpend(database, budget, bounds.periodStart);
      return { budget, ...bounds, spendUsdMicros };
    }),
  );
  return evaluated.find(
    (candidate) => candidate.spendUsdMicros >= candidate.budget.data.amountUsdMicros,
  );
}
