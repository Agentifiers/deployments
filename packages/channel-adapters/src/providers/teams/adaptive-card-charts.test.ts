import { describe, expect, test } from "bun:test";

import {
  readTeamsDataVisualizationAdaptiveCards,
  teamsGraphAdaptiveCardAttachment,
  TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
} from "./adaptive-card-charts.ts";

const seriesChart = (type: "area" | "bar" | "line", seriesCount = 2) => ({
  chart: {
    axis_config: { categories: ["Mon", "Tue"], x_label: "Day", y_label: "Runs" },
    series: [
      {
        name: "Succeeded",
        // Out-of-order points are realigned to the category order by normalization.
        data: [
          { label: "Tue", value: 7 },
          { label: "Mon", value: 5 },
        ],
      },
      {
        name: "Failed",
        data: [
          { label: "Mon", value: 1 },
          { label: "Tue", value: 0 },
        ],
      },
    ].slice(0, seriesCount),
    type,
  },
  title: "Runs by day",
});

describe("Teams Adaptive Card charts", () => {
  test("renders pie specs as Chart.Pie with a text fallback and spoken accessibility text", () => {
    const [card] = readTeamsDataVisualizationAdaptiveCards([
      {
        accessibilityText: "Most runs succeeded.",
        chart: {
          segments: [
            { label: "Succeeded", value: 9 },
            { label: "Failed", value: 1 },
          ],
          type: "pie",
        },
        title: "Run outcomes",
      },
    ]);
    expect(card).toEqual({
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      body: [
        {
          data: [
            { legend: "Succeeded", value: 9 },
            { legend: "Failed", value: 1 },
          ],
          fallback: {
            text: "Run outcomes — Succeeded: 9, Failed: 1",
            type: "TextBlock",
            wrap: true,
          },
          title: "Run outcomes",
          type: "Chart.Pie",
        },
      ],
      fallbackText: "Run outcomes — Succeeded: 9, Failed: 1",
      speak: "Most runs succeeded.",
      type: "AdaptiveCard",
      version: "1.5",
    });
  });

  test("renders a single bar series as Chart.VerticalBar with axis titles", () => {
    const [card] = readTeamsDataVisualizationAdaptiveCards([seriesChart("bar", 1)]);
    expect(card?.body[0]).toMatchObject({
      data: [
        { x: "Mon", y: 5 },
        { x: "Tue", y: 7 },
      ],
      title: "Runs by day",
      type: "Chart.VerticalBar",
      xAxisTitle: "Day",
      yAxisTitle: "Runs",
    });
    expect(card).not.toHaveProperty("speak");
  });

  test("renders multi-series bars as grouped bars and line or area series as Chart.Line", () => {
    const expectedSeries = [
      {
        legend: "Succeeded",
        values: [
          { x: "Mon", y: 5 },
          { x: "Tue", y: 7 },
        ],
      },
      {
        legend: "Failed",
        values: [
          { x: "Mon", y: 1 },
          { x: "Tue", y: 0 },
        ],
      },
    ];
    const cards = readTeamsDataVisualizationAdaptiveCards([
      seriesChart("bar"),
      seriesChart("line"),
      seriesChart("area"),
    ]);
    expect(cards.map((card) => card.body[0].type)).toEqual([
      "Chart.VerticalBar.Grouped",
      "Chart.Line",
      "Chart.Line",
    ]);
    for (const card of cards) {
      expect(card.body[0]).toMatchObject({
        data: expectedSeries,
        xAxisTitle: "Day",
        yAxisTitle: "Runs",
      });
    }
    expect(cards[0]?.fallbackText).toBe(
      "Runs by day — Succeeded (Mon: 5, Tue: 7); Failed (Mon: 1, Tue: 0)",
    );
  });

  test("drops specs the shared normalizer rejects", () => {
    expect(readTeamsDataVisualizationAdaptiveCards(undefined)).toEqual([]);
    expect(
      readTeamsDataVisualizationAdaptiveCards([
        { chart: { segments: [{ label: "Zero", value: 0 }], type: "pie" }, title: "Empty" },
        {
          chart: {
            axis_config: { categories: ["Mon"] },
            series: [{ data: [{ label: "Tue", value: 1 }], name: "Mismatch" }],
            type: "bar",
          },
          title: "Bad axis",
        },
        { chart: { segments: [{ label: "Ok", value: 1 }], type: "donut" }, title: "Unknown" },
      ]),
    ).toEqual([]);
  });

  test("wraps cards as Graph attachments with JSON string content and stable unique ids", () => {
    const [card] = readTeamsDataVisualizationAdaptiveCards([seriesChart("line")]);
    const first = teamsGraphAdaptiveCardAttachment(card, 0);
    expect(first.contentType).toBe(TEAMS_ADAPTIVE_CARD_CONTENT_TYPE);
    expect(JSON.parse(first.content)).toEqual(card);
    expect(first.id).toMatch(/^[0-9a-f]{32}$/u);
    expect(teamsGraphAdaptiveCardAttachment(card, 0).id).toBe(first.id);
    expect(teamsGraphAdaptiveCardAttachment(card, 1).id).not.toBe(first.id);
  });
});
