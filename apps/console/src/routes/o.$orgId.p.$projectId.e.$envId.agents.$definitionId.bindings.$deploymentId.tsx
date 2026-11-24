import { createFileRoute } from "@tanstack/react-router";
import { EditBindingsPanel } from "../components/agents/bindings/edit-bindings-panel.tsx";
import { isRepinnable } from "../connections/rebind.ts";
import { agentDetailQuery } from "../data/agent-queries.ts";
import { organizationShellQuery } from "../data/console-queries.ts";
import { bindingWorkbenchQuery } from "../data/tool-binding-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/agents/$definitionId/bindings/$deploymentId",
)({
  loader: async ({ context, params }) => {
    const scope: EnvironmentScope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const [{ access }, agent] = await Promise.all([
      context.queryClient.ensureQueryData(organizationShellQuery(params.orgId)),
      context.queryClient.ensureQueryData(agentDetailQuery(scope, params.definitionId)),
    ]);
    const deployment = agent.deployments.find(({ id }) => id === params.deploymentId);
    // Not awaited: the editor streams into its boundary.
    if (deployment && isRepinnable(deployment)) {
      void context.queryClient.prefetchQuery(
        bindingWorkbenchQuery(
          scope,
          {
            definitionId: params.definitionId,
            deploymentId: params.deploymentId,
            kind: "edit",
          },
          access.listModels,
        ),
      );
    }
  },
  component: EditBindings,
});

function EditBindings() {
  const { definitionId, deploymentId, envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = {
    environmentId: envId,
    organizationId: orgId,
    projectId,
  };
  return (
    <EditBindingsPanel definitionId={definitionId} deploymentId={deploymentId} scope={scope} />
  );
}
