import { createHash } from "node:crypto";

import {
  normalizeSlackDataVisualizationSpecs,
  type SlackDataVisualizationSpec,
} from "../slack/data-visualization.ts";

/**
 * Renders normalized data visualization specs (the shared `dataVisualizations` input contract
 * validated by the Slack normalizer) as Adaptive Card 1.5 chart elements supported by Teams:
 * https://learn.microsoft.com/microsoftteams/platform/task-modules-and-cards/cards/charts-in-adaptive-cards
 */

export const TEAMS_ADAPTIVE_CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";
export const TEAMS_ADAPTIVE_CARD_SCHEMA = "http://adaptivecards.io/schemas/adaptive-card.json";
export const TEAMS_ADAPTIVE_CARD_VERSION = "1.5";

export interface TeamsAdaptiveCardTextBlock {
  readonly text: string;
  readonly type: "TextBlock";
  readonly wrap: true;
}

export interface TeamsAdaptiveCardPieChart {
  readonly data: readonly { readonly legend: string; readonly value: number }[];
  readonly fallback: TeamsAdaptiveCardTextBlock;
  readonly title: string;
  readonly type: "Chart.Pie";
}

interface TeamsAdaptiveCardAxisTitles {
  readonly xAxisTitle?: string;
  readonly yAxisTitle?: string;
}

export interface TeamsAdaptiveCardVerticalBarChart extends TeamsAdaptiveCardAxisTitles {
  readonly data: readonly { readonly x: string; readonly y: number }[];
  readonly fallback: TeamsAdaptiveCardTextBlock;
  readonly title: string;
  readonly type: "Chart.VerticalBar";
}

export interface TeamsAdaptiveCardSeriesChart extends TeamsAdaptiveCardAxisTitles {
  readonly data: readonly {
    readonly legend: string;
    readonly values: readonly { readonly x: string; readonly y: number }[];
  }[];
  readonly fallback: TeamsAdaptiveCardTextBlock;
  readonly title: string;
  readonly type: "Chart.Line" | "Chart.VerticalBar.Grouped";
}

export type TeamsAdaptiveCardChartElement =
  | TeamsAdaptiveCardPieChart
  | TeamsAdaptiveCardSeriesChart
  | TeamsAdaptiveCardVerticalBarChart;

export interface TeamsDataVisualizationAdaptiveCard {
  readonly $schema: typeof TEAMS_ADAPTIVE_CARD_SCHEMA;
  readonly body: readonly [TeamsAdaptiveCardChartElement];
  readonly fallbackText: string;
  readonly speak?: string;
  readonly type: "AdaptiveCard";
  readonly version: typeof TEAMS_ADAPTIVE_CARD_VERSION;
}

/** Microsoft Graph `chatMessageAttachment` carrying an Adaptive Card serialized as JSON text. */
export interface TeamsGraphAdaptiveCardAttachment {
  readonly content: string;
  readonly contentType: typeof TEAMS_ADAPTIVE_CARD_CONTENT_TYPE;
  readonly id: string;
}

function axisTitles(spec: SlackDataVisualizationSpec): TeamsAdaptiveCardAxisTitles {
  if (spec.chart.type === "pie") return {};
  const { x_label: xAxisTitle, y_label: yAxisTitle } = spec.chart.axis_config;
  return {
    ...(xAxisTitle ? { xAxisTitle } : {}),
    ...(yAxisTitle ? { yAxisTitle } : {}),
  };
}

/** Plain-text rendering of the chart data for hosts that cannot render chart elements. */
export function teamsDataVisualizationSummary(spec: SlackDataVisualizationSpec): string {
  if (spec.chart.type === "pie") {
    const segments = spec.chart.segments.map((segment) => `${segment.label}: ${segment.value}`);
    return `${spec.title} — ${segments.join(", ")}`;
  }
  const series = spec.chart.series.map(
    (entry) =>
      `${entry.name} (${entry.data.map((point) => `${point.label}: ${point.value}`).join(", ")})`,
  );
  return `${spec.title} — ${series.join("; ")}`;
}

export function teamsAdaptiveCardChartElement(
  spec: SlackDataVisualizationSpec,
): TeamsAdaptiveCardChartElement {
  const fallback: TeamsAdaptiveCardTextBlock = {
    text: teamsDataVisualizationSummary(spec),
    type: "TextBlock",
    wrap: true,
  };
  const chart = spec.chart;
  if (chart.type === "pie") {
    return {
      data: chart.segments.map((segment) => ({ legend: segment.label, value: segment.value })),
      fallback,
      title: spec.title,
      type: "Chart.Pie",
    };
  }
  const [onlySeries] = chart.series;
  if (chart.type === "bar" && chart.series.length === 1 && onlySeries) {
    return {
      ...axisTitles(spec),
      data: onlySeries.data.map((point) => ({ x: point.label, y: point.value })),
      fallback,
      title: spec.title,
      type: "Chart.VerticalBar",
    };
  }
  return {
    ...axisTitles(spec),
    data: chart.series.map((entry) => ({
      legend: entry.name,
      values: entry.data.map((point) => ({ x: point.label, y: point.value })),
    })),
    fallback,
    title: spec.title,
    // Teams has no area chart; area series render as lines over the same categories.
    type: chart.type === "bar" ? "Chart.VerticalBar.Grouped" : "Chart.Line",
  };
}

export function teamsDataVisualizationAdaptiveCard(
  spec: SlackDataVisualizationSpec,
): TeamsDataVisualizationAdaptiveCard {
  const element = teamsAdaptiveCardChartElement(spec);
  return {
    $schema: TEAMS_ADAPTIVE_CARD_SCHEMA,
    body: [element],
    fallbackText: element.fallback.text,
    ...(spec.accessibilityText ? { speak: spec.accessibilityText } : {}),
    type: "AdaptiveCard",
    version: TEAMS_ADAPTIVE_CARD_VERSION,
  };
}

/**
 * Normalizes raw `dataVisualizations` input and renders one Adaptive Card per valid spec.
 * Invalid specs are dropped, matching the Slack Block Kit rendering of the same input.
 */
export function readTeamsDataVisualizationAdaptiveCards(
  value: unknown,
): TeamsDataVisualizationAdaptiveCard[] {
  return normalizeSlackDataVisualizationSpecs(value).map(teamsDataVisualizationAdaptiveCard);
}

/**
 * Wraps a card as a Graph chat message attachment. The id is derived from the card content and
 * position so identical requests produce identical bodies and placeholders stay unique.
 */
export function teamsGraphAdaptiveCardAttachment(
  card: unknown,
  index: number,
): TeamsGraphAdaptiveCardAttachment {
  const content = JSON.stringify(card);
  if (content === undefined)
    throw new TypeError("Adaptive Card content must be JSON serializable.");
  return {
    content,
    contentType: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
    id: createHash("sha256").update(`${index}:${content}`).digest("hex").slice(0, 32),
  };
}
