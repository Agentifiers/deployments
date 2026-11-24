import { createFileRoute } from "@tanstack/react-router";
import {
  ComparisonList,
  type ComparisonFilterPatch,
} from "../components/evaluations/comparisons.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { comparisonPagesQuery, datasetDirectoryQuery } from "../data/evaluation-queries.ts";
import { agentDirectoryQuery } from "../data/observability-queries.ts";
import { parseComparisonFilters, type ComparisonFilters } from "../evaluations/filters.ts";
import type { EnvironmentScope } from "../scope.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/evaluations/comparisons/")({
  validateSearch: (search): ComparisonFilters => parseComparisonFilters(search),
  loaderDeps: ({ search }) => parseComparisonFilters(search),
  loader: ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(agentDirectoryQuery(scope));
    void context.queryClient.prefetchQuery(datasetDirectoryQuery(scope));
    void context.queryClient.prefetchInfiniteQuery(comparisonPagesQuery(scope, deps));
  },
  component: Comparisons,
});

function Comparisons() {
  const { envId, orgId, projectId } = Route.useParams();
  const filters = parseComparisonFilters(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const filter = (patch: ComparisonFilterPatch) =>
    void navigate({ search: parseComparisonFilters({ ...filters, ...patch }) });
  return (
    <SectionBoundary resetKey={JSON.stringify(filters)}>
      <ComparisonList filters={filters} onFilter={filter} scope={scope} />
    </SectionBoundary>
  );
}
