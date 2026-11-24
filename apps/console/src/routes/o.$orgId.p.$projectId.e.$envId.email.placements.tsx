import { createFileRoute } from "@tanstack/react-router";
import { PlacementList } from "../components/email/placement-views.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { placementsQuery } from "../data/agent-email-setup-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/email/placements")({
  loader: ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(placementsQuery(scope));
  },
  component: Screen,
});

function Screen() {
  const { envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={envId}>
      <PlacementList scope={scope} />
    </SectionBoundary>
  );
}
