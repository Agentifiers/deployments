import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { ExecutionDetail } from "../components/workflows/execution-detail.tsx";
import { executionDetailQuery } from "../data/workflow-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/workflows/executions/$executionId",
)({
  loader: ({ context, params }) => {
    const scope: EnvironmentScope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(executionDetailQuery(scope, params.executionId));
  },
  component: Execution,
});

function Execution() {
  const { envId, executionId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <BackLink
        href={`/o/${orgId}/p/${projectId}/e/${envId}/workflows/executions`}
        label="Executions"
      />
      <SectionBoundary resetKey={executionId}>
        <ExecutionDetail executionId={executionId} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
