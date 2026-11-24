import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { SettingsPage } from "../components/tenancy/settings-page.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { tenancyResourceQuery } from "../data/tenancy-settings-queries.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/settings")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(
      tenancyResourceQuery({
        level: "project",
        organizationId: params.orgId,
        projectId: params.projectId,
      }),
    );
  },
  component: ProjectSettings,
});

function ProjectSettings() {
  const { orgId, projectId } = Route.useParams();
  const {
    data: { access },
  } = useSuspenseQuery(organizationShellQuery(orgId));
  return (
    <div className="flex flex-col gap-6">
      <BackLink href={`/o/${orgId}/p/${projectId}`} label="Project" />
      <SectionBoundary resetKey={projectId}>
        <SettingsPage
          canArchive={access.archiveProject}
          canEdit={access.updateProject}
          reference={{ level: "project", organizationId: orgId, projectId }}
        />
      </SectionBoundary>
    </div>
  );
}
