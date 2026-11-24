import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { DatasetDetail } from "../components/evaluations/datasets.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { datasetCasePagesQuery, datasetQuery } from "../data/evaluation-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/evaluations/datasets/$datasetId",
)({
  loader: ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(datasetQuery(scope, params.datasetId));
    void context.queryClient.prefetchInfiniteQuery(datasetCasePagesQuery(scope, params.datasetId));
  },
  component: Dataset,
});

function Dataset() {
  const { datasetId, envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <BackLink href={`/o/${orgId}/p/${projectId}/e/${envId}/evaluations`} label="Datasets" />
      <SectionBoundary resetKey={datasetId}>
        <DatasetDetail datasetId={datasetId} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
