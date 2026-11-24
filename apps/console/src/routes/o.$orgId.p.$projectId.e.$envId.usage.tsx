import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { SourceNote } from "../components/observability/panels.tsx";
import { IntervalToggle, RangeToggle } from "../components/observability/selection-controls.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { BreakdownSection, BreakdownSelect } from "../components/usage/breakdown-section.tsx";
import { LedgerLoading, LedgerSection } from "../components/usage/ledger-section.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { ledgerUsageQuery, usageBreakdownQuery } from "../data/usage-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Heading, Subheading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";
import { parseUsageSelection, type UsageSelection } from "../usage/selection.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/usage")({
  validateSearch: (search): Partial<UsageSelection> => parseUsageSelection(search),
  loaderDeps: ({ search }) => parseUsageSelection(search),
  loader: async ({ context, deps, params }) => {
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    const scope: EnvironmentScope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    // Not awaited: the ledger and the breakdowns stream into their boundaries while the controls
    // render.
    if (access.getUsageSummary) {
      void context.queryClient.prefetchQuery(ledgerUsageQuery(scope, deps, access.getCostSummary));
    }
    if (access.getObservabilityMetrics) {
      void context.queryClient.prefetchQuery(usageBreakdownQuery(scope, deps));
    }
  },
  component: Usage,
});

function Usage() {
  const { envId, orgId, projectId } = Route.useParams();
  const selection = parseUsageSelection(Route.useSearch());
  const navigate = Route.useNavigate();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const { access } = shell;
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const select = (next: Partial<UsageSelection>) => {
    // Re-parse so a range change also moves the interval to one the new range allows.
    void navigate({ search: parseUsageSelection({ ...selection, ...next }) });
  };
  const period = `${selection.range}:${selection.interval}`;
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>Usage</Heading>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <IntervalToggle
            onChange={(interval) => select({ interval })}
            range={selection.range}
            value={selection.interval}
          />
          <RangeToggle onChange={(range) => select({ range })} value={selection.range} />
        </div>
      </div>
      {access.getUsageSummary ? (
        <SectionBoundary fallback={<LedgerLoading />} resetKey={period}>
          <LedgerSection includeCosts={access.getCostSummary} period={selection} scope={scope} />
        </SectionBoundary>
      ) : (
        <Text>Your role or token scopes do not permit reading the usage ledger (usage:read).</Text>
      )}
      {access.getObservabilityMetrics ? (
        <section className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-col gap-1">
              <Subheading>Breakdowns</Subheading>
              <SourceNote source="analytics" />
            </div>
            <div className="ml-auto">
              <BreakdownSelect
                onChange={(groupBy) => select({ groupBy })}
                value={selection.groupBy}
              />
            </div>
          </div>
          <SectionBoundary resetKey={`${period}:${selection.groupBy}`}>
            <BreakdownSection scope={scope} selection={selection} />
          </SectionBoundary>
        </section>
      ) : null}
    </div>
  );
}
