import { OBSERVABILITY_METRIC_GROUPS } from "@deployments-ai/api-contract/observability";
import {
  METRIC_RANGES,
  oneOf,
  RANGE_INTERVALS,
  RANGE_LABELS,
  type MetricGroupBy,
  type MetricInterval,
  type MetricRange,
} from "../../observability/range.ts";
import { NativeSelect } from "@/components/ui/native-select";
import { SingleToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const RANGE_SHORT_LABELS: Readonly<Record<MetricRange, string>> = {
  "24h": "24h",
  "30d": "30d",
  "7d": "7d",
};
const INTERVAL_LABELS: Readonly<Record<MetricInterval, string>> = { day: "Daily", hour: "Hourly" };

export const GROUP_BY_LABELS: Readonly<Record<MetricGroupBy, string>> = {
  agentDefinitionId: "Agent",
  agentDeploymentId: "Deployment",
  agentReleaseId: "Release",
  model: "Model",
  provider: "Provider",
};

export function RangeToggle({
  onChange,
  value,
}: Readonly<{ onChange: (range: MetricRange) => void; value: MetricRange }>) {
  return (
    <SingleToggleGroup
      aria-label="Time range"
      onValueChange={(next) => {
        const range = oneOf(METRIC_RANGES, next);
        if (range) onChange(range);
      }}
      size="sm"
      value={value}
    >
      {METRIC_RANGES.map((range) => (
        <ToggleGroupItem aria-label={RANGE_LABELS[range]} key={range} value={range}>
          {RANGE_SHORT_LABELS[range]}
        </ToggleGroupItem>
      ))}
    </SingleToggleGroup>
  );
}

/** Bucket width; only the widths the range allows are offered. */
export function IntervalToggle({
  onChange,
  range,
  value,
}: Readonly<{
  onChange: (interval: MetricInterval) => void;
  range: MetricRange;
  value: MetricInterval;
}>) {
  const allowed = RANGE_INTERVALS[range];
  return (
    <SingleToggleGroup
      aria-label="Bucket width"
      onValueChange={(next) => {
        const interval = oneOf(allowed, next);
        if (interval) onChange(interval);
      }}
      size="sm"
      value={value}
    >
      {allowed.map((interval) => (
        <ToggleGroupItem key={interval} value={interval}>
          {INTERVAL_LABELS[interval]}
        </ToggleGroupItem>
      ))}
    </SingleToggleGroup>
  );
}

export function GroupBySelect({
  onChange,
  value,
}: Readonly<{
  onChange: (groupBy: MetricGroupBy | undefined) => void;
  value: MetricGroupBy | undefined;
}>) {
  // NativeSelect fills its container, so the wrapper sets the width.
  return (
    <div className="w-44">
      <NativeSelect
        aria-label="Group by"
        onChange={(event) => onChange(oneOf(OBSERVABILITY_METRIC_GROUPS, event.target.value))}
        value={value ?? ""}
      >
        <option value="">No grouping</option>
        {OBSERVABILITY_METRIC_GROUPS.map((groupBy) => (
          <option key={groupBy} value={groupBy}>
            By {GROUP_BY_LABELS[groupBy].toLowerCase()}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}
