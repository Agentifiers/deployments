import type {
  SlackDataVisualizationDataPoint,
  SlackPieDataVisualizationChart,
  SlackSeriesDataVisualizationChart,
  SlackDataVisualizationSpec,
  SlackDataVisualizationBlock,
  SlackDataVisualizationNormalizationIssueCode,
  SlackDataVisualizationNormalizationIssue,
} from "./data-visualization-types.ts";
import { SLACK_DATA_VISUALIZATION_LIMITS } from "./data-visualization-types.ts";

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function slackChartString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : undefined;
}

export function slackChartOptionalString(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return slackChartString(value, maxLength);
}

export function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export function normalizationIssue(
  path: string,
  code: SlackDataVisualizationNormalizationIssueCode,
  message: string,
): SlackDataVisualizationNormalizationIssue {
  return { code, message, path };
}

function buildSlackPieDataVisualizationChart(
  chart: SlackPieDataVisualizationChart,
): SlackPieDataVisualizationChart | undefined {
  if (
    chart.type !== "pie" ||
    chart.segments.length < 1 ||
    chart.segments.length > SLACK_DATA_VISUALIZATION_LIMITS.pieSegmentCount
  ) {
    return undefined;
  }
  const segments = chart.segments.flatMap((segment) => {
    const label = slackChartString(segment.label, SLACK_DATA_VISUALIZATION_LIMITS.labelLength);
    const value = readFiniteNumber(segment.value);
    return label && value !== undefined && value > 0 ? [{ label, value }] : [];
  });
  return segments.length === chart.segments.length ? { type: "pie", segments } : undefined;
}

function buildSlackSeriesDataVisualizationChart(
  chart: SlackSeriesDataVisualizationChart,
): SlackSeriesDataVisualizationChart | undefined {
  if (
    !["area", "bar", "line"].includes(chart.type) ||
    chart.series.length < 1 ||
    chart.series.length > SLACK_DATA_VISUALIZATION_LIMITS.seriesCount
  ) {
    return undefined;
  }
  const categories = chart.axis_config.categories.flatMap((category) => {
    const label = slackChartString(category, SLACK_DATA_VISUALIZATION_LIMITS.labelLength);
    return label ? [label] : [];
  });
  if (
    categories.length !== chart.axis_config.categories.length ||
    categories.length < 1 ||
    categories.length > SLACK_DATA_VISUALIZATION_LIMITS.categoryCount ||
    !hasUniqueValues(categories)
  ) {
    return undefined;
  }
  const xLabel = slackChartOptionalString(
    chart.axis_config.x_label,
    SLACK_DATA_VISUALIZATION_LIMITS.axisLabelLength,
  );
  const yLabel = slackChartOptionalString(
    chart.axis_config.y_label,
    SLACK_DATA_VISUALIZATION_LIMITS.axisLabelLength,
  );
  if (
    (chart.axis_config.x_label !== undefined && !xLabel) ||
    (chart.axis_config.y_label !== undefined && !yLabel)
  ) {
    return undefined;
  }

  const categorySet = new Set(categories);
  const series = chart.series.flatMap((dataSeries) => {
    const name = slackChartString(dataSeries.name, SLACK_DATA_VISUALIZATION_LIMITS.labelLength);
    if (!name || dataSeries.data.length !== categories.length) return [];
    const pointsByLabel = new Map<string, SlackDataVisualizationDataPoint>();
    for (const point of dataSeries.data) {
      const label = slackChartString(point.label, SLACK_DATA_VISUALIZATION_LIMITS.labelLength);
      const value = readFiniteNumber(point.value);
      if (!label || value === undefined || !categorySet.has(label) || pointsByLabel.has(label)) {
        return [];
      }
      pointsByLabel.set(label, { label, value });
    }
    if (pointsByLabel.size !== categories.length) return [];
    return [
      {
        name,
        data: categories.map(
          (category) => pointsByLabel.get(category) as SlackDataVisualizationDataPoint,
        ),
      },
    ];
  });
  if (series.length !== chart.series.length || !hasUniqueValues(series.map((item) => item.name))) {
    return undefined;
  }
  return {
    axis_config: {
      categories,
      ...(xLabel ? { x_label: xLabel } : {}),
      ...(yLabel ? { y_label: yLabel } : {}),
    },
    series,
    type: chart.type,
  };
}

export function buildSlackDataVisualizationBlock(
  spec: SlackDataVisualizationSpec,
): SlackDataVisualizationBlock | undefined {
  const title = slackChartString(spec.title, SLACK_DATA_VISUALIZATION_LIMITS.titleLength);
  if (!title) return undefined;
  const blockId = slackChartOptionalString(
    spec.blockId,
    SLACK_DATA_VISUALIZATION_LIMITS.blockIdLength,
  );
  if (spec.blockId !== undefined && !blockId) return undefined;
  const chart =
    spec.chart.type === "pie"
      ? buildSlackPieDataVisualizationChart(spec.chart)
      : buildSlackSeriesDataVisualizationChart(spec.chart);
  if (!chart) return undefined;
  return {
    ...(blockId ? { block_id: blockId } : {}),
    chart,
    title,
    type: "data_visualization",
  };
}
