import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ApprovalInbox, approvalTabs } from "../components/runs/approval-inbox.tsx";
import { RouteTabs } from "../components/route-tabs.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { approvalPagesQuery } from "../data/runtime-queries.ts";
import { parseApprovalFilters, type ApprovalFilters } from "../runs/filters.ts";
import { environmentPath, type EnvironmentScope } from "../scope.ts";
import { Heading } from "@/components/ui/heading";
import { Text, TextLink } from "@/components/ui/text";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/approvals")({
  validateSearch: (search): ApprovalFilters => parseApprovalFilters(search),
  loaderDeps: ({ search }) => parseApprovalFilters(search),
  loader: ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchInfiniteQuery(approvalPagesQuery(scope, deps));
  },
  component: Approvals,
});

function Approvals() {
  const { envId, orgId, projectId } = Route.useParams();
  const filters = parseApprovalFilters(Route.useSearch());
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  return (
    <div className="flex flex-col gap-8">
      <Heading>Approvals</Heading>
      {access.listWorkflowDefinitions ? (
        <Text>
          Workflow steps waiting for a decision are not listed here. Find them under{" "}
          <TextLink href={`${environmentPath(scope)}/workflows/approvals`}>
            Workflows › Approvals
          </TextLink>
          .
        </Text>
      ) : null}
      <RouteTabs label="Approval statuses" tabs={approvalTabs(scope, filters)} />
      <SectionBoundary resetKey={filters.status ?? "pending"}>
        <ApprovalInbox filters={filters} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
