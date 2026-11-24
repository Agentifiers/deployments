import { createFileRoute } from "@tanstack/react-router";
import { PolicyList } from "../components/memory/policy-list.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { policiesQuery } from "../data/memory-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/memory/policies")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(
      policiesQuery({
        environmentId: params.envId,
        organizationId: params.orgId,
        projectId: params.projectId,
      }),
    );
  },
  component: Policies,
});

function Policies() {
  const { envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={envId}>
      <PolicyList scope={scope} />
    </SectionBoundary>
  );
}
