import { createFileRoute } from "@tanstack/react-router";
import { ConnectionList } from "../components/connections/connection-table.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { parseConnectionSearch, type ConnectionSearch } from "../connections/connection-state.ts";
import { connectionPagesQuery } from "../data/connection-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/connections/")({
  validateSearch: (search): ConnectionSearch => parseConnectionSearch(search),
  loaderDeps: ({ search }) => parseConnectionSearch(search),
  loader: ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchInfiniteQuery(
      connectionPagesQuery(scope, deps.status ?? "current"),
    );
  },
  component: Connections,
});

function Connections() {
  const { envId, orgId, projectId } = Route.useParams();
  const filter = parseConnectionSearch(Route.useSearch()).status ?? "current";
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={envId}>
      <ConnectionList
        filter={filter}
        onFilter={(next) => void navigate({ search: next === "current" ? {} : { status: next } })}
        scope={scope}
      />
    </SectionBoundary>
  );
}
