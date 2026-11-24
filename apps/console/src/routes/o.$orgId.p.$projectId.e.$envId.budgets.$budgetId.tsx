import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { BudgetDetail } from "../components/budgets/budget-detail.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { budgetPeriodsQuery, budgetQuery } from "../data/budget-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/budgets/$budgetId")({
  loader: ({ context, params }) => {
    const scope = { organizationId: params.orgId };
    void context.queryClient.prefetchQuery(budgetQuery(scope, params.budgetId));
    void context.queryClient.prefetchInfiniteQuery(budgetPeriodsQuery(scope, params.budgetId));
  },
  component: Budget,
});

function Budget() {
  const { budgetId, envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <BackLink href={`/o/${orgId}/p/${projectId}/e/${envId}/budgets`} label="Budgets" />
      <SectionBoundary resetKey={budgetId}>
        <BudgetDetail budgetId={budgetId} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
