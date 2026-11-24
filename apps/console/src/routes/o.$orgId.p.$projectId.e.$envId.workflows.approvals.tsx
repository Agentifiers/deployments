import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { ApprovalQueueTable } from "../components/workflows/approval-queue.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { approvalQueueQuery } from "../data/workflow-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Text } from "@/components/ui/text";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/workflows/approvals")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(
      approvalQueueQuery({
        environmentId: params.envId,
        organizationId: params.orgId,
        projectId: params.projectId,
      }),
    );
  },
  component: WorkflowApprovals,
});

function WorkflowApprovals() {
  const { envId, orgId, projectId } = Route.useParams();
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-6">
      <Text>
        Workflow steps waiting for a person. This list refreshes every 30 seconds.
        {access.resolveWorkflowApproval
          ? " An approval that waited too long shows as expired when you open it, and can no longer be decided."
          : null}
      </Text>
      <SectionBoundary resetKey={envId}>
        <ApprovalQueueTable canResolve={access.resolveWorkflowApproval} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
