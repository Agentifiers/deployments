import { createFileRoute } from "@tanstack/react-router";
import { MetricsView } from "../components/observability/metrics-view.tsx";
import { AnalyticsBadge } from "../components/observability/panels.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import {
  GroupBySelect,
  IntervalToggle,
  RangeToggle,
} from "../components/observability/selection-controls.tsx";
import { metricsQuery } from "../data/observability-queries.ts";
import { parseMetricSelection, type MetricSelection } from "../observability/range.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Heading } from "@/components/ui/heading";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/metrics")({
  validateSearch: (search): Partial<MetricSelection> => parseMetricSelection(search),
  loaderDeps: ({ search }) => parseMetricSelection(search),
  loader: ({ context, deps, params }) => {
    // Not awaited: the charts stream into their boundary while the controls render.
    void context.queryClient.prefetchQuery(
      metricsQuery(
        { environmentId: params.envId, organizationId: params.orgId, projectId: params.projectId },
        deps,
      ),
    );
  },
  component: Metrics,
});

function Metrics() {
  const { envId, orgId, projectId } = Route.useParams();
  const selection = parseMetricSelection(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const select = (next: {
    readonly [Key in keyof MetricSelection]?: MetricSelection[Key] | undefined;
  }) => {
    // Re-parse so a range change also moves the interval to one the new range allows.
    const { groupBy, interval, range } = parseMetricSelection({ ...selection, ...next });
    void navigate({ search: { interval, range, ...(groupBy ? { groupBy } : {}) } });
  };
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>Metrics</Heading>
        <AnalyticsBadge />
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <GroupBySelect onChange={(groupBy) => select({ groupBy })} value={selection.groupBy} />
          <IntervalToggle
            onChange={(interval) => select({ interval })}
            range={selection.range}
            value={selection.interval}
          />
          <RangeToggle onChange={(range) => select({ range })} value={selection.range} />
        </div>
      </div>
      <SectionBoundary
        resetKey={`${selection.range}:${selection.interval}:${selection.groupBy ?? ""}`}
      >
        <MetricsView scope={scope} selection={selection} />
      </SectionBoundary>
    </div>
  );
}
