import { type SlackDataVisualizationSpec } from "./data-visualization.ts";

import { asRecord } from "../../shared/core.ts";
import type { ChartRow } from "./provider-visualization-shared.ts";
import {
  readNumber,
  readString,
  nestedRecord,
  nestedRecords,
  uniqueChartRows,
  recordsAtKey,
  topRows,
  series,
  validSpec,
  barSpec,
  pieSpec,
  groupedRows,
} from "./provider-visualization-shared.ts";

function quickbooksColData(record: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const value = record?.ColData;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const itemRecord = asRecord(item);
    return itemRecord ? [itemRecord] : [];
  });
}

function quickbooksChartRows(value: unknown): ChartRow[] {
  return recordsAtKey(value, "Row").flatMap((row) => {
    const colData = quickbooksColData(row);
    const summaryData = quickbooksColData(nestedRecord(row, "Summary"));
    const cells = colData.length > 1 ? colData : summaryData;
    const label = readString(cells[0], ["value"]);
    const amount = cells.toReversed().flatMap((cell) => {
      const cellValue = readNumber(cell.value);
      return cellValue === undefined ? [] : [cellValue];
    })[0];
    return label && amount !== undefined ? [{ amount, label }] : [];
  });
}

export function quickbooksVisualization(value: unknown): SlackDataVisualizationSpec[] {
  const chartRows = uniqueChartRows(topRows(quickbooksChartRows(value), ["amount"]), 8);
  return validSpec(
    barSpec({
      blockId: "deployments-ai-quickbooks-report",
      rows: chartRows,
      series: [series(chartRows, "amount", "Amount")].flatMap((item) => item ?? []),
      title: "QuickBooks report",
      xLabel: "Row",
      yLabel: "Amount",
    }),
  );
}

export function zendeskVisualization(value: unknown): SlackDataVisualizationSpec[] {
  const rows = groupedRows(nestedRecords(value, ["results", "tickets"]), (row) =>
    readString(row, ["status", "priority", "type"]),
  );
  return validSpec(
    pieSpec({
      blockId: "deployments-ai-zendesk-tickets",
      rows: uniqueChartRows(rows, 8),
      title: "Ticket status",
    }),
  );
}
