import { createFileRoute } from "@tanstack/react-router";
import { SpaceList } from "../components/memory/space-list.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { spacePagesQuery } from "../data/memory-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/memory/")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchInfiniteQuery(
      spacePagesQuery({
        environmentId: params.envId,
        organizationId: params.orgId,
        projectId: params.projectId,
      }),
    );
  },
  component: Spaces,
});

function Spaces() {
  const { envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={envId}>
      <SpaceList scope={scope} />
    </SectionBoundary>
  );
}
