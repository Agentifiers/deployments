import { createFileRoute } from "@tanstack/react-router";
import { AgentEvaluations } from "../components/evaluations/agent-evaluations.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { agentDetailQuery } from "../data/agent-queries.ts";
import {
  AGENT_TAB_RELEASES,
  agentEvaluationsQuery,
  datasetDirectoryQuery,
} from "../data/evaluation-queries.ts";
import { agentDirectoryQuery } from "../data/observability-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/agents/$definitionId/evaluations",
)({
  loader: ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    // Not awaited: the runs and comparisons depend on the layout's releases and stream in.
    void context.queryClient.prefetchQuery(agentDirectoryQuery(scope));
    void context.queryClient.prefetchQuery(datasetDirectoryQuery(scope));
    void context.queryClient
      .ensureQueryData(agentDetailQuery(scope, params.definitionId))
      .then((agent) =>
        context.queryClient.prefetchQuery(
          agentEvaluationsQuery(
            scope,
            agent.releases.slice(0, AGENT_TAB_RELEASES).map((release) => release.id),
          ),
        ),
      )
      // The agent layout's loader reports a failed agent read.
      .catch(() => undefined);
  },
  component: AgentEvaluationsTab,
});

function AgentEvaluationsTab() {
  const { definitionId, envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={definitionId}>
      <AgentEvaluations definitionId={definitionId} scope={scope} />
    </SectionBoundary>
  );
}
