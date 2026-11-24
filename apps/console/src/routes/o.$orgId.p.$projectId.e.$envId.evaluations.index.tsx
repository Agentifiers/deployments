import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { DatasetList } from "../components/evaluations/datasets.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { datasetPagesQuery } from "../data/evaluation-queries.ts";
import { parseResourceFilters, type ResourceFilters } from "../evaluations/filters.ts";
import type { EnvironmentScope } from "../scope.ts";

/** The Datasets tab, the first Evaluations tab. */
// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/evaluations/")({
  validateSearch: (search): ResourceFilters => parseResourceFilters(search),
  loaderDeps: ({ search }) => parseResourceFilters(search),
  loader: ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchInfiniteQuery(datasetPagesQuery(scope, deps.status));
  },
  component: Datasets,
});

function Datasets() {
  const { envId, orgId, projectId } = Route.useParams();
  const { status } = parseResourceFilters(Route.useSearch());
  const navigate = Route.useNavigate();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  // Callers without dataset access land on the first tab they can use.
  if (!shell.access.listRegressionDatasets) {
    const to = shell.access.listScoreDefinitions
      ? "/o/$orgId/p/$projectId/e/$envId/evaluations/scorers"
      : shell.access.listEvaluationRuns
        ? "/o/$orgId/p/$projectId/e/$envId/evaluations/runs"
        : "/o/$orgId/p/$projectId/e/$envId/evaluations/comparisons";
    return <Navigate params={{ envId, orgId, projectId }} replace to={to} />;
  }
  return (
    <DatasetList
      onStatus={(next) => void navigate({ search: next ? { status: next } : {} })}
      scope={scope}
      status={status}
    />
  );
}
