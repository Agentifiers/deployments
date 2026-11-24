import { formatCompact, formatDurationMs, formatUsdMicros } from "../observability/format.ts";
import type { MetricRange } from "../observability/range.ts";
import { seriesLabel, seriesUnitLabel, type UsageFormat } from "./catalog.ts";
import type { LedgerSeries, LedgerUsage } from "./ledger.ts";

const NANODOLLARS_PER_USD = 1_000_000_000;
const NANODOLLARS_PER_MICRO = 1_000;
/** Ledger money in exact tables and the CSV: USD to the micro-dollar, the API's billing unit. */
const USD_DECIMALS = 6;
const MS_PER_HOUR = 3_600_000;
const MIB_PER_GIB = 1_024;
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const SIGNIFICANT = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });

/** A ledger figure at a readable scale, for tiles and chart axes. */
export function formatUsage(value: number, format: UsageFormat) {
  switch (format) {
    case "usd":
      return formatUsdMicros(value / NANODOLLARS_PER_MICRO);
    case "duration":
      return formatDurationMs(value);
    case "vcpu-hours":
      return `${SIGNIFICANT.format(value / MS_PER_HOUR)} vCPU-h`;
    case "gib-hours":
      return `${SIGNIFICANT.format(value / (MIB_PER_GIB * MS_PER_HOUR))} GiB-h`;
    case "bytes": {
      let scaled = value;
      let unit = 0;
      while (Math.abs(scaled) >= 1_000 && unit < BYTE_UNITS.length - 1) {
        scaled /= 1_000;
        unit += 1;
      }
      return `${SIGNIFICANT.format(scaled)} ${BYTE_UNITS[unit]}`;
    }
    case "count":
      return formatCompact(value);
  }
}

/** USD with fixed precision from nanodollars; the CSV and the exact table share it. */
export function usdFixed(nanodollars: number) {
  return (nanodollars / NANODOLLARS_PER_USD).toFixed(USD_DECIMALS);
}

/** A value in the series' own ledger unit, exactly as the CSV carries it. */
export function exportValue(series: Pick<LedgerSeries, "kind">, value: number) {
  return series.kind === "cost" ? usdFixed(value) : String(value);
}

export function seriesHeader(series: LedgerSeries) {
  return `${seriesLabel(series)} (${seriesUnitLabel(series)})`;
}

export interface LedgerRow {
  readonly bucket: string;
  readonly values: readonly number[];
}

/**
 * The aggregated rows the table and CSV show: one per bucket that recorded any usage, oldest
 * first, with one value per series in `usage.series` order.
 */
export function ledgerRows(usage: LedgerUsage): LedgerRow[] {
  return usage.buckets.flatMap((bucket, index) => {
    const values = usage.series.map((series) => series.values[index] ?? 0);
    return values.some((value) => value !== 0) ? [{ bucket, values }] : [];
  });
}

function csvField(value: string) {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** RFC 4180 CSV of `ledgerRows` plus a closing total row; bucket starts are UTC ISO timestamps. */
export function ledgerCsv(usage: LedgerUsage): string {
  const lines = [
    ["bucket_start_utc", ...usage.series.map(seriesHeader)],
    ...ledgerRows(usage).map((row) => [
      row.bucket,
      ...row.values.map((value, index) => exportValue(usage.series[index]!, value)),
    ]),
    ["total", ...usage.series.map((series) => exportValue(series, series.total))],
  ];
  return `${lines.map((line) => line.map(csvField).join(",")).join("\r\n")}\r\n`;
}

/** `usage-7d-20260926T1600Z-20261003T1600Z.csv`: the range and its UTC window. */
export function ledgerCsvFilename(range: MetricRange, from: string, to: string) {
  const stamp = (value: string) => value.replaceAll(/[-:]/gu, "").replace(/\d\d\.\d{3}Z$/u, "Z");
  return `usage-${range}-${stamp(from)}-${stamp(to)}.csv`;
}
