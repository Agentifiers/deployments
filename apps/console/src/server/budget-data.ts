import "@tanstack/react-start/server-only";
import {
  budgetAlerts,
  budgetPage,
  budgetRow,
  governs,
  refusingBudgets,
  sameTarget,
  type Budget,
  type BudgetAlertScan,
  type BudgetPage,
  type BudgetPeriod,
  type BudgetPeriodKind,
  type BudgetRefusalScan,
  type BudgetTarget,
  type BudgetView,
} from "../budgets/budget-state.ts";
import type { EnvironmentScope } from "../scope.ts";
import { fanOut } from "./fan-out.ts";
import { API_PAGE_LIMIT, fillPage } from "./list-pages.ts";
import { callRoute, type RouteResponse } from "./platform-api.ts";

/*
 * Every budget call takes the organization ID alone and sends only the organization header:
 * a project or environment header narrows a person's token, and the API then hides
 * organization budgets and budgets on other targets.
 */

const BUDGET_PAGE_SIZE = 25;
const PERIOD_PAGE_SIZE = 24;
/** `fillPage` reads at most ten pages, so one scan covers the first thousand budgets. */
const SCANNED_BUDGETS = 10 * API_PAGE_LIMIT;

/** Every budget of the organization, newest first, archived included. */
async function listBudgets(accessToken: string, organizationId: string) {
  const page = await fillPage<Budget>(
    (cursor, limit) =>
      callRoute(
        "listBudgets",
        { query: { cursor, limit }, scope: { organizationId } },
        accessToken,
      ),
    undefined,
    SCANNED_BUDGETS,
  );
  return { budgets: page.items, complete: page.nextCursor === undefined };
}

async function currentPeriod(
  accessToken: string,
  organizationId: string,
  budgetId: string,
): Promise<BudgetPeriod | undefined> {
  const page = await callRoute(
    "listBudgetPeriods",
    { path: { id: budgetId }, query: { limit: 1 }, scope: { organizationId } },
    accessToken,
  );
  return page.items[0];
}

export async function loadBudgetPage(
  accessToken: string,
  scope: EnvironmentScope,
  view: BudgetView,
  offset: number,
): Promise<BudgetPage> {
  const { budgets, complete } = await listBudgets(accessToken, scope.organizationId);
  const { budgets: shown, ...page } = budgetPage(budgets, {
    offset,
    pageSize: BUDGET_PAGE_SIZE,
    scope,
    view,
  });
  const rows = await fanOut(shown, async (budget) =>
    budgetRow(
      budget,
      budget.status === "archived"
        ? undefined
        : await currentPeriod(accessToken, scope.organizationId, budget.id),
      scope,
    ),
  );
  return { ...page, complete, rows };
}

export function loadBudget(
  accessToken: string,
  organizationId: string,
  budgetId: string,
): Promise<Budget> {
  return callRoute("getBudget", { path: { id: budgetId }, scope: { organizationId } }, accessToken);
}

export function loadBudgetPeriods(
  accessToken: string,
  organizationId: string,
  budgetId: string,
  cursor: string | undefined,
): Promise<RouteResponse<"listBudgetPeriods">> {
  return callRoute(
    "listBudgetPeriods",
    {
      path: { id: budgetId },
      query: { cursor, limit: PERIOD_PAGE_SIZE },
      scope: { organizationId },
    },
    accessToken,
  );
}

/** The active budgets governing the environment whose current period is spent. */
export async function loadBudgetRefusals(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<BudgetRefusalScan> {
  const { budgets, complete } = await listBudgets(accessToken, scope.organizationId);
  const governing = budgets.filter(
    (budget) => budget.status === "active" && governs(budget, scope),
  );
  const entries = await fanOut(governing, async (budget) => ({
    budget,
    current: await currentPeriod(accessToken, scope.organizationId, budget.id),
  }));
  return { complete, refusals: refusingBudgets(entries, scope) };
}

/** Every live budget of the organization whose current period has crossed an alert threshold. */
export async function loadBudgetAlerts(
  accessToken: string,
  organizationId: string,
): Promise<BudgetAlertScan> {
  const { budgets, complete } = await listBudgets(accessToken, organizationId);
  const entries = await fanOut(
    budgets.filter((budget) => budget.status !== "archived"),
    async (budget) => ({
      budget,
      current: await currentPeriod(accessToken, organizationId, budget.id),
    }),
  );
  return { alerts: budgetAlerts(entries), complete };
}

/**
 * The current period of a live budget on the same target and period kind, whose spend a new
 * budget there would start from. `null` when no such budget exists, so the spend is unknown.
 */
export async function loadTargetPeriod(
  accessToken: string,
  organizationId: string,
  target: BudgetTarget,
  period: BudgetPeriodKind,
): Promise<BudgetPeriod | null> {
  const { budgets } = await listBudgets(accessToken, organizationId);
  const twin = budgets.find(
    (budget) =>
      budget.status !== "archived" && budget.period === period && sameTarget(budget, target),
  );
  return twin ? ((await currentPeriod(accessToken, organizationId, twin.id)) ?? null) : null;
}
