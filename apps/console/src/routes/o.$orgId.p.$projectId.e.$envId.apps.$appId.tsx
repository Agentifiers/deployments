import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AppDetail } from "../components/apps/app-detail.tsx";
import { Icon } from "../components/icon.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import {
  appDomainsQuery,
  appGrantsQuery,
  appQuery,
  appReleasePagesQuery,
} from "../data/app-queries.ts";
import { organizationShellQuery } from "../data/console-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Text } from "@/components/ui/text";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/apps/$appId")({
  loader: async ({ context, params }) => {
    const { queryClient } = context;
    const { access } = await queryClient.ensureQueryData(organizationShellQuery(params.orgId));
    if (!access.listApps) return;
    const scope: EnvironmentScope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void queryClient.prefetchQuery(appQuery(scope, params.appId));
    if (access.listAppGrants) void queryClient.prefetchQuery(appGrantsQuery(scope, params.appId));
    if (access.listAppDomains) void queryClient.prefetchQuery(appDomainsQuery(scope, params.appId));
    if (access.listAppReleases) {
      void queryClient.prefetchInfiniteQuery(appReleasePagesQuery(scope, params.appId));
    }
  },
  component: App,
});

function App() {
  const { appId, envId, orgId, projectId } = Route.useParams();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <Link
        className="flex items-center gap-1 text-sm/6 text-muted-foreground hover:text-foreground"
        params={{ envId, orgId, projectId }}
        to="/o/$orgId/p/$projectId/e/$envId/apps"
      >
        <Icon className="size-4" icon={ArrowLeft01Icon} />
        Apps
      </Link>
      {shell.access.listApps ? (
        <SectionBoundary resetKey={appId}>
          <AppDetail access={shell.access} appId={appId} scope={scope} />
        </SectionBoundary>
      ) : (
        <Text>Your role or token scopes do not permit reading apps (apps:read).</Text>
      )}
    </div>
  );
}
