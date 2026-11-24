import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { DeploymentList } from "../components/agents/deployment-list.tsx";
import { agentDetailQuery } from "../data/agent-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

/** Deployments tab: reads the agent the layout already loaded. */
export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/agents/$definitionId/deployments",
)({
  component: Deployments,
});

function Deployments() {
  const { definitionId, envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const { data: agent } = useSuspenseQuery(agentDetailQuery(scope, definitionId));
  return <DeploymentList agent={agent} />;
}
