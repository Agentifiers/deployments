import { MessageMultiple01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { EmailRoutes } from "../components/agents/runtime/agent-channels.tsx";
import { ChannelBindings } from "../components/agents/runtime/channel-bindings.tsx";
import { RuntimeBlock } from "../components/agents/runtime/runtime-block.tsx";
import { Icon } from "../components/icon.tsx";
import { agentDetailQuery } from "../data/agent-queries.ts";
import { agentChannelsQuery, agentEmailRoutesQuery } from "../data/agent-runtime-queries.ts";
import { organizationShellQuery } from "../data/console-queries.ts";
import { integrationEndpointsQuery } from "../data/integration-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/agents/$definitionId/channels",
)({
  loader: async ({ context, params }) => {
    const scope: EnvironmentScope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const [agent, { access }] = await Promise.all([
      context.queryClient.ensureQueryData(agentDetailQuery(scope, params.definitionId)),
      context.queryClient.ensureQueryData(organizationShellQuery(params.orgId)),
    ]);
    const deploymentIds = agent.deployments.map((deployment) => deployment.id);
    // Not awaited: each block streams into its own boundary.
    void context.queryClient.prefetchQuery(integrationEndpointsQuery());
    if (access.listChannelBindings) {
      void context.queryClient.prefetchQuery(
        agentChannelsQuery(scope, params.definitionId, deploymentIds),
      );
    }
    if (access.listAgentEmailInboxes) {
      void context.queryClient.prefetchQuery(
        agentEmailRoutesQuery(scope, params.definitionId, deploymentIds),
      );
    }
  },
  component: ChannelsTab,
});

/** Read only: bindings and inboxes are shown here and changed through the API or the Email pages. */
function ChannelsTab() {
  const { definitionId, envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const { data: agent } = useSuspenseQuery(agentDetailQuery(scope, definitionId));
  const {
    data: { access },
  } = useSuspenseQuery(organizationShellQuery(orgId));

  if (!access.listChannelBindings && !access.listAgentEmailInboxes) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon icon={MessageMultiple01Icon} />
          </EmptyMedia>
          <EmptyTitle>Channels are not available to you</EmptyTitle>
          <EmptyDescription>
            Reading channel bindings needs the channels:read scope; reading inboxes needs
            agent-email:read.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-10">
      {access.listChannelBindings ? (
        <RuntimeBlock
          description="Bindings that connect this agent's deployments to a messaging channel, and the messages delivered through them."
          title="Channel bindings"
        >
          <ChannelBindings agent={agent} scope={scope} />
        </RuntimeBlock>
      ) : null}
      {access.listAgentEmailInboxes ? (
        <RuntimeBlock
          description="Active and paused agent email inboxes bound to one of this agent's deployments; archived inboxes route no mail and are not read."
          title="Email inboxes"
        >
          <EmailRoutes agent={agent} scope={scope} />
        </RuntimeBlock>
      ) : null}
    </div>
  );
}
