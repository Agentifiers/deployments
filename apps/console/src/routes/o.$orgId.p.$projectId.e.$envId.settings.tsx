import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { EnvironmentTypeBadge } from "../components/organization-shell.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { SettingsPage } from "../components/tenancy/settings-page.tsx";
import { environmentQuery, organizationShellQuery } from "../data/console-queries.ts";
import { tenancyResourceQuery } from "../data/tenancy-settings-queries.ts";
import { DescriptionDetails, DescriptionTerm } from "@/components/ui/description-list";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/settings")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(
      tenancyResourceQuery({
        environmentId: params.envId,
        level: "environment",
        organizationId: params.orgId,
        projectId: params.projectId,
      }),
    );
  },
  component: EnvironmentSettings,
});

function EnvironmentSettings() {
  const { envId, orgId, projectId } = Route.useParams();
  const navigate = useNavigate();
  const scope = { environmentId: envId, organizationId: orgId, projectId };
  const {
    data: { access },
  } = useSuspenseQuery(organizationShellQuery(orgId));
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  return (
    <SectionBoundary resetKey={envId}>
      <SettingsPage
        canArchive={access.archiveEnvironment}
        canEdit={access.updateEnvironment}
        details={
          <>
            <DescriptionTerm>Type</DescriptionTerm>
            <DescriptionDetails>
              <EnvironmentTypeBadge type={environment.type} />
            </DescriptionDetails>
          </>
        }
        onArchived={() =>
          void navigate({ params: { orgId, projectId }, to: "/o/$orgId/p/$projectId" })
        }
        reference={{ level: "environment", ...scope }}
      />
    </SectionBoundary>
  );
}
