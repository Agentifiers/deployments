import { createFileRoute } from "@tanstack/react-router";
import { SectionBoundary } from "../components/section-boundary.tsx";
import {
  DefinitionList,
  DefinitionStatusSelect,
} from "../components/workflows/definition-list.tsx";
import { definitionPagesQuery } from "../data/workflow-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { parseDefinitionFilters, type DefinitionFilters } from "../workflows/model.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/workflows/")({
  validateSearch: (search): DefinitionFilters => parseDefinitionFilters(search),
  loaderDeps: ({ search }) => parseDefinitionFilters(search),
  loader: ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchInfiniteQuery(definitionPagesQuery(scope, deps));
  },
  component: Definitions,
});

function Definitions() {
  const { envId, orgId, projectId } = Route.useParams();
  const filters = parseDefinitionFilters(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-4">
        <DefinitionStatusSelect
          onChange={(next) => void navigate({ search: parseDefinitionFilters({ status: next }) })}
          value={filters.status ?? "active"}
        />
      </div>
      <SectionBoundary resetKey={filters.status ?? "active"}>
        <DefinitionList filters={filters} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
