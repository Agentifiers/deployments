import { createFileRoute } from "@tanstack/react-router";
import { TenantDomainDetail } from "../components/email/tenant-views.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { tenantDomainQuery } from "../data/email-tenant-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/email/tenant-domains/$domainId",
)({
  loader: ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(tenantDomainQuery(scope, params.domainId));
  },
  component: Screen,
});

function Screen() {
  const { domainId, envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={domainId}>
      <TenantDomainDetail domainId={domainId} scope={scope} />
    </SectionBoundary>
  );
}
