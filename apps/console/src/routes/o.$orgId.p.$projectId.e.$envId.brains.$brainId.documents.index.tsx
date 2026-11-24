import { createFileRoute } from "@tanstack/react-router";
import { BrainDocuments } from "../components/brains/brain-documents.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { brainIndexHealthQuery } from "../data/brain-queries.ts";
import { environmentPath } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/brains/$brainId/documents/")({
  loader: ({ context, params }) =>
    void context.queryClient.prefetchInfiniteQuery(
      brainIndexHealthQuery(params.orgId, params.brainId),
    ),
  component: Documents,
});

function Documents() {
  const { brainId, envId, orgId, projectId } = Route.useParams();
  const scope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={brainId}>
      <BrainDocuments
        brainId={brainId}
        brainPath={`${environmentPath(scope)}/brains/${brainId}`}
        organizationId={orgId}
      />
    </SectionBoundary>
  );
}
