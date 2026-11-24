import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { PolicyDetail } from "../components/tool-policies/policy-detail.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { policyPinsQuery, policyQuery } from "../data/tool-policy-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/tool-policies/$policyId/")({
  loader: async ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    void context.queryClient.prefetchQuery(policyQuery(scope, params.policyId));
    // ArchiveAction reads the pins with useQuery, so a value streamed after SSR would make the
    // client's first render differ from the server HTML.
    if (access.listAgentDeployments)
      await context.queryClient.prefetchQuery(policyPinsQuery(scope));
  },
  component: Policy,
});

function Policy() {
  const { envId, orgId, policyId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <BackLink
        href={`/o/${orgId}/p/${projectId}/e/${envId}/tool-policies`}
        label="Tool policies"
      />
      <SectionBoundary resetKey={policyId}>
        <PolicyDetail policyId={policyId} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
