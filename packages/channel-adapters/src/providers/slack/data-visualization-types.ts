export type SlackDataVisualizationChartType = "area" | "bar" | "line" | "pie";

export interface SlackDataVisualizationSegment {
  label: string;
  value: number;
}

export interface SlackDataVisualizationDataPoint {
  label: string;
  value: number;
}

export interface SlackDataVisualizationDataSeries {
  data: SlackDataVisualizationDataPoint[];
  name: string;
}

export interface SlackDataVisualizationAxisConfig {
  categories: string[];
  x_label?: string;
  y_label?: string;
}

export interface SlackPieDataVisualizationChart {
  segments: SlackDataVisualizationSegment[];
  type: "pie";
}

export interface SlackSeriesDataVisualizationChart {
  axis_config: SlackDataVisualizationAxisConfig;
  series: SlackDataVisualizationDataSeries[];
  type: "area" | "bar" | "line";
}

export type SlackDataVisualizationChart =
  | SlackPieDataVisualizationChart
  | SlackSeriesDataVisualizationChart;

export interface SlackDataVisualizationSpec {
  accessibilityText?: string;
  blockId?: string;
  chart: SlackDataVisualizationChart;
  title: string;
}

export interface SlackDataVisualizationBlock {
  block_id?: string;
  chart: SlackDataVisualizationChart;
  title: string;
  type: "data_visualization";
}

export interface SlackRunResultVisualization {
  accessibilityText?: string;
  block: SlackDataVisualizationBlock;
}

export type SlackDataVisualizationNormalizationIssueCode =
  | "accessibility_text_invalid"
  | "axis_categories_invalid"
  | "axis_label_invalid"
  | "block_id_duplicate"
  | "block_id_invalid"
  | "chart_invalid"
  | "chart_missing"
  | "chart_type_invalid"
  | "input_not_array"
  | "pie_segment_invalid"
  | "series_data_invalid"
  | "series_invalid"
  | "series_name_duplicate"
  | "series_name_invalid"
  | "title_invalid";

export interface SlackDataVisualizationNormalizationIssue {
  code: SlackDataVisualizationNormalizationIssueCode;
  message: string;
  path: string;
}

export interface SlackDataVisualizationNormalizationResult {
  issues: SlackDataVisualizationNormalizationIssue[];
  specs: SlackDataVisualizationSpec[];
}

export const SLACK_DATA_VISUALIZATION_LIMITS = {
  accessibilityTextLength: 500,
  axisLabelLength: 50,
  blockIdLength: 255,
  categoryCount: 20,
  labelLength: 20,
  pieSegmentCount: 12,
  seriesCount: 12,
  titleLength: 50,
} as const;

const SLACK_DATA_VISUALIZATION_DATA_POINT_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["label", "value"],
  properties: {
    label: { type: "string", maxLength: SLACK_DATA_VISUALIZATION_LIMITS.labelLength },
    value: { type: "number" },
  },
} as const;

const SLACK_DATA_VISUALIZATION_AXIS_CONFIG_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["categories"],
  properties: {
    categories: {
      type: "array",
      minItems: 1,
      maxItems: SLACK_DATA_VISUALIZATION_LIMITS.categoryCount,
      items: { type: "string", maxLength: SLACK_DATA_VISUALIZATION_LIMITS.labelLength },
    },
    x_label: { type: "string", maxLength: SLACK_DATA_VISUALIZATION_LIMITS.axisLabelLength },
    y_label: { type: "string", maxLength: SLACK_DATA_VISUALIZATION_LIMITS.axisLabelLength },
  },
} as const;

export const SLACK_DATA_VISUALIZATION_SPEC_ARRAY_INPUT_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["title", "chart"],
    properties: {
      accessibilityText: {
        type: "string",
        maxLength: SLACK_DATA_VISUALIZATION_LIMITS.accessibilityTextLength,
      },
      blockId: { type: "string", maxLength: SLACK_DATA_VISUALIZATION_LIMITS.blockIdLength },
      chart: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "segments"],
            properties: {
              type: { const: "pie" },
              segments: {
                type: "array",
                minItems: 1,
                maxItems: SLACK_DATA_VISUALIZATION_LIMITS.pieSegmentCount,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["label", "value"],
                  properties: {
                    label: {
                      type: "string",
                      maxLength: SLACK_DATA_VISUALIZATION_LIMITS.labelLength,
                    },
                    value: { type: "number", exclusiveMinimum: 0 },
                  },
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "axis_config", "series"],
            properties: {
              type: { enum: ["area", "bar", "line"] },
              axis_config: SLACK_DATA_VISUALIZATION_AXIS_CONFIG_INPUT_SCHEMA,
              series: {
                type: "array",
                minItems: 1,
                maxItems: SLACK_DATA_VISUALIZATION_LIMITS.seriesCount,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["name", "data"],
                  properties: {
                    name: {
                      type: "string",
                      maxLength: SLACK_DATA_VISUALIZATION_LIMITS.labelLength,
                    },
                    data: {
                      type: "array",
                      minItems: 1,
                      maxItems: SLACK_DATA_VISUALIZATION_LIMITS.categoryCount,
                      items: SLACK_DATA_VISUALIZATION_DATA_POINT_INPUT_SCHEMA,
                    },
                  },
                },
              },
            },
          },
        ],
      },
      title: { type: "string", maxLength: SLACK_DATA_VISUALIZATION_LIMITS.titleLength },
    },
  },
} as const;
