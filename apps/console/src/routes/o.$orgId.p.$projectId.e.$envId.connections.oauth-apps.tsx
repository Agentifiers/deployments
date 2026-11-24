import { createFileRoute } from "@tanstack/react-router";
import { OAuthAppList } from "../components/connections/oauth-app-table.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { oauthAppsQuery } from "../data/oauth-app-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/connections/oauth-apps")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(
      oauthAppsQuery({
        environmentId: params.envId,
        organizationId: params.orgId,
        projectId: params.projectId,
      }),
    );
  },
  component: OAuthApps,
});

function OAuthApps() {
  const { envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={envId}>
      <OAuthAppList scope={scope} />
    </SectionBoundary>
  );
}
