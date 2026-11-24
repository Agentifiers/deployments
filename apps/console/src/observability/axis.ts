/**
 * Value-axis ticks chosen here instead of by recharts, so the labels can carry the precision the
 * step needs. Recharts' own ticks can land on half-cent steps that a two-decimal USD formatter
 * prints twice (`$0.015` and `$0.02` both read `$0.02`).
 */

/** How a raw series value maps onto the unit its labels show. */
export type AxisUnit =
  | { readonly kind: "duration" }
  | {
      readonly kind: "number";
      /** Whole raw units only: counts and bytes. */
      readonly integer?: boolean;
      /** Displayed units per raw unit, such as `1e-6` for micro-dollars shown in USD. */
      readonly perUnit?: number;
    };

export interface ValueAxis {
  readonly domain: [number, number];
  /** Tick spacing in displayed units (milliseconds for durations). */
  readonly step: number;
  readonly ticks: number[];
}

const TARGET_INTERVALS = 4;
const MS_PER_SECOND = 1_000;
const MS_PER_HOUR = 3_600_000;
/** From a second up, durations step through clock-friendly spans rather than 1-2-5 multiples. */
const DURATION_STEPS_MS = [
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000,
  1_800_000, 3_600_000,
];
/** Absorbs float error, so a maximum that is an exact multiple of the step gets no extra tick. */
const EPSILON = 1e-9;

/** The 1, 2, or 5 × 10ⁿ step at or above `rough`. */
function niceStep(rough: number) {
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / magnitude;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * magnitude;
}

function durationStep(rough: number) {
  if (rough < MS_PER_SECOND) return Math.max(1, niceStep(rough));
  return (
    DURATION_STEPS_MS.find((candidate) => candidate >= rough) ??
    niceStep(rough / MS_PER_HOUR) * MS_PER_HOUR
  );
}

/**
 * Evenly spaced ticks from zero to the first step at or above `max`. Every tick is a small
 * multiple (at most four) of a 1, 2, or 5 × 10ⁿ step, so two significant digits tell them apart.
 */
export function valueAxis(max: number, unit: AxisUnit): ValueAxis {
  const perUnit = unit.kind === "number" ? (unit.perUnit ?? 1) : 1;
  // An empty or all-zero series still gets a readable 0-to-1 axis.
  const top =
    Number.isFinite(max) && max > 0 ? max : unit.kind === "duration" ? 1_000 : 1 / perUnit;
  const rough = (top * perUnit) / TARGET_INTERVALS;
  let step = unit.kind === "duration" ? durationStep(rough) : niceStep(rough);
  if (unit.kind === "number" && unit.integer) step = Math.max(step, perUnit);
  const rawStep = step / perUnit;
  const count = Math.max(1, Math.ceil(top / rawStep - EPSILON));
  const ticks = Array.from({ length: count + 1 }, (_, index) => index * rawStep);
  return { domain: [0, ticks.at(-1)!], step, ticks };
}

/** USD with two decimals, or as many as a sub-cent step needs; whole dollars from a $1 step. */
export function formatUsdTick(usd: number, stepUsd: number) {
  const digits = stepUsd >= 1 ? 0 : Math.max(2, -Math.floor(Math.log10(stepUsd) + EPSILON));
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
    style: "currency",
  }).format(usd);
}
