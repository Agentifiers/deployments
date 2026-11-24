import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { AgentHeader } from "../components/agents/agent-header.tsx";
import { RouteTabs, type RouteTab } from "../components/route-tabs.tsx";
import { agentDetailQuery } from "../data/agent-queries.ts";
import { environmentQuery, organizationShellQuery } from "../data/console-queries.ts";
import { environmentPath, type EnvironmentScope } from "../scope.ts";

/** Agent detail: header and tabs around the selected tab's route. */
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/agents/$definitionId")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      agentDetailQuery(
        { environmentId: params.envId, organizationId: params.orgId, projectId: params.projectId },
        params.definitionId,
      ),
    ),
  component: AgentLayout,
});

function AgentLayout() {
  const { definitionId, envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { data: agent } = useSuspenseQuery(agentDetailQuery(scope, definitionId));
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const { access } = shell;
  const agentsPath = `${environmentPath(scope)}/agents`;
  const basePath = `${agentsPath}/${definitionId}`;
  /** Chat opens one deployment, so it counts as the Deployments tab. */
  const section = pathname.startsWith(`${basePath}/chat/`) ? `${basePath}/deployments` : pathname;
  const tab = (segment: string, label: string): RouteTab => {
    const href = segment ? `${basePath}/${segment}` : basePath;
    return { current: section === href, href, label };
  };
  const tabs = [
    tab("", "Overview"),
    tab("releases", "Releases"),
    tab("deployments", "Deployments"),
    tab("configuration", "Configuration"),
    ...(access.createPreview && access.submitPreviewTurn && access.listRuns
      ? [tab("playground", "Playground")]
      : []),
    ...(access.listRuns ? [tab("runs", "Runs")] : []),
    ...(access.listSchedules ? [tab("automations", "Automations")] : []),
    ...(access.evaluateToolPolicy ? [tab("tools", "Tools & access")] : []),
    ...(access.listChannelBindings || access.listAgentEmailInboxes
      ? [tab("channels", "Channels")]
      : []),
    ...(access.listEvaluationRuns ? [tab("evaluations", "Evaluations")] : []),
    ...(access.getUsageSummary || access.getObservabilityMetrics ? [tab("usage", "Usage")] : []),
  ];

  return (
    <div className="flex flex-col gap-8">
      <AgentHeader agent={agent} agentsPath={agentsPath} environment={environment} />
      <RouteTabs label="Agent sections" tabs={tabs} />
      <Outlet />
    </div>
  );
}
