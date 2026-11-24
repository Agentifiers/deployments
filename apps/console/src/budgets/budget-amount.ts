export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

const MICROS_PER_USD = 1_000_000n;
/** Commas group thousands before the point and nowhere else, so `250,50` is not read as 25,050. */
const USD_TEXT = /^([1-9]\d{0,2}(?:,\d{3})+|\d+)(?:\.(\d+))?$/u;
const GROUPED = new Intl.NumberFormat("en-US");

export const invalid = (message: string): Parsed<never> => ({ message, ok: false });

/** USD text to integer micros, computed from the digits so no floating-point error creeps in. */
export function parseUsdAmount(text: string): Parsed<number> {
  const amount = text.trim().replace(/^\$/u, "");
  const match = USD_TEXT.exec(amount);
  if (!match) {
    return invalid(
      amount.includes(",")
        ? "Use a period for cents and commas only between thousands, as in 1,000.50"
        : "Enter an amount in US dollars, such as 250 or 0.50",
    );
  }
  const [, grouped = "", fraction = ""] = match;
  const whole = grouped.replaceAll(",", "");
  if (fraction.length > 6) return invalid("Use at most 6 decimal places (one micro-dollar)");
  const micros = BigInt(whole) * MICROS_PER_USD + BigInt(fraction.padEnd(6, "0"));
  if (micros < 1n) return invalid("The amount must be greater than zero");
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) return invalid("The amount is too large");
  return { ok: true, value: Number(micros) };
}

function usdParts(micros: number) {
  const value = BigInt(micros);
  return {
    fraction: (value % MICROS_PER_USD).toString().padStart(6, "0").replace(/0+$/u, ""),
    whole: value / MICROS_PER_USD,
  };
}

/** Exact dollars with 2 to 6 decimals, so a one-micro budget never reads as `$0.00`. */
export function formatBudgetUsd(micros: number): string {
  const { fraction, whole } = usdParts(micros);
  return `$${GROUPED.format(whole)}.${fraction.padEnd(2, "0")}`;
}

/** Exact dollars without grouping, as `parseUsdAmount` reads them back. */
export function usdInputValue(micros: number): string {
  const { fraction, whole } = usdParts(micros);
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

/**
 * Whole percent, floored, with the arithmetic of the refusal detail
 * (`packages/conversations/src/run-admission.ts`), so both name the same percent.
 */
export function percentUsed(spendUsdMicros: number, amountUsdMicros: number): number {
  return Math.floor((spendUsdMicros * 100) / amountUsdMicros);
}
