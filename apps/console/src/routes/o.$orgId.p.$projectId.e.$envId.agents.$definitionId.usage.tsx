import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { SourceNote } from "../components/observability/panels.tsx";
import { IntervalToggle, RangeToggle } from "../components/observability/selection-controls.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { AgentDeploymentUsage } from "../components/usage/agent-usage-view.tsx";
import { LedgerLoading, LedgerSection } from "../components/usage/ledger-section.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { agentUsageQuery, ledgerUsageQuery } from "../data/usage-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Subheading } from "@/components/ui/heading";
import { parseUsageSelection, type UsagePeriod } from "../usage/selection.ts";

function parsePeriod(search: Readonly<Record<string, unknown>>): UsagePeriod {
  const { interval, range } = parseUsageSelection(search);
  return { interval, range };
}

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/agents/$definitionId/usage")({
  validateSearch: (search): Partial<UsagePeriod> => parsePeriod(search),
  loaderDeps: ({ search }) => parsePeriod(search),
  loader: async ({ context, deps, params }) => {
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    const scope: EnvironmentScope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    // Not awaited: the ledger and the deployment split stream into their boundaries while the
    // controls render.
    if (access.getUsageSummary) {
      void context.queryClient.prefetchQuery(
        ledgerUsageQuery(scope, deps, access.getCostSummary, params.definitionId),
      );
    }
    if (access.getObservabilityMetrics) {
      void context.queryClient.prefetchQuery(agentUsageQuery(scope, params.definitionId, deps));
    }
  },
  component: AgentUsage,
});

/**
 * The agent's metered usage from the ledger (its runs' own counters) and its split across
 * deployments from analytics (plan §6.1 tab 9, D7: totals from the ledger, breakdowns from the
 * hot plane).
 */
function AgentUsage() {
  const { definitionId, envId, orgId, projectId } = Route.useParams();
  const period = parsePeriod(Route.useSearch());
  const navigate = Route.useNavigate();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const { access } = shell;
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const select = (next: Partial<UsagePeriod>) => {
    // Re-parse so a range change also moves the interval to one the new range allows.
    void navigate({ search: parsePeriod({ ...period, ...next }) });
  };
  const resetKey = `${period.range}:${period.interval}`;
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-center gap-3">
        <Subheading>Usage</Subheading>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <IntervalToggle
            onChange={(interval) => select({ interval })}
            range={period.range}
            value={period.interval}
          />
          <RangeToggle onChange={(range) => select({ range })} value={period.range} />
        </div>
      </div>
      {access.getUsageSummary ? (
        <SectionBoundary fallback={<LedgerLoading />} resetKey={resetKey}>
          <LedgerSection
            definitionId={definitionId}
            includeCosts={access.getCostSummary}
            period={period}
            scope={scope}
          />
        </SectionBoundary>
      ) : null}
      {access.getObservabilityMetrics ? (
        <section className="flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <Subheading>By deployment</Subheading>
            <SourceNote source="analytics" />
          </div>
          <SectionBoundary resetKey={resetKey}>
            <AgentDeploymentUsage definitionId={definitionId} period={period} scope={scope} />
          </SectionBoundary>
        </section>
      ) : null}
    </div>
  );
}
