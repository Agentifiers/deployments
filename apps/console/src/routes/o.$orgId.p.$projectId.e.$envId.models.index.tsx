import { createFileRoute } from "@tanstack/react-router";
import { ModelCatalog } from "../components/models/model-catalog.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { modelPagesQuery } from "../data/model-queries.ts";
import { parseModelSearch, type ModelSearch } from "../models/model-catalog-state.ts";
import type { EnvironmentScope } from "../scope.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/models/")({
  validateSearch: (search): ModelSearch => parseModelSearch(search),
  loaderDeps: ({ search }) => parseModelSearch(search),
  loader: async ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    if (access.listModels) {
      void context.queryClient.prefetchInfiniteQuery(modelPagesQuery(scope, deps));
    }
  },
  component: Models,
});

function Models() {
  const { envId, orgId, projectId } = Route.useParams();
  const search = parseModelSearch(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <ModelCatalog
      key={search.search ?? ""}
      onSearch={(next) => void navigate({ search: next })}
      scope={scope}
      search={search}
    />
  );
}
