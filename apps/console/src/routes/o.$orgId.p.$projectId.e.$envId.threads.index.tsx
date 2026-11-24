import { createFileRoute } from "@tanstack/react-router";
import { ThreadList, type ThreadFilterPatch } from "../components/runs/thread-list.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { agentDirectoryQuery } from "../data/observability-queries.ts";
import { threadPagesQuery } from "../data/thread-queries.ts";
import { parseThreadFilters, type ThreadFilters } from "../runs/thread-filters.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Heading } from "@/components/ui/heading";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/threads/")({
  validateSearch: (search): ThreadFilters => parseThreadFilters(search),
  loaderDeps: ({ search }) => parseThreadFilters(search),
  loader: ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(agentDirectoryQuery(scope));
    void context.queryClient.prefetchInfiniteQuery(threadPagesQuery(scope, deps));
  },
  component: Threads,
});

function Threads() {
  const { envId, orgId, projectId } = Route.useParams();
  const filters = parseThreadFilters(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const filter = (patch: ThreadFilterPatch) =>
    void navigate({ resetScroll: false, search: parseThreadFilters({ ...filters, ...patch }) });
  return (
    <div className="flex flex-col gap-8">
      <Heading>Threads</Heading>
      <SectionBoundary resetKey={JSON.stringify(filters)}>
        <ThreadList filters={filters} onFilter={filter} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
