import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { SkillSource } from "../components/skills/skill-catalog.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { sourceCatalogQuery } from "../data/managed-skill-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/skills/catalog/$sourceId")({
  loader: async ({ context, params }) => {
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    if (access.listManagedSkillSources) {
      void context.queryClient.prefetchQuery(sourceCatalogQuery(params.sourceId));
    }
  },
  component: Source,
});

function Source() {
  const { envId, orgId, projectId, sourceId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <BackLink href={`/o/${orgId}/p/${projectId}/e/${envId}/skills/catalog`} label="Catalog" />
      <SectionBoundary resetKey={sourceId}>
        <SkillSource scope={scope} sourceId={sourceId} />
      </SectionBoundary>
    </div>
  );
}
