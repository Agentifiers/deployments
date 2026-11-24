import { createFileRoute } from "@tanstack/react-router";
import { SuppressionList } from "../components/email/suppression-views.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { suppressionPagesQuery } from "../data/agent-email-setup-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/email/suppressions")({
  loader: ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchInfiniteQuery(suppressionPagesQuery(scope));
  },
  component: Screen,
});

function Screen() {
  const { envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={envId}>
      <SuppressionList scope={scope} />
    </SectionBoundary>
  );
}
