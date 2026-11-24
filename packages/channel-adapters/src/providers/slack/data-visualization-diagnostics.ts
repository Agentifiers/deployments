import type { SlackDataVisualizationNormalizationIssue } from "./data-visualization-types.ts";
import { SLACK_DATA_VISUALIZATION_LIMITS } from "./data-visualization-types.ts";
import {
  asRecord,
  readFiniteNumber,
  slackChartString,
  slackChartOptionalString,
  hasUniqueValues,
  normalizationIssue,
} from "./data-visualization-builders.ts";

function slackPieDataVisualizationIssues(
  chart: Record<string, unknown>,
  path: string,
): SlackDataVisualizationNormalizationIssue[] {
  const segments = Array.isArray(chart.segments) ? chart.segments : undefined;
  if (
    !segments ||
    segments.length < 1 ||
    segments.length > SLACK_DATA_VISUALIZATION_LIMITS.pieSegmentCount
  ) {
    return [
      normalizationIssue(
        `${path}.segments`,
        "pie_segment_invalid",
        `Pie charts require 1 to ${SLACK_DATA_VISUALIZATION_LIMITS.pieSegmentCount} segments.`,
      ),
    ];
  }
  return segments.flatMap((segment, index) => {
    const record = asRecord(segment);
    const label = record
      ? slackChartString(record.label, SLACK_DATA_VISUALIZATION_LIMITS.labelLength)
      : undefined;
    const value = record ? readFiniteNumber(record.value) : undefined;
    return record && label && value !== undefined && value > 0
      ? []
      : [
          normalizationIssue(
            `${path}.segments[${index}]`,
            "pie_segment_invalid",
            `Pie segments require a label up to ${SLACK_DATA_VISUALIZATION_LIMITS.labelLength} characters and a positive numeric value.`,
          ),
        ];
  });
}

function slackAxisCategories(value: unknown): string[] | undefined {
  const axisConfig = asRecord(value);
  if (!axisConfig || !Array.isArray(axisConfig.categories)) return undefined;
  const categories = axisConfig.categories.flatMap((category) => {
    const label = slackChartString(category, SLACK_DATA_VISUALIZATION_LIMITS.labelLength);
    return label ? [label] : [];
  });
  if (
    categories.length !== axisConfig.categories.length ||
    categories.length < 1 ||
    categories.length > SLACK_DATA_VISUALIZATION_LIMITS.categoryCount ||
    !hasUniqueValues(categories)
  ) {
    return undefined;
  }
  return categories;
}

function slackAxisConfigIssues(
  axisConfig: Record<string, unknown> | null,
  path: string,
): SlackDataVisualizationNormalizationIssue[] {
  const issues: SlackDataVisualizationNormalizationIssue[] = [];
  const categories = slackAxisCategories(axisConfig);
  if (!categories) {
    issues.push(
      normalizationIssue(
        `${path}.categories`,
        "axis_categories_invalid",
        `Series charts require 1 to ${SLACK_DATA_VISUALIZATION_LIMITS.categoryCount} unique categories, each up to ${SLACK_DATA_VISUALIZATION_LIMITS.labelLength} characters.`,
      ),
    );
  }
  const xLabel = axisConfig
    ? slackChartOptionalString(
        axisConfig.x_label ?? axisConfig.xLabel,
        SLACK_DATA_VISUALIZATION_LIMITS.axisLabelLength,
      )
    : undefined;
  const yLabel = axisConfig
    ? slackChartOptionalString(
        axisConfig.y_label ?? axisConfig.yLabel,
        SLACK_DATA_VISUALIZATION_LIMITS.axisLabelLength,
      )
    : undefined;
  if (axisConfig?.x_label !== undefined && !xLabel) {
    issues.push(
      normalizationIssue(
        `${path}.x_label`,
        "axis_label_invalid",
        `The x-axis label must be 1 to ${SLACK_DATA_VISUALIZATION_LIMITS.axisLabelLength} characters when provided.`,
      ),
    );
  }
  if (axisConfig?.xLabel !== undefined && !xLabel) {
    issues.push(
      normalizationIssue(
        `${path}.xLabel`,
        "axis_label_invalid",
        `The x-axis label must be 1 to ${SLACK_DATA_VISUALIZATION_LIMITS.axisLabelLength} characters when provided.`,
      ),
    );
  }
  if (axisConfig?.y_label !== undefined && !yLabel) {
    issues.push(
      normalizationIssue(
        `${path}.y_label`,
        "axis_label_invalid",
        `The y-axis label must be 1 to ${SLACK_DATA_VISUALIZATION_LIMITS.axisLabelLength} characters when provided.`,
      ),
    );
  }
  if (axisConfig?.yLabel !== undefined && !yLabel) {
    issues.push(
      normalizationIssue(
        `${path}.yLabel`,
        "axis_label_invalid",
        `The y-axis label must be 1 to ${SLACK_DATA_VISUALIZATION_LIMITS.axisLabelLength} characters when provided.`,
      ),
    );
  }
  return issues;
}

