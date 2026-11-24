import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BrainAccess } from "../components/brains/brain-access.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { brainGrantsQuery, brainMountsQuery, brainViewQuery } from "../data/brain-queries.ts";
import { environmentQuery } from "../data/console-queries.ts";
import { memberDirectoryQuery } from "../data/membership-queries.ts";
import { agentDirectoryQuery } from "../data/observability-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/brains/$brainId/access")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(brainGrantsQuery(params.orgId, params.brainId));
    void context.queryClient.prefetchQuery(brainMountsQuery(params.orgId, params.brainId));
    void context.queryClient.prefetchQuery(memberDirectoryQuery(params.orgId));
    const scope: EnvironmentScope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(agentDirectoryQuery(scope));
    void context.queryClient.prefetchQuery(environmentQuery(scope));
  },
  component: Access,
});

function Access() {
  const { brainId, envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const { brain } = useSuspenseQuery(brainViewQuery(orgId, brainId)).data;
  return (
    <SectionBoundary resetKey={brainId}>
      <BrainAccess brain={brain} scope={scope} />
    </SectionBoundary>
  );
}
