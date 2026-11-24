import { createFileRoute } from "@tanstack/react-router";
import { TenantList } from "../components/email/tenant-views.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { tenantPagesQuery } from "../data/email-tenant-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/email/tenants/")({
  loader: ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchInfiniteQuery(tenantPagesQuery(scope));
  },
  component: Screen,
});

function Screen() {
  const { envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={envId}>
      <TenantList scope={scope} />
    </SectionBoundary>
  );
}
