import { createFileRoute } from "@tanstack/react-router";
import { ReviewQueue } from "../components/memory/review-queue.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { reviewPagesQuery } from "../data/memory-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/memory/review")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchInfiniteQuery(
      reviewPagesQuery({
        environmentId: params.envId,
        organizationId: params.orgId,
        projectId: params.projectId,
      }),
    );
  },
  component: Review,
});

function Review() {
  const { envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={envId}>
      <ReviewQueue scope={scope} />
    </SectionBoundary>
  );
}
