import type { BudgetPeriodKind } from "./contracts.ts";

export interface BudgetPeriodBounds {
  readonly periodEnd: string;
  readonly periodStart: string;
}

const MONTHS_PER_PERIOD: Readonly<Record<Exclude<BudgetPeriodKind, "daily">, number>> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

function startOf(period: BudgetPeriodKind, at: Date) {
  if (period === "daily") {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  }
  const months = MONTHS_PER_PERIOD[period];
  return new Date(Date.UTC(at.getUTCFullYear(), Math.floor(at.getUTCMonth() / months) * months, 1));
}

function advance(period: BudgetPeriodKind, start: Date, count: number) {
  if (period === "daily") {
    return new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + count),
    );
  }
  return new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + MONTHS_PER_PERIOD[period] * count, 1),
  );
}

/** The UTC period of the given kind that contains `at`; the end is exclusive. */
export function budgetPeriodBounds(
  period: BudgetPeriodKind,
  at: Date | string,
): BudgetPeriodBounds {
  const instant = typeof at === "string" ? new Date(at) : at;
  if (!Number.isFinite(instant.getTime())) throw new RangeError("Budget period time is invalid.");
  const start = startOf(period, instant);
  return {
    periodEnd: advance(period, start, 1).toISOString(),
    periodStart: start.toISOString(),
  };
}

/** The period immediately before the one starting at `periodStart`. */
export function previousBudgetPeriod(
  period: BudgetPeriodKind,
  periodStart: string,
): BudgetPeriodBounds {
  const start = new Date(periodStart);
  return {
    periodEnd: periodStart,
    periodStart: advance(period, start, -1).toISOString(),
  };
}
