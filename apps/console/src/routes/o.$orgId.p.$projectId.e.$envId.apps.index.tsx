import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AppList } from "../components/apps/app-list.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { appPagesQuery } from "../data/app-queries.ts";
import { organizationShellQuery } from "../data/console-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Heading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/apps/")({
  loader: async ({ context, params }) => {
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    if (access.listApps) {
      void context.queryClient.prefetchInfiniteQuery(
        appPagesQuery({
          environmentId: params.envId,
          organizationId: params.orgId,
          projectId: params.projectId,
        }),
      );
    }
  },
  component: Apps,
});

function Apps() {
  const { envId, orgId, projectId } = Route.useParams();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <Heading>Apps</Heading>
      {shell.access.listApps ? (
        <SectionBoundary resetKey={envId}>
          <AppList scope={scope} />
        </SectionBoundary>
      ) : (
        <Text>Your role or token scopes do not permit listing apps (apps:read).</Text>
      )}
    </div>
  );
}
