import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import {
  BUDGET_PERIOD_KINDS,
  BUDGET_VIEWS,
  type BudgetPeriodKind,
  type BudgetTarget,
  type BudgetView,
} from "../budgets/budget-state.ts";
import { oneOf } from "../observability/range.ts";
import { SCOPE_FIELDS, type EnvironmentScope } from "../scope.ts";
import {
  loadBudget,
  loadBudgetAlerts,
  loadBudgetPage,
  loadBudgetPeriods,
  loadBudgetRefusals,
  loadTargetPeriod,
} from "../server/budget-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { STATUS_REFRESH_MS } from "./refresh.ts";
import {
  fields,
  pageInputAt,
  requireIds,
  scopedInput,
  type PageInputAt,
  type ScopeAt,
  type ScopedInput,
} from "./server-input.ts";

interface BudgetInput extends PageInputAt<"organization"> {
  readonly budgetId: string;
}

const fetchBudgetPage = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly offset: number; readonly view: BudgetView }) => {
    const { offset, view } = fields(input);
    const known = oneOf(BUDGET_VIEWS, view);
    if (known === undefined) {
      throw new TypeError(`view must be one of ${BUDGET_VIEWS.join(", ")}.`);
    }
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError("offset must be a non-negative integer.");
    }
    return { ...scopedInput(input), offset, view: known };
  })
  .handler(async ({ data }) =>
    loadBudgetPage(await requireAccessToken(), data.scope, data.view, data.offset),
  );

const fetchBudget = createServerFn({ method: "GET" })
  .validator((input: BudgetInput) => ({
    ...pageInputAt("organization", input),
    ...requireIds(input, ["budgetId"]),
  }))
  .handler(async ({ data }) =>
    loadBudget(await requireAccessToken(), data.scope.organizationId, data.budgetId),
  );

const fetchBudgetPeriods = createServerFn({ method: "GET" })
  .validator((input: BudgetInput) => ({
    ...pageInputAt("organization", input),
    ...requireIds(input, ["budgetId"]),
  }))
  .handler(async ({ data }) =>
    loadBudgetPeriods(
      await requireAccessToken(),
      data.scope.organizationId,
      data.budgetId,
      data.cursor,
    ),
  );

const fetchBudgetAlerts = createServerFn({ method: "GET" })
  .validator((input: ScopeAt<"organization">) => requireIds(input, ["organizationId"]))
  .handler(async ({ data }) => loadBudgetAlerts(await requireAccessToken(), data.organizationId));

const fetchBudgetRefusals = createServerFn({ method: "GET" })
  .validator((input: EnvironmentScope) => requireIds(input, SCOPE_FIELDS))
  .handler(async ({ data }) => loadBudgetRefusals(await requireAccessToken(), data));

function requireTarget(input: unknown): BudgetTarget {
  const target = fields(input);
  switch (target.scope) {
    case "organization":
      return { scope: "organization" };
    case "project":
      return { ...requireIds(target, ["projectId"]), scope: "project" };
    case "environment":
      return { ...requireIds(target, ["environmentId", "projectId"]), scope: "environment" };
    case "workspace":
      return {
        ...requireIds(target, ["environmentId", "projectId", "workspaceId"]),
        scope: "workspace",
      };
    default:
      throw new TypeError("target.scope must be organization, project, environment, or workspace.");
  }
}

const fetchTargetPeriod = createServerFn({ method: "GET" })
  .validator(
    (
      input: PageInputAt<"organization"> & {
        readonly period: BudgetPeriodKind;
        readonly target: BudgetTarget;
      },
    ) => {
      const period = oneOf(BUDGET_PERIOD_KINDS, fields(input).period);
      if (!period) throw new TypeError("period must be daily, monthly, quarterly, or yearly.");
      return {
        ...pageInputAt("organization", input),
        period,
        target: requireTarget(fields(input).target),
      };
    },
  )
  .handler(async ({ data }) =>
    loadTargetPeriod(
      await requireAccessToken(),
      data.scope.organizationId,
      data.target,
      data.period,
    ),
  );

/** Every budget query key starts here, so one invalidation after a change refreshes them all. */
const budgetsKey = (organizationId: string) => ["budgets", organizationId] as const;

export function invalidateBudgets(queryClient: QueryClient, organizationId: string) {
  return queryClient.invalidateQueries({ queryKey: budgetsKey(organizationId) });
}

export const budgetPagesQuery = (scope: EnvironmentScope, view: BudgetView) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) => fetchBudgetPage({ data: { offset: pageParam, scope, view } }),
    getNextPageParam: (page) => page.nextOffset,
    initialPageParam: 0,
    queryKey: [
      ...budgetsKey(scope.organizationId),
      "list",
      scope.projectId,
      scope.environmentId,
      view,
    ],
  });

export const budgetQuery = (scope: ScopeAt<"organization">, budgetId: string) =>
  queryOptions({
    queryFn: () =>
      fetchBudget({ data: { budgetId, scope: { organizationId: scope.organizationId } } }),
    queryKey: [...budgetsKey(scope.organizationId), "budget", budgetId],
  });

export const budgetPeriodsQuery = (scope: ScopeAt<"organization">, budgetId: string) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchBudgetPeriods({
        data: {
          budgetId,
          scope: { organizationId: scope.organizationId },
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
      }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...budgetsKey(scope.organizationId), "periods", budgetId],
  });

export const budgetAlertsQuery = (scope: ScopeAt<"organization">) =>
  queryOptions({
    queryFn: () => fetchBudgetAlerts({ data: { organizationId: scope.organizationId } }),
    queryKey: [...budgetsKey(scope.organizationId), "alerts"],
    refetchInterval: STATUS_REFRESH_MS,
  });

export const budgetRefusalsQuery = (scope: EnvironmentScope) =>
  queryOptions({
    queryFn: () => fetchBudgetRefusals({ data: scope }),
    queryKey: [
      ...budgetsKey(scope.organizationId),
      "refusals",
      scope.projectId,
      scope.environmentId,
    ],
    refetchInterval: STATUS_REFRESH_MS,
  });

/** The current period a new budget on `target` would start from, when another budget shows it. */
export const targetPeriodQuery = (
  scope: ScopeAt<"organization">,
  target: BudgetTarget,
  period: BudgetPeriodKind,
) =>
  queryOptions({
    queryFn: () =>
      fetchTargetPeriod({
        data: { period, scope: { organizationId: scope.organizationId }, target },
      }),
    queryKey: [...budgetsKey(scope.organizationId), "target-period", target, period],
  });
