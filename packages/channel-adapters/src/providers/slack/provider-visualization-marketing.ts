import { type SlackDataVisualizationSpec } from "./data-visualization.ts";

import {
  readNumber,
  readString,
  nestedRecord,
  uniqueChartRows,
  recordsAtKey,
  topRows,
  performanceSeries,
  performanceYAxis,
  validSpec,
  barSpec,
} from "./provider-visualization-shared.ts";

export function googleAdsVisualization(value: unknown): SlackDataVisualizationSpec[] {
  const rows = recordsAtKey(value, "results").flatMap((row) => {
    const campaign = nestedRecord(row, "campaign");
    const metrics = nestedRecord(row, "metrics");
    const label = readString(campaign, ["name", "id"]) ?? readString(row, ["campaign_name"]);
    if (!label) return [];
    const costMicros = readNumber(metrics?.costMicros ?? metrics?.cost_micros ?? row.cost_micros);
    const clicks = readNumber(metrics?.clicks ?? row.clicks);
    const conversions = readNumber(metrics?.conversions ?? row.conversions);
    const spend = costMicros !== undefined ? costMicros / 1_000_000 : readNumber(row.spend);
    return [
      {
        ...(clicks !== undefined ? { clicks } : {}),
        ...(conversions !== undefined ? { conversions } : {}),
        label,
        ...(spend !== undefined ? { spend } : {}),
      },
    ];
  });
  const chartRows = uniqueChartRows(topRows(rows, ["conversions", "clicks", "spend"]), 6);
  return validSpec(
    barSpec({
      blockId: "deployments-ai-google-ads-campaigns",
      rows: chartRows,
      series: performanceSeries(chartRows),
      title: "Campaign performance",
      xLabel: "Campaign",
      yLabel: performanceYAxis(chartRows),
    }),
  );
}
