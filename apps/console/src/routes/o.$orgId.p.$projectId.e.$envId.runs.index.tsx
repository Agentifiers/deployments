import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { FindRuntimeId, RunFeed, type RunFeedFilterPatch } from "../components/runs/run-feed.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { agentDirectoryQuery } from "../data/observability-queries.ts";
import { runFeedPagesQuery } from "../data/runtime-queries.ts";
import { parseRunFeedFilters, type RunFeedFilters } from "../runs/filters.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Heading } from "@/components/ui/heading";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/runs/")({
  validateSearch: (search): RunFeedFilters => parseRunFeedFilters(search),
  loaderDeps: ({ search }) => parseRunFeedFilters(search),
  loader: ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(agentDirectoryQuery(scope));
    void context.queryClient.prefetchInfiniteQuery(runFeedPagesQuery(scope, deps));
  },
  component: Runs,
});

function Runs() {
  const { envId, orgId, projectId } = Route.useParams();
  const filters = parseRunFeedFilters(Route.useSearch());
  const navigate = Route.useNavigate();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const filter = (patch: RunFeedFilterPatch) =>
    void navigate({ resetScroll: false, search: parseRunFeedFilters({ ...filters, ...patch }) });
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-start gap-3">
        <Heading>Runs</Heading>
        {shell.access.getRunById && shell.access.getThread ? (
          <div className="ml-auto">
            <FindRuntimeId scope={scope} />
          </div>
        ) : null}
      </div>
      <SectionBoundary resetKey={JSON.stringify(filters)}>
        <RunFeed filters={filters} onFilter={filter} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
