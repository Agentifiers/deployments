import { createFileRoute } from "@tanstack/react-router";
import { AutomationDetailPage } from "../components/automations/automation-detail.tsx";
import { automationQuery, firePagesQuery } from "../data/automation-queries.ts";
import { agentDirectoryQuery } from "../data/observability-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import type { AutomationRef } from "../server/automation-data.ts";

export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/automations/heartbeats/$heartbeatId",
)({
  loader: ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const automation: AutomationRef = { id: params.heartbeatId, kind: "heartbeat" };
    void context.queryClient.prefetchQuery(agentDirectoryQuery(scope));
    void context.queryClient.prefetchQuery(automationQuery(scope, automation));
    void context.queryClient.prefetchInfiniteQuery(firePagesQuery(scope, automation));
  },
  component: HeartbeatPage,
});

function HeartbeatPage() {
  const { envId, heartbeatId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return <AutomationDetailPage automation={{ id: heartbeatId, kind: "heartbeat" }} scope={scope} />;
}
