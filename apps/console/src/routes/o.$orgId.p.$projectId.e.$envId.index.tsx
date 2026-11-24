import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BudgetRefusalBanner } from "../components/budgets/budget-refusal.tsx";
import { EnvironmentDashboard } from "../components/observability/environment-dashboard.tsx";
import { FirstAgent } from "../components/overview/first-agent.tsx";
import { StatusStrip } from "../components/overview/status-strip.tsx";
import { Timestamp } from "../components/observability/panels.tsx";
import { PublicId } from "../components/public-id.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { RangeToggle } from "../components/observability/selection-controls.tsx";
import { EnvironmentTypeBadge } from "../components/organization-shell.tsx";
import { agentListQuery } from "../data/agent-queries.ts";
import { budgetRefusalsQuery } from "../data/budget-queries.ts";
import { environmentQuery, organizationShellQuery } from "../data/console-queries.ts";
import { agentDirectoryQuery, environmentDashboardQuery } from "../data/observability-queries.ts";
import {
  connectionProblemsQuery,
  deploymentStatesQuery,
  failedDeliveriesQuery,
  pendingApprovalsQuery,
} from "../data/overview-queries.ts";
import {
  parseMetricSelection,
  RANGE_INTERVALS,
  type MetricRange,
  type MetricSelection,
} from "../observability/range.ts";
import type { EnvironmentScope } from "../scope.ts";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading, Subheading } from "@/components/ui/heading";
import { Code, Text } from "@/components/ui/text";
import { StatusBadge } from "@/components/status-badge";

/** The overview charts the range at the range's finest bucket width. */
function overviewSelection(range: MetricRange): MetricSelection {
  return { interval: RANGE_INTERVALS[range][0]!, range };
}

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/")({
  validateSearch: (search): { readonly range?: MetricRange } => ({
    range: parseMetricSelection(search).range,
  }),
  loaderDeps: ({ search }) => ({ range: parseMetricSelection(search).range }),
  loader: async ({ context, deps, params }) => {
    const shell = await context.queryClient.ensureQueryData(organizationShellQuery(params.orgId));
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const { access } = shell;
    const { queryClient } = context;
    // Not awaited: the status blocks and the dashboard stream into their own boundaries, so a
    // slow or unavailable source never blocks the environment header.
    if (access.listAgentDeployments) void queryClient.prefetchQuery(deploymentStatesQuery(scope));
    if (access.listApprovals) void queryClient.prefetchQuery(pendingApprovalsQuery(scope));
    if (access.listProviderConnections) {
      void queryClient.prefetchQuery(connectionProblemsQuery(scope));
    }
    if (access.listWebhookDeliveries) void queryClient.prefetchQuery(failedDeliveriesQuery(scope));
    if (access.listBudgets) void queryClient.prefetchQuery(budgetRefusalsQuery(scope));
    if (access.listAgentDefinitions) void queryClient.prefetchQuery(agentListQuery(scope, false));
    if (!access.getObservabilityMetrics) return;
    void context.queryClient.prefetchQuery(agentDirectoryQuery(scope));
    void context.queryClient.prefetchQuery(
      environmentDashboardQuery(scope, overviewSelection(deps.range)),
    );
  },
  component: EnvironmentOverview,
});

function EnvironmentOverview() {
  const { envId, orgId, projectId } = Route.useParams();
  const { range } = parseMetricSelection(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const environmentPath = `/o/${orgId}/p/${projectId}/e/${envId}`;

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>{environment.name}</Heading>
        <EnvironmentTypeBadge type={environment.type} />
        <StatusBadge status={environment.status} />
        {shell.access.getObservabilityMetrics ? (
          <div className="ml-auto">
            <RangeToggle
              onChange={(next) => void navigate({ search: { range: next } })}
              value={range}
            />
          </div>
        ) : null}
      </div>

      {shell.access.listBudgets ? <BudgetRefusalBanner scope={scope} /> : null}

      {shell.access.listAgentDefinitions ? <FirstAgent scope={scope} /> : null}

      <StatusStrip access={shell.access} scope={scope} />

      {shell.access.getObservabilityMetrics ? (
        <SectionBoundary resetKey={range}>
          <EnvironmentDashboard
            environmentPath={environmentPath}
            scope={scope}
            selection={overviewSelection(range)}
          />
        </SectionBoundary>
      ) : (
        <Text>
          Your role or token scopes do not include <Code>observability:read</Code>, so this
          environment&apos;s activity is hidden.
        </Text>
      )}

      <section className="flex flex-col gap-4">
        <Subheading>Details</Subheading>
        <DescriptionList>
          <DescriptionTerm>Environment ID</DescriptionTerm>
          <DescriptionDetails>
            <PublicId full value={environment.id} />
          </DescriptionDetails>
          <DescriptionTerm>Slug</DescriptionTerm>
          <DescriptionDetails>{environment.slug}</DescriptionDetails>
          <DescriptionTerm>Project ID</DescriptionTerm>
          <DescriptionDetails>
            <PublicId full value={environment.projectId} />
          </DescriptionDetails>
          <DescriptionTerm>Created</DescriptionTerm>
          <DescriptionDetails>
            <Timestamp value={environment.createdAt} />
          </DescriptionDetails>
          <DescriptionTerm>Updated</DescriptionTerm>
          <DescriptionDetails>
            <Timestamp value={environment.updatedAt} />
          </DescriptionDetails>
        </DescriptionList>
      </section>
    </div>
  );
}
