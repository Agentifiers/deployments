import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { ComparisonDetail } from "../components/evaluations/comparison-detail.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { comparisonDetailQuery, datasetDirectoryQuery } from "../data/evaluation-queries.ts";
import { agentDirectoryQuery } from "../data/observability-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/evaluations/comparisons/$releaseComparisonId",
)({
  loader: ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(agentDirectoryQuery(scope));
    void context.queryClient.prefetchQuery(datasetDirectoryQuery(scope));
    void context.queryClient.prefetchQuery(
      comparisonDetailQuery(scope, params.releaseComparisonId),
    );
  },
  component: Comparison,
});

function Comparison() {
  const { envId, orgId, projectId, releaseComparisonId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <BackLink
        href={`/o/${orgId}/p/${projectId}/e/${envId}/evaluations/comparisons`}
        label="Release comparisons"
      />
      <SectionBoundary resetKey={releaseComparisonId}>
        <ComparisonDetail releaseComparisonId={releaseComparisonId} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
