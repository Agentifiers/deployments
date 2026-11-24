import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { McpServerDetail } from "../components/mcp/mcp-server-detail.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { cappedDeploymentsQuery, cappedGrantsQuery, mcpServerQuery } from "../data/mcp-queries.ts";
import { mcpDirectoryQuery } from "../data/tool-directory-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/mcp-servers/$serverId")({
  loader: async ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    void context.queryClient.prefetchQuery(mcpServerQuery(scope, params.serverId));
    void context.queryClient.prefetchQuery(mcpDirectoryQuery(scope));
    if (access.listConnectionGrants && access.listAgentDeployments) {
      void context.queryClient.prefetchQuery(cappedGrantsQuery(scope));
      void context.queryClient.prefetchQuery(cappedDeploymentsQuery(scope));
    }
  },
  component: McpServer,
});

function McpServer() {
  const { envId, orgId, projectId, serverId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <BackLink href={`/o/${orgId}/p/${projectId}/e/${envId}/mcp-servers`} label="MCP servers" />
      <SectionBoundary resetKey={serverId}>
        <McpServerDetail scope={scope} serverId={serverId} />
      </SectionBoundary>
    </div>
  );
}
