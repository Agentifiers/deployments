import { asRecord } from "../../shared/core.ts";
import {
  buildSlackDataVisualizationBlock,
  type SlackDataVisualizationSpec,
} from "./data-visualization.ts";
import { PROVIDER_SLACK_VISUALIZATION_CAPABILITIES } from "./provider-visualization-capabilities.ts";

export interface ProviderSlackVisualizationInput {
  provider?: string;
  toolName?: string;
  value: unknown;
}

export interface ChartRow {
  amount?: number;
  chartLabel?: string;
  clicks?: number;
  conversions?: number;
  count?: number;
  label: string;
  spend?: number;
}

export type SeriesChartType = "area" | "bar" | "line";

export function normalizedProvider(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/-/gu, "_") ?? "";
}

function normalizedToolName(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

const SLACK_VISUALIZATION_TOOL_NAMES_BY_PROVIDER = new Map(
  PROVIDER_SLACK_VISUALIZATION_CAPABILITIES.map((capability) => [
    normalizedProvider(capability.provider),
    new Set(capability.toolNames.map((toolName) => normalizedToolName(toolName))),
  ]),
);

export function supportsProviderToolVisualization(
  provider: string,
  toolName: string | undefined,
): boolean {
  const normalizedTool = normalizedToolName(toolName);
  return Boolean(
    normalizedTool && SLACK_VISUALIZATION_TOOL_NAMES_BY_PROVIDER.get(provider)?.has(normalizedTool),
  );
}

export function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value.trim().replace(/[$,%\s,]+/gu, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readString(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function nestedRecord(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  return asRecord(record?.[key]);
}

export function nestedRecords(value: unknown, keys: readonly string[]): Record<string, unknown>[] {
  return keys.flatMap((key) => recordsAtKey(value, key));
}

function cleanLabel(value: string, fallback: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ") || fallback;
  return normalized.length <= 20 ? normalized : normalized.slice(0, 19).trimEnd();
}

export function uniqueChartRows(rows: readonly ChartRow[], limit: number): ChartRow[] {
  const seen = new Set<string>();
  return rows.slice(0, limit).flatMap((row, index) => {
    const base = cleanLabel(row.label, `Item ${index + 1}`);
    let label = base;
    let suffix = 2;
    while (seen.has(label)) {
      const suffixText = ` ${suffix}`;
      label = `${base.slice(0, Math.max(1, 20 - suffixText.length)).trimEnd()}${suffixText}`;
      suffix += 1;
    }
    seen.add(label);
    return [{ ...row, chartLabel: label }];
  });
}

export function recordsAtKey(value: unknown, key: string, depth = 0): Record<string, unknown>[] {
  if (depth > 5) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => recordsAtKey(item, key, depth + 1));
  }
  const record = asRecord(value);
  if (!record) return [];
  const nested = record[key];
  const direct: Record<string, unknown>[] = Array.isArray(nested)
    ? nested.flatMap((item) => {
        const itemRecord = asRecord(item);
        return itemRecord ? [itemRecord] : [];
      })
    : [];
  return [
    ...direct,
    ...Object.values(record).flatMap((item) => recordsAtKey(item, key, depth + 1)),
  ];
}

export function topRows(
  rows: readonly ChartRow[],
  metricKeys: readonly (keyof ChartRow)[],
): ChartRow[] {
  return rows.toSorted((left, right) => {
    const leftValue = metricKeys.reduce(
      (total, key) => total + ((left[key] as number | undefined) ?? 0),
      0,
    );
    const rightValue = metricKeys.reduce(
      (total, key) => total + ((right[key] as number | undefined) ?? 0),
      0,
    );
    return rightValue - leftValue;
  });
}

export function series(
  rows: readonly ChartRow[],
  key: keyof ChartRow,
  name: string,
): { data: { label: string; value: number }[]; name: string } | undefined {
  if (!rows.some((row) => typeof row[key] === "number")) return undefined;
  return {
    data: rows.map((row) => ({
      label: row.chartLabel ?? row.label,
      value: (row[key] as number | undefined) ?? 0,
    })),
    name,
  };
}

export function performanceSeries(
  rows: readonly ChartRow[],
): NonNullable<ReturnType<typeof series>>[] {
  const volumeSeries = [
    series(rows, "conversions", "Conversions"),
    series(rows, "clicks", "Clicks"),
  ].flatMap((item) => item ?? []);
  if (volumeSeries.length > 0) return volumeSeries;
  return [series(rows, "spend", "Spend")].flatMap((item) => item ?? []);
}

export function performanceYAxis(rows: readonly ChartRow[]): string {
  return rows.some((row) => row.conversions !== undefined || row.clicks !== undefined)
    ? "Volume"
    : "Spend";
}

export function validSpec(
  spec: SlackDataVisualizationSpec | undefined,
): SlackDataVisualizationSpec[] {
  return spec && buildSlackDataVisualizationBlock(spec) ? [spec] : [];
}

export function seriesChartSpec(args: {
  blockId: string;
  chartType: SeriesChartType;
  rows: readonly ChartRow[];
  series: NonNullable<ReturnType<typeof series>>[];
  title: string;
  xLabel: string;
  yLabel: string;
}): SlackDataVisualizationSpec | undefined {
  if (args.rows.length === 0 || args.series.length === 0) return undefined;
  return {
    accessibilityText: `${args.title} chart: ${args.rows
      .slice(0, 4)
      .map((row) => {
        const label = row.chartLabel ?? row.label;
        const value = args.series[0]?.data.find((point) => point.label === label)?.value ?? 0;
        return `${label} ${value}`;
      })
      .join(", ")}.`,
    blockId: args.blockId,
    chart: {
      axis_config: {
        categories: args.rows.map((row) => row.chartLabel ?? row.label),
        x_label: args.xLabel,
        y_label: args.yLabel,
      },
      series: args.series,
      type: args.chartType,
    },
    title: args.title,
  };
}

export function barSpec(
  args: Omit<Parameters<typeof seriesChartSpec>[0], "chartType">,
): SlackDataVisualizationSpec | undefined {
  return seriesChartSpec({ ...args, chartType: "bar" });
}

export function pieSpec(args: {
  blockId: string;
  rows: readonly ChartRow[];
  title: string;
}): SlackDataVisualizationSpec | undefined {
  const segments = args.rows.flatMap((row) => {
    const value = row.count;
    return value !== undefined && value > 0 ? [{ label: row.chartLabel ?? row.label, value }] : [];
  });
  if (segments.length === 0) return undefined;
  return {
    accessibilityText: `${args.title} chart: ${segments
      .slice(0, 4)
      .map((segment) => `${segment.label} ${segment.value}`)
      .join(", ")}.`,
    blockId: args.blockId,
    chart: { segments, type: "pie" },
    title: args.title,
  };
}

export function groupedRows(
  rows: readonly Record<string, unknown>[],
  labelFor: (row: Record<string, unknown>) => string | undefined,
  amountFor?: (row: Record<string, unknown>) => number | undefined,
): ChartRow[] {
  const groups = new Map<string, ChartRow>();
  for (const row of rows) {
    const label = labelFor(row);
    if (!label) continue;
    const current = groups.get(label) ?? { count: 0, label };
    current.count = (current.count ?? 0) + 1;
    const amount = amountFor?.(row);
    if (amount !== undefined) current.amount = (current.amount ?? 0) + amount;
    groups.set(label, current);
  }
  return topRows([...groups.values()], ["amount", "count"]);
}
