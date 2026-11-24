import { createFileRoute } from "@tanstack/react-router";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { ExecutionList, ExecutionStatusFilter } from "../components/workflows/execution-list.tsx";
import { executionPagesQuery } from "../data/workflow-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { parseExecutionFilters, type ExecutionFilters } from "../workflows/model.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/workflows/executions/")({
  validateSearch: (search): ExecutionFilters => parseExecutionFilters(search),
  loaderDeps: ({ search }) => parseExecutionFilters(search),
  loader: ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchInfiniteQuery(executionPagesQuery(scope, deps));
  },
  component: Executions,
});

function Executions() {
  const { envId, orgId, projectId } = Route.useParams();
  const filters = parseExecutionFilters(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-6">
      <ExecutionStatusFilter
        filters={filters}
        onFilter={(next) => void navigate({ search: next })}
      />
      <SectionBoundary resetKey={filters.status ?? "all"}>
        <ExecutionList filters={filters} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
