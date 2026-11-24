import { createFileRoute } from "@tanstack/react-router";
import { BrainReview } from "../components/brains/brain-review.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { brainReviewQuery } from "../data/brain-queries.ts";
import { environmentPath } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/brains/$brainId/review")({
  loader: ({ context, params }) =>
    void context.queryClient.prefetchInfiniteQuery(brainReviewQuery(params.orgId, params.brainId)),
  component: Review,
});

function Review() {
  const { brainId, envId, orgId, projectId } = Route.useParams();
  const scope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={brainId}>
      <BrainReview
        brainId={brainId}
        brainPath={`${environmentPath(scope)}/brains/${brainId}`}
        organizationId={orgId}
      />
    </SectionBoundary>
  );
}
