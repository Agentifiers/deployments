import { createFileRoute } from "@tanstack/react-router";
import { InboxOverview } from "../components/email/inbox-overview.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { bindingPagesQuery } from "../data/agent-email-inbox-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/email/inboxes/$inboxId/")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchInfiniteQuery(
      bindingPagesQuery(
        { environmentId: params.envId, organizationId: params.orgId, projectId: params.projectId },
        params.inboxId,
      ),
    );
  },
  component: Overview,
});

function Overview() {
  const { envId, inboxId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={inboxId}>
      <InboxOverview inboxId={inboxId} scope={scope} />
    </SectionBoundary>
  );
}
