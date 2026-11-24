import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BrainSources } from "../components/brains/brain-sources.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { brainSourcesQuery, brainViewQuery } from "../data/brain-queries.ts";
import { environmentPath } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/brains/$brainId/")({
  loader: ({ context, params }) =>
    void context.queryClient.prefetchInfiniteQuery(brainSourcesQuery(params.orgId, params.brainId)),
  component: Sources,
});

function Sources() {
  const { brainId, envId, orgId, projectId } = Route.useParams();
  const { data: view } = useSuspenseQuery(brainViewQuery(orgId, brainId));
  const scope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={brainId}>
      <BrainSources brainPath={`${environmentPath(scope)}/brains/${brainId}`} view={view} />
    </SectionBoundary>
  );
}
