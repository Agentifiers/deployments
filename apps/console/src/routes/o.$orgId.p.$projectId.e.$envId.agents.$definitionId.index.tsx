import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AgentOverview, canaryReleaseIds } from "../components/agents/agent-overview.tsx";
import { AnalyticsBadge } from "../components/observability/panels.tsx";
import { RangeToggle } from "../components/observability/selection-controls.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { agentDetailQuery, agentOverviewQuery } from "../data/agent-queries.ts";
import { organizationShellQuery } from "../data/console-queries.ts";
import { parseMetricSelection, type MetricRange } from "../observability/range.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Subheading } from "@/components/ui/heading";
import { Code, Text } from "@/components/ui/text";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/agents/$definitionId/")({
  validateSearch: (search): { readonly range?: MetricRange } => ({
    range: parseMetricSelection(search).range,
  }),
  loaderDeps: ({ search }) => ({ range: parseMetricSelection(search).range }),
  loader: async ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const [shell, agent] = await Promise.all([
      context.queryClient.ensureQueryData(organizationShellQuery(params.orgId)),
      context.queryClient.ensureQueryData(agentDetailQuery(scope, params.definitionId)),
    ]);
    if (!shell.access.getObservabilityMetrics) return;
    // Not awaited: the hot-plane section streams into its boundary under the header.
    void context.queryClient.prefetchQuery(
      agentOverviewQuery(scope, params.definitionId, deps.range, canaryReleaseIds(agent)),
    );
  },
  component: Overview,
});

function Overview() {
  const { definitionId, envId, orgId, projectId } = Route.useParams();
  const { range } = parseMetricSelection(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const { data: agent } = useSuspenseQuery(agentDetailQuery(scope, definitionId));
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));

  if (!shell.access.getObservabilityMetrics) {
    return (
      <Text>
        Your role or token scopes do not include <Code>observability:read</Code>, so this
        agent&apos;s activity is hidden.
      </Text>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Subheading>Activity</Subheading>
        <AnalyticsBadge />
        <div className="ml-auto">
          <RangeToggle
            onChange={(next) => void navigate({ search: { range: next } })}
            value={range}
          />
        </div>
      </div>
      <SectionBoundary resetKey={range}>
        <AgentOverview agent={agent} range={range} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
