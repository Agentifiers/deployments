import { createFileRoute } from "@tanstack/react-router";
import { McpServerList } from "../components/mcp/mcp-server-list.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { mcpServerRowsQuery } from "../data/mcp-queries.ts";
import { parseServerSearch, type ServerSearch } from "../mcp/mcp-state.ts";
import type { EnvironmentScope } from "../scope.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/mcp-servers/")({
  validateSearch: (search): ServerSearch => parseServerSearch(search),
  loaderDeps: ({ search }) => parseServerSearch(search),
  loader: ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(mcpServerRowsQuery(scope, deps.show ?? "active"));
  },
  component: McpServers,
});

function McpServers() {
  const { envId, orgId, projectId } = Route.useParams();
  const view = parseServerSearch(Route.useSearch()).show ?? "active";
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={envId}>
      <McpServerList
        onView={(next) => void navigate({ search: next === "all" ? { show: next } : {} })}
        scope={scope}
        view={view}
      />
    </SectionBoundary>
  );
}
