import { Wrench01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { liveDeployments } from "../components/agents/agent-header.tsx";
import {
  ConnectionGrants,
  McpConnections,
  ReferencedExtensions,
} from "../components/agents/runtime/access-blocks.tsx";
import { RuntimeBlock } from "../components/agents/runtime/runtime-block.tsx";
import { EffectiveTools } from "../components/agents/runtime/tool-evaluations.tsx";
import { Icon } from "../components/icon.tsx";
import { agentDetailQuery } from "../data/agent-queries.ts";
import { connectionGrantsQuery, toolEvaluationsQuery } from "../data/agent-runtime-queries.ts";
import { organizationShellQuery } from "../data/console-queries.ts";
import { extensionDirectoryQuery, mcpDirectoryQuery } from "../data/tool-directory-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/agents/$definitionId/tools")({
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
    const live = liveDeployments(agent).map((deployment) => deployment.id);
    // Not awaited: each block streams into its own boundary.
    if (access.evaluateToolPolicy && live.length > 0) {
      void context.queryClient.prefetchQuery(
        toolEvaluationsQuery(scope, params.definitionId, live),
      );
    }
    if (access.listConnectionGrants) {
      void context.queryClient.prefetchQuery(connectionGrantsQuery(scope));
    }
    if (access.listMcpConnections) {
      void context.queryClient.prefetchQuery(mcpDirectoryQuery(scope));
    }
    if (access.listExtensionTools) {
      void context.queryClient.prefetchQuery(extensionDirectoryQuery(scope));
    }
  },
  component: ToolsTab,
});

function ToolsTab() {
  const { definitionId, envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const { data: agent } = useSuspenseQuery(agentDetailQuery(scope, definitionId));
  const {
    data: { access },
  } = useSuspenseQuery(organizationShellQuery(orgId));
  const live = liveDeployments(agent);

  if (live.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon icon={Wrench01Icon} />
          </EmptyMedia>
          <EmptyTitle>No live deployments</EmptyTitle>
          <EmptyDescription>
            Effective tools, grants, and extensions are resolved per deployment. Deploy a release to
            see them.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-10">
      {access.evaluateToolPolicy ? (
        <RuntimeBlock
          description="What the runtime decides for each tool the deployed release declares."
          title="Effective tools"
        >
          <EffectiveTools agent={agent} scope={scope} />
        </RuntimeBlock>
      ) : null}
      {access.listConnectionGrants ? (
        <RuntimeBlock
          description="The connection each running deployment uses for each tool."
          title="Connection grants"
        >
          <ConnectionGrants agent={agent} scope={scope} />
        </RuntimeBlock>
      ) : null}
      {access.listMcpConnections && access.evaluateToolPolicy ? (
        <RuntimeBlock
          description="MCP connections reached through a pinned grant or an MCP extension the agent's tools use."
          title="MCP connections"
        >
          <McpConnections
            agent={agent}
            canReadExtensions={access.listExtensionTools}
            canReadGrants={access.listConnectionGrants}
            scope={scope}
          />
        </RuntimeBlock>
      ) : null}
      {access.listExtensionTools && access.evaluateToolPolicy ? (
        <RuntimeBlock
          description="Tenant extensions whose name matches one of the live deployments' tools."
          title="Extensions"
        >
          <ReferencedExtensions agent={agent} scope={scope} />
        </RuntimeBlock>
      ) : null}
    </div>
  );
}
