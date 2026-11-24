import { createFileRoute } from "@tanstack/react-router";
import { BindingDetail } from "../components/email/binding-detail.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { bindingQuery } from "../data/agent-email-inbox-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/email/bindings/$bindingId")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(
      bindingQuery(
        { environmentId: params.envId, organizationId: params.orgId, projectId: params.projectId },
        params.bindingId,
      ),
    );
  },
  component: Binding,
});

function Binding() {
  const { bindingId, envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={bindingId}>
      <BindingDetail bindingId={bindingId} scope={scope} />
    </SectionBoundary>
  );
}
