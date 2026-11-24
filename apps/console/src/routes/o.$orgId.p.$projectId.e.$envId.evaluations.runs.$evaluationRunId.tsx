import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { RunDetail } from "../components/evaluations/run-detail.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import {
  datasetDirectoryQuery,
  runDetailQuery,
  runResultPagesQuery,
} from "../data/evaluation-queries.ts";
import { agentDirectoryQuery } from "../data/observability-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/evaluations/runs/$evaluationRunId",
)({
  loader: ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(agentDirectoryQuery(scope));
    void context.queryClient.prefetchQuery(datasetDirectoryQuery(scope));
    void context.queryClient.prefetchQuery(runDetailQuery(scope, params.evaluationRunId));
    void context.queryClient.prefetchInfiniteQuery(
      runResultPagesQuery(scope, params.evaluationRunId),
    );
  },
  component: Run,
});

function Run() {
  const { envId, evaluationRunId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <BackLink href={`/o/${orgId}/p/${projectId}/e/${envId}/evaluations/runs`} label="Runs" />
      <SectionBoundary resetKey={evaluationRunId}>
        <RunDetail evaluationRunId={evaluationRunId} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
