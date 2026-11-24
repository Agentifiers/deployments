import { createFileRoute } from "@tanstack/react-router";
import { AgentDomainDetail } from "../components/email/agent-domains.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { domainQuery } from "../data/agent-email-setup-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/email/domains/$domainId")({
  loader: ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(domainQuery(scope, params.domainId));
  },
  component: Screen,
});

function Screen() {
  const { domainId, envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={domainId}>
      <AgentDomainDetail domainId={domainId} scope={scope} />
    </SectionBoundary>
  );
}
