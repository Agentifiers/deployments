import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { ReleaseSkills } from "../components/skills/release-skills.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import {
  agentTargetsQuery,
  releaseCatalogQuery,
  skillInstallationsQuery,
} from "../data/managed-skill-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/skills/releases/$releaseId")({
  loader: async ({ context, params }) => {
    const scope: EnvironmentScope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    if (access.listManagedSkillSources) {
      void context.queryClient.prefetchQuery(releaseCatalogQuery(params.releaseId));
    }
    if (access.listManagedSkillInstallations) {
      void context.queryClient.prefetchQuery(skillInstallationsQuery(scope));
    }
    if (access.listAgentDefinitions) {
      void context.queryClient.prefetchQuery(agentTargetsQuery(scope));
    }
  },
  component: Release,
});

function Release() {
  const { envId, orgId, projectId, releaseId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <BackLink href={`/o/${orgId}/p/${projectId}/e/${envId}/skills/catalog`} label="Catalog" />
      <SectionBoundary resetKey={releaseId}>
        <ReleaseSkills releaseId={releaseId} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
