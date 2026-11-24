import { createFileRoute } from "@tanstack/react-router";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { ReleaseDetail } from "../components/workflows/release-detail.tsx";
import { relatedExecutionsQuery, releaseQuery } from "../data/workflow-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/workflows/releases/$releaseId",
)({
  loader: ({ context, params }) => {
    const scope: EnvironmentScope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(releaseQuery(scope, params.releaseId));
    void context.queryClient.prefetchQuery(
      relatedExecutionsQuery(scope, { releaseId: params.releaseId }),
    );
  },
  component: Release,
});

function Release() {
  const { envId, orgId, projectId, releaseId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={releaseId}>
      <ReleaseDetail releaseId={releaseId} scope={scope} />
    </SectionBoundary>
  );
}
