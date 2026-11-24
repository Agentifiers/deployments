import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { InboxHeader } from "../components/email/inbox-header.tsx";
import { inboxQuery } from "../data/agent-email-inbox-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/email/inboxes/$inboxId")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      inboxQuery(
        { environmentId: params.envId, organizationId: params.orgId, projectId: params.projectId },
        params.inboxId,
      ),
    ),
  component: InboxLayout,
});

function InboxLayout() {
  const { envId, inboxId, orgId, projectId } = Route.useParams();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <InboxHeader inboxId={inboxId} pathname={pathname} scope={scope} />
      <Outlet />
    </div>
  );
}
