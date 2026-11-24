import { createFileRoute } from "@tanstack/react-router";
import { MemoryQualityView } from "../components/memory/memory-quality.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { qualityQuery } from "../data/memory-queries.ts";
import { DEFAULT_QUALITY_WINDOW, parseQualitySearch, type QualitySearch } from "../memory/model.ts";
import type { EnvironmentScope } from "../scope.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/memory/quality")({
  validateSearch: (search): QualitySearch => parseQualitySearch(search),
  loaderDeps: ({ search }) => parseQualitySearch(search),
  loader: ({ context, deps, params }) => {
    void context.queryClient.prefetchQuery(
      qualityQuery(
        {
          environmentId: params.envId,
          organizationId: params.orgId,
          projectId: params.projectId,
        },
        deps.days ?? DEFAULT_QUALITY_WINDOW,
      ),
    );
  },
  component: Quality,
});

function Quality() {
  const { envId, orgId, projectId } = Route.useParams();
  const days = Route.useSearch().days ?? DEFAULT_QUALITY_WINDOW;
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={envId}>
      <MemoryQualityView
        days={days}
        onDays={(next) => void navigate({ search: parseQualitySearch({ days: next }) })}
        scope={scope}
      />
    </SectionBoundary>
  );
}
