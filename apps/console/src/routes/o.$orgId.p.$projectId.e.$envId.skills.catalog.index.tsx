import { createFileRoute } from "@tanstack/react-router";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { SkillSources } from "../components/skills/skill-catalog.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { skillSourcesQuery } from "../data/managed-skill-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { parseSourceSearch, type SourceSearch } from "../skills/skill-state.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/skills/catalog/")({
  validateSearch: (search): SourceSearch => parseSourceSearch(search),
  loader: async ({ context, params }) => {
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    if (access.listManagedSkillSources) {
      void context.queryClient.prefetchQuery(skillSourcesQuery());
    }
  },
  component: Catalog,
});

function Catalog() {
  const { envId, orgId, projectId } = Route.useParams();
  const view = Route.useSearch().show ?? "active";
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={envId}>
      <SkillSources
        onView={(next) => void navigate({ search: next === "all" ? { show: next } : {} })}
        scope={scope}
        view={view}
      />
    </SectionBoundary>
  );
}
