/** Months the Usage page offers: the current UTC month and the twelve before it. */
export const SPEND_MONTH_COUNT = 13;

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const MONTH_LABEL = new Intl.DateTimeFormat("en-US", {
  month: "long",
  timeZone: "UTC",
  year: "numeric",
});
const COST_MICROS_SUFFIX = ".cost_usd_micros";

/** The UTC month containing `at`, as `YYYY-MM`. */
export function spendMonthOf(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/** The months the picker offers, newest first. */
export function spendMonths(now: Date): readonly string[] {
  return Array.from({ length: SPEND_MONTH_COUNT }, (_, back) =>
    spendMonthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))),
  );
}

export interface SpendMonthSearch {
  readonly month?: string;
}

/** A month in the URL counts only when the picker offers it; the current month is the default. */
export function parseSpendMonthSearch(
  search: Readonly<Record<string, unknown>>,
  now: Date,
): SpendMonthSearch {
  const { month } = search;
  return typeof month === "string" &&
    MONTH_PATTERN.test(month) &&
    spendMonths(now).slice(1).includes(month)
    ? { month }
    : {};
}

export function spendMonthLabel(month: string): string {
  return MONTH_LABEL.format(new Date(`${month}-01T00:00:00.000Z`));
}

/** `[since, until)` of the month as canonical UTC timestamps. */
export function spendMonthWindow(month: string): {
  readonly since: string;
  readonly until: string;
} {
  const start = new Date(`${month}-01T00:00:00.000Z`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { since: start.toISOString(), until: end.toISOString() };
}

export interface SpendSplit {
  readonly operatorFundedUsdMicros: number;
  readonly organizationFundedUsdMicros: number;
  readonly totalUsdMicros: number;
}

export interface SpendRow extends SpendSplit {
  readonly id: string;
  readonly name: string;
  /** Where the row lives, such as "project / environment" for a workspace. */
  readonly within?: string;
}

/** Rows that spent anything, largest first, and how many spent nothing. */
export function spendingRows<Row extends SpendRow>(
  rows: readonly Row[],
): { readonly idle: number; readonly shown: readonly Row[] } {
  const shown = rows
    .filter((row) => row.totalUsdMicros > 0)
    .toSorted(
      (left, right) =>
        right.totalUsdMicros - left.totalUsdMicros || left.name.localeCompare(right.name),
    );
  return { idle: rows.length - shown.length, shown };
}

/** One hour of one environment's cost for one metered source, summed over its counter shards. */
export interface CostRow {
  readonly environmentId: string;
  readonly hour: string;
  readonly source: string;
  readonly usdMicros: number;
}

/**
 * The cost list's records as one row per environment, hour, and source. Only micro-dollar cost
 * counters count: every costed event carries micros, and the nanodollar counters of the same
 * events are an alternative, not an addend. Records of any other shape are skipped.
 */
export function costRows(
  environmentId: string,
  records: readonly { readonly data: Readonly<Record<string, unknown>>; readonly type: string }[],
): CostRow[] {
  const rows = new Map<string, CostRow>();
  for (const { data, type } of records) {
    const { bucket, metric, quantity } = data;
    if (
      type !== "usage-counter-shard" ||
      typeof bucket !== "string" ||
      typeof metric !== "string" ||
      !metric.endsWith(COST_MICROS_SUFFIX) ||
      typeof quantity !== "number"
    ) {
      continue;
    }
    const source = metric.slice(0, -COST_MICROS_SUFFIX.length);
    const id = `${bucket}\u0000${source}`;
    rows.set(id, {
      environmentId,
      hour: bucket,
      source,
      usdMicros: (rows.get(id)?.usdMicros ?? 0) + quantity,
    });
  }
  return [...rows.values()];
}

export function sortCostRows(rows: readonly CostRow[]): CostRow[] {
  return rows.toSorted(
    (left, right) =>
      left.hour.localeCompare(right.hour) ||
      left.environmentId.localeCompare(right.environmentId) ||
      left.source.localeCompare(right.source),
  );
}

function csvField(value: string) {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** RFC 4180 CSV of the rows, oldest first, with USD to the micro-dollar. */
export function costRowsCsv(
  rows: readonly CostRow[],
  environmentName: (environmentId: string) => string,
): string {
  return [
    ["hour_start_utc", "environment", "environment_id", "source", "cost_usd"],
    ...sortCostRows(rows).map((row) => [
      row.hour,
      environmentName(row.environmentId),
      row.environmentId,
      row.source,
      (row.usdMicros / 1_000_000).toFixed(6),
    ]),
  ]
    .map((line) => line.map(csvField).join(","))
    .join("\r\n")
    .concat("\r\n");
}
