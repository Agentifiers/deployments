import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AgentRuns, type RunFilterPatch } from "../components/agents/runtime/agent-runs.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { agentDetailQuery } from "../data/agent-queries.ts";
import { agentRunPagesQuery } from "../data/agent-runtime-queries.ts";
import { parseRunFilters, type RunFilters } from "../runs/filters.ts";
import { environmentPath, type EnvironmentScope } from "../scope.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/agents/$definitionId/runs")({
  validateSearch: (search): RunFilters => parseRunFilters(search),
  loaderDeps: ({ search }) => parseRunFilters(search),
  loader: async ({ context, deps, params }) => {
    const scope: EnvironmentScope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const agent = await context.queryClient.ensureQueryData(
      agentDetailQuery(scope, params.definitionId),
    );
    // Not awaited: the list streams into its boundary.
    void context.queryClient.prefetchInfiniteQuery(
      agentRunPagesQuery(
        scope,
        params.definitionId,
        agent.deployments.map((deployment) => deployment.id),
        deps,
      ),
    );
  },
  component: RunsTab,
});

function RunsTab() {
  const { definitionId, envId, orgId, projectId } = Route.useParams();
  const filters = parseRunFilters(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const { data: agent } = useSuspenseQuery(agentDetailQuery(scope, definitionId));
  const filter = (patch: RunFilterPatch) =>
    void navigate({ resetScroll: false, search: parseRunFilters({ ...filters, ...patch }) });
  return (
    <SectionBoundary resetKey={JSON.stringify(filters)}>
      <AgentRuns
        agent={agent}
        environmentPath={environmentPath(scope)}
        filters={filters}
        onFilter={filter}
        scope={scope}
      />
    </SectionBoundary>
  );
}
