import type {
  SlackDataVisualizationSegment,
  SlackDataVisualizationDataSeries,
  SlackDataVisualizationAxisConfig,
  SlackDataVisualizationChart,
  SlackDataVisualizationSpec,
  SlackRunResultVisualization,
  SlackDataVisualizationNormalizationIssue,
  SlackDataVisualizationNormalizationResult,
} from "./data-visualization-types.ts";
import { SLACK_DATA_VISUALIZATION_LIMITS } from "./data-visualization-types.ts";
import {
  asRecord,
  readStringField,
  readFiniteNumber,
  slackChartString,
  slackChartOptionalString,
  normalizationIssue,
  buildSlackDataVisualizationBlock,
} from "./data-visualization-builders.ts";
import { slackDataVisualizationInputIssues } from "./data-visualization-diagnostics.ts";

function readSlackDataVisualizationSegments(value: unknown): SlackDataVisualizationSegment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    const label = slackChartString(record.label, SLACK_DATA_VISUALIZATION_LIMITS.labelLength);
    const segmentValue = readFiniteNumber(record.value);
    return label && segmentValue !== undefined ? [{ label, value: segmentValue }] : [];
  });
}

function readSlackDataVisualizationSeries(value: unknown): SlackDataVisualizationDataSeries[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const name = record
      ? slackChartString(record.name, SLACK_DATA_VISUALIZATION_LIMITS.labelLength)
      : undefined;
    if (!record || !name || !Array.isArray(record.data)) return [];
    const data = record.data.flatMap((point) => {
      const pointRecord = asRecord(point);
      const label = pointRecord
        ? slackChartString(pointRecord.label, SLACK_DATA_VISUALIZATION_LIMITS.labelLength)
        : undefined;
      const pointValue = pointRecord ? readFiniteNumber(pointRecord.value) : undefined;
      return label && pointValue !== undefined ? [{ label, value: pointValue }] : [];
    });
    return data.length === record.data.length ? [{ data, name }] : [];
  });
}

function readSlackDataVisualizationAxisConfig(
  value: unknown,
): SlackDataVisualizationAxisConfig | undefined {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.categories)) return undefined;
  const categories = record.categories.flatMap((category) => {
    const label = slackChartString(category, SLACK_DATA_VISUALIZATION_LIMITS.labelLength);
    return label ? [label] : [];
  });
  if (categories.length !== record.categories.length) return undefined;
  const xLabel = slackChartOptionalString(
    record.x_label ?? record.xLabel,
    SLACK_DATA_VISUALIZATION_LIMITS.axisLabelLength,
  );
  const yLabel = slackChartOptionalString(
    record.y_label ?? record.yLabel,
    SLACK_DATA_VISUALIZATION_LIMITS.axisLabelLength,
  );
  return {
    categories,
    ...(xLabel ? { x_label: xLabel } : {}),
    ...(yLabel ? { y_label: yLabel } : {}),
  };
}

function readSlackDataVisualizationSpecInput(
  value: unknown,
): SlackDataVisualizationSpec | undefined {
  const record = asRecord(value);
  const chartRecord = asRecord(record?.chart);
  const title = record
    ? slackChartString(record.title, SLACK_DATA_VISUALIZATION_LIMITS.titleLength)
    : undefined;
  const chartType = chartRecord
    ? slackChartString(chartRecord.type, SLACK_DATA_VISUALIZATION_LIMITS.labelLength)
    : undefined;
  if (!record || !chartRecord || !title || !chartType) return undefined;
  let chart: SlackDataVisualizationChart | undefined;
  if (chartType === "pie") {
    chart = {
      segments: readSlackDataVisualizationSegments(chartRecord.segments),
      type: "pie",
    };
  } else if (chartType === "area" || chartType === "bar" || chartType === "line") {
    chart = {
      axis_config: readSlackDataVisualizationAxisConfig(
        chartRecord.axis_config ?? chartRecord.axisConfig,
      ) ?? { categories: [] },
      series: readSlackDataVisualizationSeries(chartRecord.series),
      type: chartType,
    };
  }
  if (!chart) return undefined;
  const blockId = readStringField(record, ["blockId", "block_id"]);
  const block = buildSlackDataVisualizationBlock({
    ...(blockId ? { blockId } : {}),
    chart,
    title,
  });
  if (!block) return undefined;
  const accessibilityText = slackChartOptionalString(
    record.accessibilityText,
    SLACK_DATA_VISUALIZATION_LIMITS.accessibilityTextLength,
  );
  if (record.accessibilityText !== undefined && !accessibilityText) return undefined;
  return {
    ...(accessibilityText ? { accessibilityText } : {}),
    ...(block.block_id ? { blockId: block.block_id } : {}),
    chart: block.chart,
    title: block.title,
  };
}

export function normalizeSlackDataVisualizationSpecsWithDiagnostics(
  value: unknown,
): SlackDataVisualizationNormalizationResult {
  if (!Array.isArray(value)) {
    return {
      issues:
        value === undefined
          ? []
          : [
              normalizationIssue(
                "$",
                "input_not_array",
                "Slack data visualizations must be provided as an array.",
              ),
            ],
      specs: [],
    };
  }
  const seenBlockIds = new Set<string>();
  const issues: SlackDataVisualizationNormalizationIssue[] = [];
  const specs = value.flatMap((item, index) => {
    const path = `$[${index}]`;
    const itemIssues = slackDataVisualizationInputIssues(item, path);
    if (itemIssues.length > 0) {
      issues.push(...itemIssues);
      return [];
    }
    const spec = readSlackDataVisualizationSpecInput(item);
    if (!spec) {
      issues.push(...slackDataVisualizationInputIssues(item, path));
      return [];
    }
    if (!spec.blockId) return [spec];
    if (seenBlockIds.has(spec.blockId)) {
      issues.push(
        normalizationIssue(
          `${path}.blockId`,
          "block_id_duplicate",
          "Duplicate Slack data visualization block ids are ignored.",
        ),
      );
      return [];
    }
    seenBlockIds.add(spec.blockId);
    return [spec];
  });
  return { issues, specs };
}

export function normalizeSlackDataVisualizationSpecs(value: unknown): SlackDataVisualizationSpec[] {
  return normalizeSlackDataVisualizationSpecsWithDiagnostics(value).specs;
}

function readSlackDataVisualizationSpec(value: unknown): SlackRunResultVisualization | undefined {
  const spec = readSlackDataVisualizationSpecInput(value);
  if (!spec) return undefined;
  const block = buildSlackDataVisualizationBlock(spec);
  if (!block) return undefined;
  return {
    block,
    ...(spec.accessibilityText ? { accessibilityText: spec.accessibilityText } : {}),
  };
}

export function readSlackDataVisualizationSpecs(value: unknown): SlackRunResultVisualization[] {
  return normalizeSlackDataVisualizationSpecs(value).flatMap((item) => {
    const visualization = readSlackDataVisualizationSpec(item);
    return visualization ? [visualization] : [];
  });
}
