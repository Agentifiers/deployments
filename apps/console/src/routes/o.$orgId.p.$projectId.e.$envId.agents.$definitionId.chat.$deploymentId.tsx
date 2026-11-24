import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { DeploymentChat } from "../components/agents/agent-chat.tsx";
import { Icon } from "../components/icon.tsx";
import { agentDetailQuery } from "../data/agent-queries.ts";
import { organizationShellQuery } from "../data/console-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Text } from "@/components/ui/text";

/** Chat with one of the agent's deployments. */
export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/agents/$definitionId/chat/$deploymentId",
)({
  component: Chat,
});

function Chat() {
  const { definitionId, deploymentId, envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const { data: agent } = useSuspenseQuery(agentDetailQuery(scope, definitionId));
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  const deployment = agent.deployments.find(({ id }) => id === deploymentId);
  const back = (
    <Link
      className="flex items-center gap-1 text-sm/6 text-muted-foreground hover:text-foreground"
      params={{ definitionId, envId, orgId, projectId }}
      to="/o/$orgId/p/$projectId/e/$envId/agents/$definitionId/deployments"
    >
      <Icon className="size-4" icon={ArrowLeft01Icon} />
      Deployments
    </Link>
  );
  if (!deployment || deployment.currentState === "stopped") {
    return (
      <div className="flex flex-col gap-6">
        {back}
        <Text>This agent has no live deployment with that ID.</Text>
      </div>
    );
  }
  if (!access.createThread || !access.submitAgentRun || !access.listRuns) {
    return (
      <div className="flex flex-col gap-6">
        {back}
        <Text>Your role or token scopes do not permit starting runs (runs:write).</Text>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {back}
      <DeploymentChat agent={agent} deployment={deployment} />
    </div>
  );
}
