import { createFileRoute } from "@tanstack/react-router";
import { ActiveModelPolicy, ModelPolicyHistory } from "../components/models/model-policy.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { activeModelPolicyQuery, modelPolicyPagesQuery } from "../data/model-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/models/policy/")({
  loader: async ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    if (access.listModels) {
      void context.queryClient.prefetchQuery(activeModelPolicyQuery(scope));
      void context.queryClient.prefetchInfiniteQuery(modelPolicyPagesQuery(scope));
    }
  },
  component: ModelPolicy,
});

function ModelPolicy() {
  const { envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-10">
      <SectionBoundary resetKey={envId}>
        <ActiveModelPolicy scope={scope} />
      </SectionBoundary>
      <ModelPolicyHistory scope={scope} />
    </div>
  );
}
