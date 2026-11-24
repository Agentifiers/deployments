import { PUBLIC_ID_PATTERN } from "@deployments-ai/api-contract/primitives";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { SettingsPage } from "../components/tenancy/settings-page.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { tenancyResourceQuery } from "../data/tenancy-settings-queries.ts";
import { environmentPath } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/workspaces/$workspaceId")({
  beforeLoad: ({ params }) => {
    if (!PUBLIC_ID_PATTERN.test(params.workspaceId)) throw notFound();
  },
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(
      tenancyResourceQuery({
        environmentId: params.envId,
        level: "workspace",
        organizationId: params.orgId,
        projectId: params.projectId,
        workspaceId: params.workspaceId,
      }),
    );
  },
  component: WorkspaceSettings,
});

function WorkspaceSettings() {
  const { envId, orgId, projectId, workspaceId } = Route.useParams();
  const scope = { environmentId: envId, organizationId: orgId, projectId };
  const {
    data: { access },
  } = useSuspenseQuery(organizationShellQuery(orgId));
  return (
    <div className="flex flex-col gap-6">
      <BackLink href={`${environmentPath(scope)}/workspaces`} label="Workspaces" />
      <SectionBoundary resetKey={workspaceId}>
        <SettingsPage
          canArchive={access.archiveWorkspace}
          canEdit={access.updateWorkspace}
          reference={{ level: "workspace", ...scope, workspaceId }}
        />
      </SectionBoundary>
    </div>
  );
}
