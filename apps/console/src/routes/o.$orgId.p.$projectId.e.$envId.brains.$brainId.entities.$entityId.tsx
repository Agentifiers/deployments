import { createFileRoute } from "@tanstack/react-router";
import { BrainEntity } from "../components/brains/brain-entity.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { brainEntityQuery } from "../data/brain-queries.ts";
import { environmentPath } from "../scope.ts";

export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/brains/$brainId/entities/$entityId",
)({
  loader: ({ context, params }) =>
    void context.queryClient.prefetchQuery(
      brainEntityQuery(params.orgId, params.brainId, params.entityId),
    ),
  component: Entity,
});

function Entity() {
  const { brainId, entityId, envId, orgId, projectId } = Route.useParams();
  const scope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={entityId}>
      <BrainEntity
        brainId={brainId}
        brainPath={`${environmentPath(scope)}/brains/${brainId}`}
        entityId={entityId}
        organizationId={orgId}
      />
    </SectionBoundary>
  );
}
