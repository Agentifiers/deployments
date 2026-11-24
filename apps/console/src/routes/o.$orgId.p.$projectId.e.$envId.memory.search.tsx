import { createFileRoute } from "@tanstack/react-router";
import { MemorySearch } from "../components/memory/memory-search.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { activeSpacesQuery } from "../data/memory-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/memory/search")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(
      activeSpacesQuery({
        environmentId: params.envId,
        organizationId: params.orgId,
        projectId: params.projectId,
      }),
    );
  },
  component: Search,
});

function Search() {
  const { envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={envId}>
      <MemorySearch scope={scope} />
    </SectionBoundary>
  );
}
