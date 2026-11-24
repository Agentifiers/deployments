import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { TenantDetail } from "../components/email/tenant-views.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { tenantDomainsQuery, tenantQuery } from "../data/email-tenant-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/email/tenants/$tenantId")({
  loader: ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(tenantQuery(scope, params.tenantId));
    void context.queryClient.prefetchQuery(tenantDomainsQuery(scope, params.tenantId));
  },
  component: Screen,
});

function Screen() {
  const { envId, orgId, projectId, tenantId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <BackLink
        href={`/o/${orgId}/p/${projectId}/e/${envId}/email/tenants`}
        label="Sending tenants"
      />
      <SectionBoundary resetKey={tenantId}>
        <TenantDetail tenantId={tenantId} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
