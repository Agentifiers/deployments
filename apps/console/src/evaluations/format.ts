import { formatDurationMs, formatExact, formatUsdMicros } from "../observability/format.ts";

const SCORE = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 3,
  minimumFractionDigits: 2,
});
const POINTS = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

export type DeltaKind = "count" | "duration" | "points" | "score" | "usd";

const DELTA_FORMATS: Readonly<Record<DeltaKind, (magnitude: number) => string>> = {
  count: formatExact,
  duration: formatDurationMs,
  /** Pass-rate deltas are differences of ratios: percentage points. */
  points: (magnitude) => `${POINTS.format(magnitude * 100)} pp`,
  score: (magnitude) => SCORE.format(magnitude),
  usd: formatUsdMicros,
};

/** A score between 0 and 1; absent values render as an em dash. */
export function formatScore(value: number | undefined) {
  return value === undefined ? "—" : SCORE.format(value);
}

/**
 * A candidate-minus-baseline delta with an explicit sign, so "+" reads as the candidate being
 * higher. Deltas that display as zero stay unsigned; absent deltas render as an em dash.
 */
export function formatDelta(delta: number | undefined, kind: DeltaKind) {
  if (delta === undefined) return "—";
  const format = DELTA_FORMATS[kind];
  const text = format(Math.abs(delta));
  return text === format(0) ? text : `${delta > 0 ? "+" : "−"}${text}`;
}
