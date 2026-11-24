import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { DraftPlayground } from "../components/agents/agent-chat.tsx";
import { agentDetailQuery } from "../data/agent-queries.ts";
import { organizationShellQuery } from "../data/console-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Text } from "@/components/ui/text";

/** Playground tab: chats with a preview of the agent's unpublished draft. */
export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/agents/$definitionId/playground",
)({
  component: Playground,
});

function Playground() {
  const { definitionId, envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const { data: agent } = useSuspenseQuery(agentDetailQuery(scope, definitionId));
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  if (!access.createPreview || !access.submitPreviewTurn || !access.listRuns) {
    return (
      <Text>
        Your role or token scopes do not permit previewing drafts (runs:write and agents:write).
      </Text>
    );
  }
  return <DraftPlayground agent={agent} key={agent.definition.id} />;
}
