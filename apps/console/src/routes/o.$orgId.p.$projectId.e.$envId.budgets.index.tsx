import { createFileRoute } from "@tanstack/react-router";
import { BudgetAlertList, BudgetList } from "../components/budgets/budget-list.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { parseBudgetSearch, type BudgetSearch } from "../budgets/budget-state.ts";
import { budgetAlertsQuery, budgetPagesQuery } from "../data/budget-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/budgets/")({
  validateSearch: (search): BudgetSearch => parseBudgetSearch(search),
  loaderDeps: ({ search }) => parseBudgetSearch(search),
  loader: ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchInfiniteQuery(budgetPagesQuery(scope, deps.show ?? "applies"));
    void context.queryClient.prefetchQuery(budgetAlertsQuery(scope));
  },
  component: Budgets,
});

function Budgets() {
  const { envId, orgId, projectId } = Route.useParams();
  const view = parseBudgetSearch(Route.useSearch()).show ?? "applies";
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <SectionBoundary resetKey={`alerts-${orgId}`}>
        <BudgetAlertList scope={scope} />
      </SectionBoundary>
      <SectionBoundary resetKey={envId}>
        <BudgetList
          onView={(next) => void navigate({ search: next === "all" ? { show: next } : {} })}
          scope={scope}
          view={view}
        />
      </SectionBoundary>
    </div>
  );
}
