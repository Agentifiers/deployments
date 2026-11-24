import { createFileRoute } from "@tanstack/react-router";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { InstalledSkills } from "../components/skills/installed-skills.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { agentTargetsQuery, skillInstallationsQuery } from "../data/managed-skill-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/skills/")({
  loader: async ({ context, params }) => {
    const scope: EnvironmentScope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    if (access.listManagedSkillInstallations) {
      void context.queryClient.prefetchQuery(skillInstallationsQuery(scope));
    }
    if (access.listAgentDefinitions) {
      void context.queryClient.prefetchQuery(agentTargetsQuery(scope));
    }
  },
  component: Installed,
});

function Installed() {
  const { envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={envId}>
      <InstalledSkills scope={scope} />
    </SectionBoundary>
  );
}
