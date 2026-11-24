import type { MetricInterval } from "./range.ts";

const MICROS_PER_USD = 1_000_000;
const USD = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: "currency",
});
/** Sub-cent amounts keep four decimals so a cheap model call never reads as $0.00. */
const SMALL_USD = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 4,
  minimumFractionDigits: 2,
  style: "currency",
});
const COMPACT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, notation: "compact" });
const EXACT = new Intl.NumberFormat("en-US");
const PERCENT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, style: "percent" });

/** Usage-ledger and analytics costs arrive in micro-dollars. */
export function formatUsdMicros(micros: number) {
  const usd = micros / MICROS_PER_USD;
  return usd !== 0 && Math.abs(usd) < 0.01 ? SMALL_USD.format(usd) : USD.format(usd);
}

/** Abbreviated count (`12.3K`); pair with `formatExact` in a tooltip or title. */
export function formatCompact(value: number) {
  return COMPACT.format(value);
}

export function formatExact(value: number) {
  return EXACT.format(value);
}

export function formatPercent(ratio: number) {
  return PERCENT.format(ratio);
}

/** Rounds once at the displayed precision, so a value never shows `60 s` or `1m 60s`. */
export function formatDurationMs(milliseconds: number) {
  const wholeMs = Math.round(milliseconds);
  if (wholeMs < 1_000) return `${wholeMs} ms`;
  const tenths = Math.round(milliseconds / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)} s`;
  const totalSeconds = Math.round(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/**
 * Bucket labels, all in UTC. Daily buckets are UTC days, so a local rendering would shift them
 * onto the previous evening west of UTC; hourly buckets follow so that switching the interval
 * never changes the zone, and so that a half-hour offset never mislabels an hour. Axis labels
 * leave the zone to the axis title; `full` labels (tooltips, tables) name it.
 */
export function formatBucket(
  bucket: string,
  interval: MetricInterval,
  detail: "axis" | "dated-axis" | "full",
) {
  const date = new Date(bucket);
  if (interval === "day") {
    const day = date.toLocaleDateString("en-US", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
    return detail === "full" ? `${day} (UTC)` : day;
  }
  if (detail === "axis") {
    return date.toLocaleTimeString("en-US", { hour: "numeric", timeZone: "UTC" });
  }
  const label = date.toLocaleString("en-US", {
    day: "numeric",
    hour: "numeric",
    month: "short",
    timeZone: "UTC",
    ...(detail === "full" ? { minute: "2-digit" } : {}),
  });
  return detail === "full" ? `${label} (UTC)` : label;
}
