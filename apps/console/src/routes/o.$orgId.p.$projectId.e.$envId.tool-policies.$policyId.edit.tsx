import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { EditPolicy } from "../components/tool-policies/policy-editor.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { policyPinsQuery, policyQuery } from "../data/tool-policy-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Subheading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";

export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/tool-policies/$policyId/edit",
)({
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
    // The editor reads the pins with useQuery, so a value streamed after SSR would make the
    // client's first render differ from the server HTML.
    if (access.listAgentDeployments)
      await context.queryClient.prefetchQuery(policyPinsQuery(scope));
  },
  component: EditPolicyPage,
});

function EditPolicyPage() {
  const { envId, orgId, policyId, projectId } = Route.useParams();
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  if (!access.updateToolPolicy) {
    return (
      <Text>Your role or token scopes do not permit editing tool policies (tools:write).</Text>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <Subheading>Edit policy</Subheading>
      <SectionBoundary resetKey={policyId}>
        <EditPolicy pinsVisible={access.listAgentDeployments} policyId={policyId} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
