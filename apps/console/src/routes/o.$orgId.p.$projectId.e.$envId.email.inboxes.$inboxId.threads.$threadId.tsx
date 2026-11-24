import { createFileRoute } from "@tanstack/react-router";
import { ThreadDetail } from "../components/email/mailbox/thread-views.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { threadQuery } from "../data/agent-email-mailbox-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/email/inboxes/$inboxId/threads/$threadId",
)({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchInfiniteQuery(
      threadQuery(
        { environmentId: params.envId, organizationId: params.orgId, projectId: params.projectId },
        params.inboxId,
        params.threadId,
      ),
    );
  },
  component: Thread,
});

function Thread() {
  const { envId, inboxId, orgId, projectId, threadId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={threadId}>
      <ThreadDetail inboxId={inboxId} scope={scope} threadId={threadId} />
    </SectionBoundary>
  );
}
