import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { SpaceDetail } from "../components/memory/space-detail.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { grantPagesQuery, memoryPagesQuery, spaceQuery } from "../data/memory-queries.ts";
import {
  parseSpaceSearch,
  type GrantFilter,
  type MemoryStatus,
  type SpaceSearch,
} from "../memory/model.ts";
import type { EnvironmentScope } from "../scope.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/memory/spaces/$spaceId")({
  validateSearch: (search): SpaceSearch => parseSpaceSearch(search),
  loaderDeps: ({ search }) => parseSpaceSearch(search),
  loader: async ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const { queryClient } = context;
    void queryClient.prefetchQuery(spaceQuery(scope, params.spaceId));
    const { access } = await queryClient.ensureQueryData(organizationShellQuery(params.orgId));
    if (access.listMemorySpaceGrants) {
      void queryClient.prefetchInfiniteQuery(
        grantPagesQuery(scope, params.spaceId, deps.grants ?? "active"),
      );
    }
    if (access.listMemories) {
      void queryClient.prefetchInfiniteQuery(
        memoryPagesQuery(scope, params.spaceId, deps.memories ?? "active"),
      );
    }
  },
  component: Space,
});

function Space() {
  const { envId, orgId, projectId, spaceId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const filter = (next: { readonly grants: GrantFilter } | { readonly memories: MemoryStatus }) =>
    void navigate({ resetScroll: false, search: parseSpaceSearch({ ...search, ...next }) });
  return (
    <div className="flex flex-col gap-8">
      <BackLink href={`/o/${orgId}/p/${projectId}/e/${envId}/memory`} label="Spaces" />
      <SectionBoundary resetKey={spaceId}>
        <SpaceDetail
          grantFilter={search.grants ?? "active"}
          memoryStatus={search.memories ?? "active"}
          onGrantFilter={(grants) => filter({ grants })}
          onMemoryStatus={(memories) => filter({ memories })}
          scope={scope}
          spaceId={spaceId}
        />
      </SectionBoundary>
    </div>
  );
}
