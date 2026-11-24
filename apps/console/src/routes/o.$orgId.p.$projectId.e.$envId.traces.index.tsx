import { createFileRoute } from "@tanstack/react-router";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { RangeToggle } from "../components/observability/selection-controls.tsx";
import { TraceList, type TraceFilterPatch } from "../components/observability/trace-list.tsx";
import { agentDirectoryQuery, tracePagesQuery } from "../data/observability-queries.ts";
import { parseTraceFilters, type TraceFilters } from "../observability/trace-filters.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Heading } from "@/components/ui/heading";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/traces/")({
  validateSearch: (search): Partial<TraceFilters> => parseTraceFilters(search),
  loaderDeps: ({ search }) => parseTraceFilters(search),
  loader: ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    // Not awaited: the list streams into its boundary while the header renders.
    void context.queryClient.prefetchQuery(agentDirectoryQuery(scope));
    void context.queryClient.prefetchInfiniteQuery(tracePagesQuery(scope, deps));
  },
  component: Traces,
});

function Traces() {
  const { envId, orgId, projectId } = Route.useParams();
  const filters = parseTraceFilters(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const filter = (patch: TraceFilterPatch) =>
    void navigate({ search: parseTraceFilters({ ...filters, ...patch }) });
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>Traces</Heading>
        <div className="ml-auto">
          <RangeToggle onChange={(range) => filter({ range })} value={filters.range} />
        </div>
      </div>
      <SectionBoundary resetKey={JSON.stringify(filters)}>
        <TraceList
          environmentPath={`/o/${orgId}/p/${projectId}/e/${envId}`}
          filters={filters}
          onFilter={filter}
          scope={scope}
        />
      </SectionBoundary>
    </div>
  );
}
