import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { ToolCatalog } from "../components/tool-policies/tool-catalog.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { toolPagesQuery } from "../data/tool-policy-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { parseCatalogSearch, type CatalogSearch } from "../tool-policies/catalog-state.ts";
import { Text } from "@/components/ui/text";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/tool-policies/catalog")({
  validateSearch: (search): CatalogSearch => parseCatalogSearch(search),
  loaderDeps: ({ search: { tool: _tool, ...filters } }) => parseCatalogSearch(filters),
  loader: async ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    if (access.listTools)
      void context.queryClient.prefetchInfiniteQuery(toolPagesQuery(scope, deps));
  },
  component: Catalog,
});

function Catalog() {
  const { envId, orgId, projectId } = Route.useParams();
  const search = parseCatalogSearch(Route.useSearch());
  const navigate = Route.useNavigate();
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  if (!access.listTools) {
    return <Text>Your role or token scopes do not permit listing tools (tools:read).</Text>;
  }
  return (
    <SectionBoundary resetKey={envId}>
      <ToolCatalog
        canSimulate={access.evaluateToolPolicy}
        onSearch={(next) => void navigate({ search: parseCatalogSearch({ ...next }) })}
        onSimulate={(tools) =>
          void navigate({
            params: { envId, orgId, projectId },
            search: { against: "policy", tools: [...tools] },
            to: "/o/$orgId/p/$projectId/e/$envId/tool-policies/simulate",
          })
        }
        scope={scope}
        search={search}
      />
    </SectionBoundary>
  );
}
