import { createFileRoute } from "@tanstack/react-router";
import { PolicyView } from "../components/email/policy-view.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { policyQuery } from "../data/agent-email-setup-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/email/policy")({
  loader: ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(policyQuery(scope));
  },
  component: Screen,
});

function Screen() {
  const { envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={envId}>
      <PolicyView scope={scope} />
    </SectionBoundary>
  );
}
