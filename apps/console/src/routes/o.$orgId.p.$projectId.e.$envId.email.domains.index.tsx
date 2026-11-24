import { createFileRoute } from "@tanstack/react-router";
import { AgentDomains } from "../components/email/agent-domains.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { domainPagesQuery } from "../data/agent-email-setup-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/email/domains/")({
  loader: ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchInfiniteQuery(domainPagesQuery(scope));
  },
  component: Screen,
});

function Screen() {
  const { envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={envId}>
      <AgentDomains scope={scope} />
    </SectionBoundary>
  );
}
