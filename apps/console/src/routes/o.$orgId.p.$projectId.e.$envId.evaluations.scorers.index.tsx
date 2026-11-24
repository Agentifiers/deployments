import { createFileRoute } from "@tanstack/react-router";
import { ScorerList } from "../components/evaluations/scorers.tsx";
import { scorerPagesQuery } from "../data/evaluation-queries.ts";
import { parseResourceFilters, type ResourceFilters } from "../evaluations/filters.ts";
import type { EnvironmentScope } from "../scope.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/evaluations/scorers/")({
  validateSearch: (search): ResourceFilters => parseResourceFilters(search),
  loaderDeps: ({ search }) => parseResourceFilters(search),
  loader: ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchInfiniteQuery(scorerPagesQuery(scope, deps.status));
  },
  component: Scorers,
});

function Scorers() {
  const { envId, orgId, projectId } = Route.useParams();
  const { status } = parseResourceFilters(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <ScorerList
      onStatus={(next) => void navigate({ search: next ? { status: next } : {} })}
      scope={scope}
      status={status}
    />
  );
}
