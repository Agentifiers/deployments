import { createFileRoute } from "@tanstack/react-router";
import { RunList, type RunFilterPatch } from "../components/evaluations/runs.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { datasetDirectoryQuery, runPagesQuery } from "../data/evaluation-queries.ts";
import { agentDirectoryQuery } from "../data/observability-queries.ts";
import { parseRunFilters, type EvaluationRunFilters } from "../evaluations/filters.ts";
import type { EnvironmentScope } from "../scope.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/evaluations/runs/")({
  validateSearch: (search): EvaluationRunFilters => parseRunFilters(search),
  loaderDeps: ({ search }) => parseRunFilters(search),
  loader: ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(agentDirectoryQuery(scope));
    void context.queryClient.prefetchQuery(datasetDirectoryQuery(scope));
    void context.queryClient.prefetchInfiniteQuery(runPagesQuery(scope, deps));
  },
  component: Runs,
});

function Runs() {
  const { envId, orgId, projectId } = Route.useParams();
  const filters = parseRunFilters(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const filter = (patch: RunFilterPatch) =>
    void navigate({ search: parseRunFilters({ ...filters, ...patch }) });
  return (
    <SectionBoundary resetKey={JSON.stringify(filters)}>
      <RunList filters={filters} onFilter={filter} scope={scope} />
    </SectionBoundary>
  );
}