function slackSeriesDataVisualizationIssues(
  chart: Record<string, unknown>,
  path: string,
): SlackDataVisualizationNormalizationIssue[] {
  const axisPath = `${path}.axis_config`;
  const axisConfig = asRecord(chart.axis_config ?? chart.axisConfig);
  const categories = slackAxisCategories(axisConfig);
  const issues = slackAxisConfigIssues(axisConfig, axisPath);
  const series = Array.isArray(chart.series) ? chart.series : undefined;
  if (!series || series.length < 1 || series.length > SLACK_DATA_VISUALIZATION_LIMITS.seriesCount) {
    issues.push(
      normalizationIssue(
        `${path}.series`,
        "series_invalid",
        `Series charts require 1 to ${SLACK_DATA_VISUALIZATION_LIMITS.seriesCount} data series.`,
      ),
    );
    return issues;
  }

  const categorySet = new Set(categories ?? []);
  const seriesNames = new Set<string>();
  for (const [seriesIndex, item] of series.entries()) {
    const seriesPath = `${path}.series[${seriesIndex}]`;
    const record = asRecord(item);
    const name = record
      ? slackChartString(record.name, SLACK_DATA_VISUALIZATION_LIMITS.labelLength)
      : undefined;
    if (!record || !name) {
      issues.push(
        normalizationIssue(
          `${seriesPath}.name`,
          "series_name_invalid",
          `Each data series requires a name up to ${SLACK_DATA_VISUALIZATION_LIMITS.labelLength} characters.`,
        ),
      );
      continue;
    }
    if (seriesNames.has(name)) {
      issues.push(
        normalizationIssue(
          `${seriesPath}.name`,
          "series_name_duplicate",
          "Each data series name must be unique within the chart.",
        ),
      );
    }
    seriesNames.add(name);

    const data = Array.isArray(record.data) ? record.data : undefined;
    if (!data || !categories || data.length !== categories.length) {
      issues.push(
        normalizationIssue(
          `${seriesPath}.data`,
          "series_data_invalid",
          "Each data series must include exactly one point for every axis category.",
        ),
      );
      continue;
    }
    const pointLabels = new Set<string>();
    for (const [pointIndex, point] of data.entries()) {
      const pointPath = `${seriesPath}.data[${pointIndex}]`;
      const pointRecord = asRecord(point);
      const label = pointRecord
        ? slackChartString(pointRecord.label, SLACK_DATA_VISUALIZATION_LIMITS.labelLength)
        : undefined;
      const value = pointRecord ? readFiniteNumber(pointRecord.value) : undefined;
      if (
        !pointRecord ||
        !label ||
        value === undefined ||
        !categorySet.has(label) ||
        pointLabels.has(label)
      ) {
        issues.push(
          normalizationIssue(
            pointPath,
            "series_data_invalid",
            "Each data point needs a category label from axis_config.categories and a numeric value.",
          ),
        );
      } else {
        pointLabels.add(label);
      }
    }
  }
  return issues;
}

export function slackDataVisualizationInputIssues(
  value: unknown,
  path: string,
): SlackDataVisualizationNormalizationIssue[] {
  const record = asRecord(value);
  if (!record) {
    return [
      normalizationIssue(
        path,
        "chart_invalid",
        "Slack data visualization entries must be objects.",
      ),
    ];
  }
  const issues: SlackDataVisualizationNormalizationIssue[] = [];
  if (!slackChartString(record.title, SLACK_DATA_VISUALIZATION_LIMITS.titleLength)) {
    issues.push(
      normalizationIssue(
        `${path}.title`,
        "title_invalid",
        `Slack data visualization titles must be 1 to ${SLACK_DATA_VISUALIZATION_LIMITS.titleLength} characters.`,
      ),
    );
  }
  const blockId = record.blockId ?? record.block_id;
  if (
    blockId !== undefined &&
    !slackChartOptionalString(blockId, SLACK_DATA_VISUALIZATION_LIMITS.blockIdLength)
  ) {
    issues.push(
      normalizationIssue(
        `${path}.blockId`,
        "block_id_invalid",
        `Slack data visualization block ids must be 1 to ${SLACK_DATA_VISUALIZATION_LIMITS.blockIdLength} characters when provided.`,
      ),
    );
  }
  if (
    record.accessibilityText !== undefined &&
    !slackChartOptionalString(
      record.accessibilityText,
      SLACK_DATA_VISUALIZATION_LIMITS.accessibilityTextLength,
    )
  ) {
    issues.push(
      normalizationIssue(
        `${path}.accessibilityText`,
        "accessibility_text_invalid",
        `Slack chart accessibility text must be 1 to ${SLACK_DATA_VISUALIZATION_LIMITS.accessibilityTextLength} characters when provided.`,
      ),
    );
  }

  const chart = asRecord(record.chart);
  if (!chart) {
    issues.push(
      normalizationIssue(`${path}.chart`, "chart_missing", "A chart payload is required."),
    );
    return issues;
  }
  const chartType = slackChartString(chart.type, SLACK_DATA_VISUALIZATION_LIMITS.labelLength);
  if (!chartType || !["area", "bar", "line", "pie"].includes(chartType)) {
    issues.push(
      normalizationIssue(
        `${path}.chart.type`,
        "chart_type_invalid",
        "Chart type must be one of pie, bar, area, or line.",
      ),
    );
    return issues;
  }
  if (chartType === "pie") {
    issues.push(...slackPieDataVisualizationIssues(chart, `${path}.chart`));
  } else {
    issues.push(...slackSeriesDataVisualizationIssues(chart, `${path}.chart`));
  }
  return issues;
}
