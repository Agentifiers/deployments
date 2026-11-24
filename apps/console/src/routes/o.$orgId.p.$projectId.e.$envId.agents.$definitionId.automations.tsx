import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { parseAutomationFilters, type AutomationFilters } from "../automations/automation-state.ts";
import {
  AutomationList,
  type AutomationFilterPatch,
} from "../components/automations/automation-list.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { agentDetailQuery } from "../data/agent-queries.ts";
import { automationViewPagesQuery } from "../data/automation-queries.ts";
import { agentDirectoryQuery } from "../data/observability-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/agents/$definitionId/automations",
)({
  validateSearch: (search): AutomationFilters => parseAutomationFilters(search),
  loaderDeps: ({ search }) => parseAutomationFilters(search),
  loader: async ({ context, deps, params }) => {
    const scope: EnvironmentScope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(agentDirectoryQuery(scope));
    const agent = await context.queryClient.ensureQueryData(
      agentDetailQuery(scope, params.definitionId),
    );
    // Not awaited: the list streams into its boundary.
    void context.queryClient.prefetchInfiniteQuery(
      automationViewPagesQuery(scope, {
        deploymentIds: agent.deployments.map((deployment) => deployment.id),
        filters: deps,
        kind: "list",
      }),
    );
  },
  component: AutomationsTab,
});

function AutomationsTab() {
  const { definitionId, envId, orgId, projectId } = Route.useParams();
  const filters = parseAutomationFilters(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const { data: agent } = useSuspenseQuery(agentDetailQuery(scope, definitionId));
  const filter = (patch: AutomationFilterPatch) =>
    void navigate({ resetScroll: false, search: parseAutomationFilters({ ...filters, ...patch }) });
  return (
    <SectionBoundary resetKey={definitionId}>
      <AutomationList
        deploymentIds={agent.deployments.map((deployment) => deployment.id)}
        filters={filters}
        onFilter={filter}
        scope={scope}
      />
    </SectionBoundary>
  );
}
